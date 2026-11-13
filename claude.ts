// Claude sin Node: el CLI `claude` (nativo, ~/.local/bin/claude.exe) en modo
// stream-json, lanzado con `process.spawn` de NSH. Un proceso por
// conversación: cada `ask` escribe un mensaje de usuario por stdin y lee los
// eventos línea a línea hasta el `result` del turno.
import { spawn, type ChildProcess } from "process";
import { cliModel, writeAll } from "./claude-io";

const SYSTEM = [
  "Eres Maka Tutor, un tutor que enseña a partir de lo que el usuario tiene en pantalla.",
  "Cuando recibas una captura, explica lo relevante paso a paso, en español y con Markdown breve.",
  "No inventes lo que no se ve en la captura.",
].join(" ");

type Pending = {
  onDelta: (text: string) => void;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  streamed: string;
};

export class ClaudeSession {
  private child: ChildProcess | null = null;
  private pending: Pending | null = null;
  private stderr = "";
  /** El modelo con el que se lanza el próximo proceso de `claude`. */
  private model: string;

  private system: string;
  private systemFile: string | null;
  private effort: string | null;

  /** `system` sustituye al prompt del tutor (el modo reunión trae el suyo);
   * `systemFile`, un archivo con el prompt (para prompts largos: la línea de
   * comandos de Windows no pasa de ~32K caracteres);
   * `effort` (`low`…`max`) acorta o alarga lo que piensa el modelo. */
  constructor(model: string, options: { system?: string; systemFile?: string; effort?: string } = {}) {
    this.model = model;
    this.system = options.system ?? SYSTEM;
    this.systemFile = options.systemFile ?? null;
    this.effort = options.effort ?? null;
  }

  /** Hay una pregunta en curso. */
  get busy() {
    return this.pending !== null;
  }

  /** Cambia de modelo: el proceso en curso sigue con el anterior hasta
   * `reset`, la siguiente ya usa este. */
  setModel(model: string) {
    this.model = model;
  }

  /** Pregunta `text`, con capturas JPEG en base64 (en orden); `onDelta`
   * recibe el texto según llega. Resuelve con la respuesta completa. */
  ask(text: string, images: string[], onDelta: (text: string) => void): Promise<string> {
    if (this.pending) return Promise.reject(new Error("Ya hay una pregunta en curso"));
    const child = this.child ?? this.start();
    const content: unknown[] = images.map((data) => ({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data },
    }));
    content.push({ type: "text", text });
    const line = JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
    return new Promise<string>((resolve, reject) => {
      this.pending = { onDelta, resolve, reject, streamed: "" };
      writeAll(child, line).catch((error) => {
        if (this.child !== child || !this.pending) return;
        this.pending = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /** Corta la respuesta en curso y la conversación. */
  reset() {
    const pending = this.pending;
    this.pending = null;
    this.child?.kill();
    this.child = null;
    pending?.reject(new Error("Respuesta detenida."));
  }

  dispose() {
    this.reset();
  }

  private start(): ChildProcess {
    this.stderr = "";
    const child = spawn(
      "claude",
      [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model", cliModel(this.model),
        "--tools", "",
        // Sin CLAUDE.md, reglas, skills, plugins ni MCP del usuario: el
        // contexto baja de ~48k a ~3k tokens por conversación. (`--bare`
        // recortaría más pero exige ANTHROPIC_API_KEY y no usa el OAuth.)
        ...(this.systemFile ? ["--system-prompt-file", this.systemFile] : ["--system-prompt", this.system]),
        ...(this.effort ? ["--effort", this.effort] : []),
        "--setting-sources", "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
      ],
      { stdin: "pipe", lines: true },
    );
    // Un proceso ya reiniciado (`reset`) no toca la pregunta del siguiente.
    child.on("stdout", (line) => {
      if (this.child === child) this.handle(line);
    });
    child.on("stderr", (text) => {
      if (this.child === child) this.stderr = (this.stderr + text + "\n").slice(-4000);
    });
    child.on("exit", (result) => {
      if (this.child !== child) return;
      this.child = null;
      const pending = this.pending;
      this.pending = null;
      if (pending) {
        const why = result.error ?? (this.stderr.trim() || `claude terminó (código ${result.code ?? result.signal})`);
        pending.reject(new Error(why));
      }
    });
    this.child = child;
    return child;
  }

  private handle(line: string) {
    const pending = this.pending;
    if (!pending || !line.startsWith("{")) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "stream_event") {
      const delta = event.event?.delta;
      if (event.event?.type === "content_block_delta" && delta?.type === "text_delta") {
        pending.streamed += delta.text;
        pending.onDelta(delta.text);
      }
    } else if (event.type === "result") {
      this.pending = null;
      if (event.is_error) {
        pending.reject(new Error(event.result || event.subtype || "error de Claude"));
      } else {
        // Sin deltas (versión del CLI sin parciales): la respuesta entera.
        if (!pending.streamed && event.result) pending.onDelta(event.result);
        pending.resolve(pending.streamed || event.result || "");
      }
    }
  }
}

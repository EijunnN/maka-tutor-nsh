// Claude sin Node: el CLI `claude` (nativo, ~/.local/bin/claude.exe) en modo
// stream-json, lanzado con `process.spawn` de NSH. Un proceso por
// conversación: cada `ask` escribe un mensaje de usuario por stdin y lee los
// eventos línea a línea hasta el `result` del turno.
import { spawn, type ChildProcess } from "process";

export const MODEL = "claude-sonnet-5-5";

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

  /** Pregunta `text`, con una captura JPEG en base64 opcional; `onDelta`
   * recibe el texto según llega. Resuelve con la respuesta completa. */
  ask(text: string, imageBase64: string | null, onDelta: (text: string) => void): Promise<string> {
    if (this.pending) return Promise.reject(new Error("Ya hay una pregunta en curso"));
    const child = this.child ?? this.start();
    const content: unknown[] = [];
    if (imageBase64) {
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } });
    }
    content.push({ type: "text", text });
    return new Promise<string>((resolve, reject) => {
      this.pending = { onDelta, resolve, reject, streamed: "" };
      try {
        child.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
      } catch (error) {
        this.pending = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Corta la respuesta en curso y la conversación. */
  reset() {
    this.child?.kill();
    this.child = null;
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
        "--model", MODEL,
        "--tools", "",
        // Sin CLAUDE.md, reglas, skills, plugins ni MCP del usuario: el
        // contexto baja de ~48k a ~3k tokens por conversación. (`--bare`
        // recortaría más pero exige ANTHROPIC_API_KEY y no usa el OAuth.)
        "--system-prompt", SYSTEM,
        "--setting-sources", "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
      ],
      { stdin: "pipe", lines: true },
    );
    child.on("stdout", (line) => this.handle(line));
    child.on("stderr", (text) => {
      this.stderr = (this.stderr + text + "\n").slice(-4000);
    });
    child.on("exit", (result) => {
      if (this.child === child) this.child = null;
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

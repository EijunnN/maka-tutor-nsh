// Lo que `claude.ts` necesita sin depender de NSH (se prueba con bun):
// el nombre del modelo para el CLI y escribir mensajes grandes en su stdin.

/** Lo que `writeAll` usa de un proceso hijo de NSH. */
export type Writable = { write(text: string): void };

/** El nombre para `claude --model`. A `deepseek-flash` se le añade `[1m]`, como
 * en la guía de Claude Code de DeepSeek: si no, el CLI supone una ventana de
 * contexto menor y resume antes de tiempo. Los de Claude ya usan el millón. */
export const cliModel = (id: string) => (id === "deepseek-flash" ? `${id}[1m]` : id);

/** Trozos de stdin: NSH deja esperar como mucho 1 MiB, y varias capturas lo pasan. */
const CHUNK = 256 * 1024;

/** Escribe `text` entero en el stdin de `child` por trozos; si la cola está
 * llena (`ERR_NSH_QUOTA_EXCEEDED`), espera a que `claude` la vacíe. */
export async function writeAll(child: Writable, text: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (let at = 0; at < text.length; ) {
    let end = Math.min(at + CHUNK, text.length);
    // Sin partir un emoji (par sustituto) entre dos trozos.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    try {
      child.write(text.slice(at, end));
      at = end;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ERR_NSH_QUOTA_EXCEEDED" || Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

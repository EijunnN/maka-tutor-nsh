// `writeAll`: el stdin de un proceso de NSH deja esperar como mucho 1 MiB.
// `bun test tests/claude.test.ts`
import { expect, test } from "bun:test";

import { cliModel, writeAll } from "../claude-io";

/** Un stdin que acepta como mucho `limit` caracteres en cola y se vacía con el tiempo. */
function fakeStdin(limit: number) {
  let queued = 0;
  let out = "";
  let refusals = 0;
  const timer = setInterval(() => (queued = 0), 5);
  return {
    write(text: string) {
      if (queued + text.length > limit) {
        refusals++;
        throw Object.assign(new Error("cola llena"), { code: "ERR_NSH_QUOTA_EXCEEDED" });
      }
      queued += text.length;
      out += text;
    },
    done: () => (clearInterval(timer), { out, refusals }),
  };
}

test("escribe un mensaje de varios MiB por trozos, esperando cuando la cola está llena", async () => {
  const stdin = fakeStdin(1024 * 1024);
  const text = "😀" + "x".repeat(3 * 1024 * 1024) + "😀\n";
  await writeAll(stdin, text);
  const { out, refusals } = stdin.done();
  expect(out).toBe(text);
  expect(refusals).toBeGreaterThan(0);
});

test("otros errores no se reintentan", async () => {
  const stdin = { write: () => { throw Object.assign(new Error("roto"), { code: "EPIPE" }); } };
  await expect(writeAll(stdin, "hola")).rejects.toThrow("roto");
});

test("deepseek-flash pide la ventana de 1M; los de Claude no cambian", () => {
  expect(cliModel("deepseek-flash")).toBe("deepseek-flash[1m]");
  expect(cliModel("claude-opus-5-5")).toBe("claude-opus-5-5");
});

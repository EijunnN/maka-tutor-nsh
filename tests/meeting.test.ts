// La lógica de `meeting.ts` sin NSH: `bun test tests/meeting.test.ts`.
// Simula Rust (`Meeting.poll`) y Claude; no prueba la captura ni Deepgram.
import { beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- dobles de NSH, Rust y Claude ---------------------------------------
function signal<T>(value: T) {
  const s = () => value;
  s.set = (next: T) => {
    value = next;
  };
  return s;
}
const storage = new Map<string, string>();
let picked: { file: { name: string; text: () => Promise<string> } }[] = [];
const md = (name: string, text: string) => ({ file: { name, text: async () => text } });
mock.module("nsh", () => ({
  signal,
  Picker: { pickFiles: async () => picked },
  Storage: {
    getItem: async (k: string) => storage.get(k) ?? null,
    setItem: async (k: string, v: string) => void storage.set(k, v),
    removeItem: async (k: string) => void storage.delete(k),
  },
}));

// `process.dataDir` de NSH: el prompt de la reunión se escribe ahí.
const dataDir = mkdtempSync(join(tmpdir(), "maka-meeting-"));
mock.module("process", () => ({ default: { dataDir } }));

let queue: string[] = [];
let status = "listening";
const started: unknown[] = [];
mock.module("maka-tutor-nsh/native", () => ({
  Meeting: {
    start: (...args: unknown[]) => started.push(args),
    stop: () => {},
    poll: () => {
      const messages = queue;
      queue = [];
      return { status, message: status === "listening" ? "Escuchando" : "", level: 0.3, messages, reconnected: false };
    },
  },
}));

const asked: { prompt: string; images: string[]; system: string }[] = [];
let sessionsCreated = 0;
let release: (() => void)[] = [];
/** Lo que Claude responde en la próxima pregunta. */
let reply = "Propuesta";
/** Calentamientos (`WARMUP`) recibidos: se resuelven solos y no cuentan en `asked`. */
let warmups = 0;
mock.module("../claude", () => ({
  ClaudeSession: class {
    constructor(
      public model: string,
      public options: { systemFile: string },
    ) {
      sessionsCreated++;
    }
    ask(prompt: string, images: string[], onDelta: (t: string) => void) {
      if (prompt.startsWith("La reunión aún no ha empezado")) {
        warmups++;
        return Promise.resolve("listo");
      }
      const text = reply;
      asked.push({ prompt, images, system: readFileSync(this.options.systemFile, "utf8") });
      return new Promise<string>((resolve) => {
        release.push(() => {
          onDelta(text);
          resolve(text);
        });
      });
    }
    reset() {}
    dispose() {}
  },
}));

const { MeetingController, Transcript } = await import("../meeting");

/** Lo que dicen los demás: canal 1 (con el micrófono, que va por defecto, el 0 es el usuario). */
const results = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "Results",
    start: Math.random(),
    duration: 1,
    is_final: true,
    channel_index: [1, 2],
    channel: { alternatives: [{ transcript: text }] },
    ...extra,
  });

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  queue = [];
  status = "listening";
  asked.length = 0;
  release = [];
  reply = "Propuesta";
  warmups = 0;
  picked = [];
  storage.clear();
});

test("Transcript junta segmentos hasta speech_final y deduplica", () => {
  const t = new Transcript();
  const seg = { type: "Results", start: 0, duration: 1, is_final: true, channel: { alternatives: [{ transcript: "Hola" }] } };
  expect(t.accept(seg)).toEqual([]);
  expect(t.accept(seg)).toEqual([]); // repetido
  expect(t.accept({ ...seg, is_final: false, start: 1, channel: { alternatives: [{ transcript: "qué tal" }] } })).toEqual([]);
  expect(t.preview).toBe("Hola qué tal");
  expect(t.accept({ ...seg, start: 1, speech_final: true, channel: { alternatives: [{ transcript: "qué tal" }] } })).toEqual([
    { speaker: "v0", text: "Hola qué tal" },
  ]);
  expect(t.preview).toBe("");
  expect(t.accept({ type: "UtteranceEnd" })).toEqual([]);
});

/** Un resultado final de Deepgram con palabras y voces (`diarize`). */
const words = (list: [string, number][], extra: Record<string, unknown> = {}) => ({
  type: "Results",
  start: Math.random(),
  duration: 1,
  is_final: true,
  channel: {
    alternatives: [
      { transcript: list.map(([w]) => w).join(" "), words: list.map(([w, speaker]) => ({ word: w.toLowerCase(), punctuated_word: w, speaker })) },
    ],
  },
  ...extra,
});

test("Transcript parte por voz: cada tramo seguido de la misma voz es una intervención", () => {
  const t = new Transcript();
  expect(t.accept(words([["¿Cuándo", 0], ["sale?", 0], ["Mañana.", 1], ["Vale,", 0], ["gracias.", 0]], { speech_final: true }))).toEqual([
    { speaker: "v0", text: "¿Cuándo sale?" },
    { speaker: "v1", text: "Mañana." },
    { speaker: "v0", text: "Vale, gracias." },
  ]);
});

test("Transcript con micrófono: el canal 0 es «Tú» y cada canal cierra lo suyo", () => {
  const t = new Transcript(true);
  expect(t.accept(words([["Yo", 0], ["lo", 0], ["reviso.", 0]], { channel_index: [0, 2] }))).toEqual([]);
  expect(t.accept(words([["¿Y", 0], ["el", 0], ["precio?", 0]], { channel_index: [1, 2], speech_final: true }))).toEqual([
    { speaker: "v0", text: "¿Y el precio?" },
  ]);
  // El micrófono sigue pendiente hasta su propio fin de frase.
  expect(t.preview).toBe("Yo lo reviso.");
  expect(t.accept({ type: "UtteranceEnd", channel: [0, 2] })).toEqual([{ speaker: "me", text: "Yo lo reviso." }]);
});

test("responde de una en una y junta lo que llega mientras tanto", async () => {
  const m = new MeetingController(() => "claude-sonnet-5-5");
  m.start(null, "es");
  queue.push(results("¿Cuándo sale la versión?", { speech_final: true }));
  await tick(400); // poll + 250 ms de espera
  expect(asked.length).toBe(1);
  expect(asked[0].prompt).toContain("«¿Cuándo sale la versión?»");
  expect(m.turns()[0].status()).toBe("answering");

  // Dos intervenciones mientras responde: se juntan en una pendiente.
  queue.push(results("Y el precio", { speech_final: true }));
  await tick(150);
  queue.push(results("también.", { speech_final: true }));
  await tick(150);
  expect(m.turns().length).toBe(2);
  expect(m.turns()[1].text).toBe("Y el precio también.");
  expect(asked.length).toBe(1);

  release.shift()!();
  await tick(400);
  expect(m.turns()[0].answer()).toBe("Propuesta");
  expect(m.turns()[0].status()).toBe("done");
  // La segunda va sola: el proceso ya conoce la primera.
  expect(asked.length).toBe(2);
  expect(asked[1].prompt).toContain("«Y el precio también.»");
  expect(asked[1].prompt).not.toContain("versión");
  release.shift()!();
  await tick(50);
  m.stop();
});

test("sin respuesta automática espera a «Sugerir respuesta»", async () => {
  const m = new MeetingController(() => "claude-sonnet-5-5");
  m.setAutoAnswer(false);
  m.start(null, "en");
  queue.push(results("Any questions?", { speech_final: true }));
  await tick(400);
  expect(asked.length).toBe(0);
  m.suggest();
  await tick(10);
  expect(asked.length).toBe(1);
  release.shift()!();
  await tick(10);
  m.stop();
});

test("una captura va con su imagen y el contexto entra en el prompt de sistema", async () => {
  const m = new MeetingController(() => "claude-sonnet-5-5");
  m.setContext("Agenda: lanzamiento de la v2");
  m.start(null, "es");
  await tick(150);
  m.submit("", [{ data: "BASE64", width: 10, height: 10, sourceWidth: 1920, sourceHeight: 1080, sourceX: 0, sourceY: 0 }]);
  await tick(10);
  expect(asked[0].images).toEqual(["BASE64"]);
  expect(asked[0].prompt).toContain("captura de la pantalla compartida");
  expect(asked[0].system).toContain("Agenda: lanzamiento de la v2");
  // Con contexto, el proceso lo leyó al empezar a escuchar.
  expect(warmups).toBe(1);
  expect(asked[0].prompt).toContain("El usuario pide tu sugerencia ahora");
  release.shift()!();
  await tick(10);
  m.stop();
});

test("un error de Rust detiene el sondeo y queda visible", async () => {
  const m = new MeetingController(() => "claude-sonnet-5-5");
  m.start(null, "es");
  status = "error";
  await tick(150);
  expect(m.status()).toBe("error");
  expect(m.active).toBe(false);
});

test("los .md adjuntos van al prompt de sistema, se recuerdan y se quitan", async () => {
  const m = new MeetingController(() => "claude-sonnet-5-5");
  picked = [md("producto.md", "# Producto\nPrecio: 20 €/mes"), md("equipo.md", "Ana lleva backend")];
  await m.attachDocs();
  expect(m.docs().map((d) => d.name)).toEqual(["producto.md", "equipo.md"]);
  // Mismo nombre: sustituye.
  picked = [md("producto.md", "Precio: 25 €/mes")];
  await m.attachDocs();
  expect(m.docs().length).toBe(2);
  expect(m.docs().find((d) => d.name === "producto.md")!.text).toBe("Precio: 25 €/mes");
  // En archivos (el Storage tiene cuota), no en el Storage.
  expect(readdirSync(join(dataDir, "meeting", "docs")).sort()).toEqual(["equipo.md", "producto.md"]);
  expect(storage.has("meeting.docs")).toBe(false);

  // Un documento largo (más que la línea de comandos de Windows) llega entero.
  // Un documento grande (3 millones de caracteres) llega entero, sin recortar.
  const big = "Inicio. " + "dato ".repeat(600_000) + "FINAL-DEL-DOCUMENTO";
  picked = [md("largo.md", big)];
  await m.attachDocs();
  m.start(null, "es");
  queue.push(results("¿Cuánto cuesta?", { speech_final: true }));
  await tick(400);
  expect(asked[0].system).toContain('<documento nombre="producto.md">');
  expect(asked[0].system).toContain("Precio: 25 €/mes");
  expect(asked[0].system).toContain("Ana lleva backend");
  expect(asked[0].system).toContain(big);
  release.shift()!();
  await tick(10);
  m.stop();

  // Al reabrir la app se leen de los archivos.
  const again = new MeetingController(() => "claude-sonnet-5-5");
  await tick(50);
  expect(again.docs().map((d) => d.name)).toEqual(["equipo.md", "largo.md", "producto.md"]);
  expect(again.docs().find((d) => d.name === "largo.md")!.text.length).toBe(big.length);

  await m.removeDoc("largo.md");
  await m.removeDoc("equipo.md");
  await m.removeDoc("producto.md");
  expect(readdirSync(join(dataDir, "meeting", "docs"))).toEqual([]);
  expect(m.docs()).toEqual([]);
});

test("los documentos de versiones anteriores pasan del Storage a archivos", async () => {
  storage.set("meeting.docs", JSON.stringify([{ name: "viejo: notas?.md", text: "Agenda antigua" }]));
  const m = new MeetingController(() => "claude-sonnet-5-5");
  await tick(50);
  expect(m.docs()).toEqual([{ name: "viejo: notas?.md", text: "Agenda antigua" }]);
  expect(storage.has("meeting.docs")).toBe(false);
  await m.removeDoc("viejo: notas?.md");
});

test("rechaza archivos que no son .md", async () => {
  const m = new MeetingController(() => "claude-sonnet-5-5");
  picked = [md("foto.png", "")];
  await expect(m.attachDocs()).rejects.toThrow("no es un archivo .md");
  expect(m.docs()).toEqual([]);
});

test("una reunión larga usa un solo proceso y no repite ni salta intervenciones", async () => {
  const m = new MeetingController(() => "claude-sonnet-5-5");
  m.start(null, "es");
  const before = sessionsCreated;
  for (let i = 1; i <= 25; i++) {
    queue.push(results(`Intervención ${i}.`, { speech_final: true }));
    await tick(400);
    expect(asked.length).toBe(i);
    release.shift()!();
    await tick(20);
  }
  expect(sessionsCreated - before).toBe(1);
  // Cada petición lleva solo la intervención nueva, aunque la lista guarde 20.
  for (let i = 1; i <= 25; i++) {
    expect(asked[i - 1].prompt).toContain(`«Intervención ${i}.»`);
    expect(asked[i - 1].prompt).not.toContain(`«Intervención ${i - 1}.»`);
  }
  expect(m.turns().length).toBe(20);
  m.stop();
}, 20_000);

test("varias capturas van juntas, en orden, en una sola intervención", async () => {
  const m = new MeetingController(() => "claude-sonnet-5-5");
  m.start(null, "es");
  await tick(150);
  const shot = (data: string) => ({ data, width: 10, height: 10, sourceWidth: 1920, sourceHeight: 1080, sourceX: 0, sourceY: 0 });
  m.submit("¿Qué cambia entre estas?", [shot("UNO"), shot("DOS"), shot("TRES")]);
  await tick(10);
  expect(asked[0].images).toEqual(["UNO", "DOS", "TRES"]);
  expect(asked[0].prompt).toContain("3 capturas");
  expect(m.turns()[0].shot).toBe("3 capturas · 1920×1080…");
  expect(() => m.submit("", [])).toThrow("al menos una captura");
  release.shift()!();
  await tick(10);
  m.stop();
});

test("con voces y micrófono: «Tú» es contexto, cada voz con su etiqueta y los renombres llegan a Claude", async () => {
  const m = new MeetingController(() => "claude-sonnet-5-5");
  m.start(null, "es");
  expect(started.at(-1)).toEqual([null, "es", true]);
  const msg = (list: [string, number][], channel: number) =>
    JSON.stringify({ ...words(list, { speech_final: true }), channel_index: [channel, 2] });
  // El usuario habla: queda como «Tú», sin pedir respuesta.
  queue.push(msg([["Os", 0], ["paso", 0], ["el", 0], ["informe.", 0]], 0));
  await tick(400);
  expect(asked.length).toBe(0);
  expect(m.turns()[0].speaker).toBe("me");
  expect(m.speakerLabel("me")).toBe("Tú");
  // Dos voces de los demás en la misma frase: dos intervenciones; se responde a la última.
  queue.push(msg([["Gracias.", 0], ["¿Cuánto", 1], ["cuesta?", 1]], 1));
  await tick(400);
  expect(m.turns().map((t) => [t.speaker, t.text])).toEqual([
    ["me", "Os paso el informe."],
    ["v0", "Gracias."],
    ["v1", "¿Cuánto cuesta?"],
  ]);
  expect(asked.length).toBe(1);
  expect(asked[0].prompt).toContain("Tú (el usuario): «Os paso el informe.»");
  expect(asked[0].prompt).toContain("Hablante 1: «Gracias.»");
  expect(asked[0].prompt).toContain("Hablante 2: «¿Cuánto cuesta?»");
  expect(asked[0].prompt).toContain("Responde sobre todo a lo último que dijo Hablante 2.");
  expect(m.turns()[1].status()).toBe("done");
  release.shift()!();
  await tick(50);
  // Renombrar: la etiqueta cambia y Claude recibe la nota en la siguiente petición.
  m.rename("v1", "Ana");
  expect(m.speakerLabel("v1")).toBe("Ana");
  queue.push(msg([["¿Y", 1], ["el", 1], ["plazo?", 1]], 1));
  await tick(400);
  expect(asked[1].prompt).toContain("Nota: la voz que aparecía como «Hablante 2» es Ana.");
  expect(asked[1].prompt).toContain("Ana: «¿Y el plazo?»");
  release.shift()!();
  await tick(50);
  queue.push(msg([["Perfecto.", 1]], 1));
  await tick(400);
  expect(asked[2].prompt).not.toContain("Nota:"); // ya la sabe
  release.shift()!();
  await tick(10);
  m.stop();
});

test("sin micrófono, todo es de los demás y no se pide multichannel", async () => {
  const m = new MeetingController(() => "claude-sonnet-5-5");
  m.setMicrophone(false);
  m.start(null, "en");
  expect(started.at(-1)).toEqual([null, "en", false]);
  queue.push(JSON.stringify(words([["Hi", 0], ["there.", 0]], { speech_final: true })));
  await tick(400);
  expect(m.turns()[0].speaker).toBe("v0");
  expect(asked.length).toBe(1);
  release.shift()!();
  await tick(10);
  m.stop();
  m.setMicrophone(true);
});

test("sin contexto no se calienta; «—» deja la intervención sin sugerencia y quién eres va al prompt", async () => {
  const m = new MeetingController(() => "claude-sonnet-5-5");
  m.setMe("Darwin,   llevo el backend");
  expect(storage.get("meeting.me")).toBe("Darwin, llevo el backend");
  m.start(null, "es");
  reply = "—";
  queue.push(results("Ana, ¿viste el partido?", { speech_final: true }));
  await tick(400);
  expect(warmups).toBe(0);
  expect(asked[0].system).toContain("Darwin, llevo el backend");
  expect(asked[0].prompt).toContain("o «—» si no hay nada para el usuario");
  release.shift()!();
  await tick(10);
  expect(m.turns()[0].answer()).toBe("");
  expect(m.turns()[0].status()).toBe("done");
  m.stop();
});

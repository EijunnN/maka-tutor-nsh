// La lógica de `meeting.ts` sin NSH: `bun test tests/meeting.test.ts`.
// Simula Rust (`Meeting.poll`) y Claude; no prueba la captura ni AssemblyAI.
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

let turnOrder = 0;
/** Un `Turn` cerrado de AssemblyAI, como lo entrega `Meeting.poll` (`who`: de qué conexión). */
const turn = (text: string, extra: Record<string, unknown> = {}, who = "others") => ({
  who,
  msg: { type: "Turn", turn_order: turnOrder++, end_of_turn: true, turn_is_formatted: true, transcript: text, ...extra },
});
/** Lo que dicen los demás, ya como texto (lo que lee `poll`). */
const results = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify(turn(text, { speaker_label: "A", ...extra }));
/** Un turno de los demás con la voz de cada palabra (`speaker_labels`). */
const words = (list: [string, string][], extra: Record<string, unknown> = {}) =>
  turn(list.map(([w]) => w).join(" "), {
    speaker_label: list[0]?.[1],
    words: list.map(([text, speaker]) => ({ text, speaker, word_is_final: true })),
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

test("Transcript: el parcial se ve al momento y el turno sale al cerrarse, una sola vez", () => {
  const t = new Transcript();
  const partial = { who: "others", msg: { type: "Turn", turn_order: 7, end_of_turn: false, transcript: "hola qué" } };
  expect(t.accept(partial)).toEqual([]);
  expect(t.preview).toBe("hola qué");
  const closed = { who: "others", msg: { type: "Turn", turn_order: 7, end_of_turn: true, transcript: "Hola, ¿qué tal?", speaker_label: "B" } };
  expect(t.accept(closed)).toEqual([{ speaker: "v1", text: "Hola, ¿qué tal?" }]);
  expect(t.preview).toBe("");
  expect(t.accept(closed)).toEqual([]); // repetido
  expect(t.accept({ type: "Turn" })).toEqual([]); // sin `who`/`msg`: no es de `poll`
});

test("Transcript parte por voz: quien interrumpe a mitad de turno sale aparte", () => {
  const t = new Transcript();
  expect(t.accept(words([["¿Cuándo", "A"], ["sale?", "A"], ["Mañana.", "B"], ["Vale,", "A"], ["gracias.", "A"]]))).toEqual([
    { speaker: "v0", text: "¿Cuándo sale?" },
    { speaker: "v1", text: "Mañana." },
    { speaker: "v0", text: "Vale, gracias." },
  ]);
});

test("Transcript: una palabra suelta de otra voz entre dos tramos de la misma se queda con ellos", () => {
  const t = new Transcript();
  expect(t.accept(words([["Bueno,", "B"], ["les", "B"], ["cuento", "B"], ["cómo", "A"], ["vamos.", "B"]]))).toEqual([
    { speaker: "v1", text: "Bueno, les cuento cómo vamos." },
  ]);
  // Dos palabras sí son una interrupción.
  expect(t.accept(words([["Vamos", "A"], ["bien.", "A"], ["¿Seguro", "B"], ["que?", "B"], ["Sí.", "A"]]))).toEqual([
    { speaker: "v0", text: "Vamos bien." },
    { speaker: "v1", text: "¿Seguro que?" },
    { speaker: "v0", text: "Sí." },
  ]);
});

test("Transcript: una palabra sin voz aún (PENDING, UNKNOWN) se queda con la de al lado", () => {
  const t = new Transcript();
  expect(t.accept(words([["Sí,", "PENDING"], ["claro.", "B"]], { speaker_label: "B" }))).toEqual([{ speaker: "v1", text: "Sí, claro." }]);
  expect(t.accept(words([["Bien", "A"], ["dicho.", "UNKNOWN"]], { speaker_label: "A" }))).toEqual([{ speaker: "v0", text: "Bien dicho." }]);
  // Un turno corto sin voz: la última que habló.
  expect(t.accept(turn("Ajá.", { speaker_label: "UNKNOWN" }))).toEqual([{ speaker: "v0", text: "Ajá." }]);
});

test("Transcript con micrófono: lo de su conexión es «Tú», con su propio parcial", () => {
  const t = new Transcript();
  expect(t.accept({ who: "me", msg: { type: "Turn", turn_order: 0, end_of_turn: false, transcript: "yo lo" } })).toEqual([]);
  expect(t.accept({ who: "others", msg: { type: "Turn", turn_order: 0, end_of_turn: false, transcript: "y el precio" } })).toEqual([]);
  expect(t.preview).toBe("y el precio · yo lo");
  // Cada conexión numera sus turnos: el 0 de una no tapa el 0 de la otra.
  expect(t.accept(turn("¿Y el precio?", { turn_order: 0, speaker_label: "A" }))).toEqual([{ speaker: "v0", text: "¿Y el precio?" }]);
  expect(t.accept(turn("Yo lo reviso.", { turn_order: 0 }, "me"))).toEqual([{ speaker: "me", text: "Yo lo reviso." }]);
  expect(t.preview).toBe("");
});

test("responde de una en una y junta lo que llega mientras tanto", async () => {
  const m = new MeetingController(() => "claude-sonnet-5-5");
  m.start(null);
  queue.push(results("¿Cuándo sale la versión?"));
  await tick(400); // poll + 250 ms de espera
  expect(asked.length).toBe(1);
  expect(asked[0].prompt).toContain("«¿Cuándo sale la versión?»");
  expect(m.turns()[0].status()).toBe("answering");

  // Dos intervenciones mientras responde: se juntan en una pendiente.
  queue.push(results("Y el precio"));
  await tick(150);
  queue.push(results("también."));
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
  m.start(null);
  queue.push(results("Any questions?"));
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
  m.start(null);
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
  m.start(null);
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
  m.start(null);
  queue.push(results("¿Cuánto cuesta?"));
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
  m.start(null);
  const before = sessionsCreated;
  for (let i = 1; i <= 25; i++) {
    queue.push(results(`Intervención ${i}.`));
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
  m.start(null);
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
  m.start(null);
  expect(started.at(-1)).toEqual([null, true]);
  const msg = (list: [string, string][], who: "me" | "others") =>
    JSON.stringify(who === "me" ? turn(list.map(([w]) => w).join(" "), {}, "me") : words(list));
  // El usuario habla: queda como «Tú», sin pedir respuesta.
  queue.push(msg([["Os", ""], ["paso", ""], ["el", ""], ["informe.", ""]], "me"));
  await tick(400);
  expect(asked.length).toBe(0);
  expect(m.turns()[0].speaker).toBe("me");
  expect(m.speakerLabel("me")).toBe("Tú");
  // Dos voces de los demás en la misma frase: dos intervenciones; se responde a la última.
  queue.push(msg([["Gracias.", "A"], ["¿Cuánto", "B"], ["cuesta?", "B"]], "others"));
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
  queue.push(msg([["¿Y", "B"], ["el", "B"], ["plazo?", "B"]], "others"));
  await tick(400);
  expect(asked[1].prompt).toContain("Nota: la voz que aparecía como «Hablante 2» es Ana.");
  expect(asked[1].prompt).toContain("Ana: «¿Y el plazo?»");
  release.shift()!();
  await tick(50);
  queue.push(msg([["Perfecto.", "B"]], "others"));
  await tick(400);
  expect(asked[2].prompt).not.toContain("Nota:"); // ya la sabe
  release.shift()!();
  await tick(10);
  m.stop();
});

test("sin micrófono, todo es de los demás y Rust abre una sola conexión", async () => {
  const m = new MeetingController(() => "claude-sonnet-5-5");
  m.setMicrophone(false);
  m.start(null);
  expect(started.at(-1)).toEqual([null, false]);
  queue.push(JSON.stringify(words([["Hi", "A"], ["there.", "A"]])));
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
  m.start(null);
  reply = "—";
  queue.push(results("Ana, ¿viste el partido?"));
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

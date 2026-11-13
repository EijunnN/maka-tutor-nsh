// Historial de conversaciones: un JSON por conversación en
// `<dataDir>/conversations`. Las capturas no se guardan (pesan y pueden tener
// datos sensibles): solo su tamaño, como etiqueta.
import process from "process";
import { mkdir, readdir, readFile, unlink, writeFile } from "fs/promises";

export type StoredMessage = { role: "user" | "assistant"; text: string; shot?: string };

export type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
};

const dir = () => {
  if (!process.dataDir) throw new Error("la app no tiene directorio de datos");
  return `${process.dataDir}/conversations`;
};

const file = (id: string) => `${dir()}/${id.replace(/[^a-z0-9-]/gi, "")}.json`;

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Título: la primera pregunta, recortada. */
export const titleOf = (messages: StoredMessage[]) => {
  const first = messages.find((m) => m.role === "user")?.text.trim().replace(/\s+/g, " ") ?? "";
  return first.length > 60 ? `${first.slice(0, 57)}…` : first || "Sin título";
};

export async function save(conversation: Conversation): Promise<void> {
  await mkdir(dir(), { recursive: true });
  await writeFile(file(conversation.id), JSON.stringify(conversation));
}

export async function remove(id: string): Promise<void> {
  await unlink(file(id));
}

/** Todas, la más reciente primero. Las que no se pueden leer se saltan. */
export async function list(): Promise<Conversation[]> {
  let names: string[];
  try {
    names = await readdir(dir());
  } catch {
    return [];
  }
  const all = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          return JSON.parse(await readFile(`${dir()}/${name}`, "utf8")) as Conversation;
        } catch {
          return null;
        }
      }),
  );
  return all.filter((c): c is Conversation => !!c && Array.isArray(c.messages)).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Coincide con el título o con cualquier mensaje, sin distinguir mayúsculas. */
export const matches = (conversation: Conversation, query: string) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    conversation.title.toLowerCase().includes(q) ||
    conversation.messages.some((m) => m.text.toLowerCase().includes(q))
  );
};

/** El contexto de una conversación retomada, para la primera pregunta nueva:
 * el CLI empieza sin memoria, así que se le pasa la transcripción. */
export const transcript = (messages: StoredMessage[]) =>
  messages
    .map((m) => `${m.role === "user" ? "Usuario" : "Maka Tutor"}: ${m.text}`)
    .join("\n\n")
    .slice(-20000);

/** "hace 5 min", "ayer", "12 nov". */
export const when = (time: number) => {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return "ahora";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  if (hours < 48) return "ayer";
  const d = new Date(time);
  const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return `${d.getDate()} ${months[d.getMonth()]}`;
};

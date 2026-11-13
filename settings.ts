// Ajustes: el modelo (en el Storage de NSH), la API key y el gateway (en Rust,
// en el almacén de claves del sistema; aquí solo se ven enmascarados) y el
// arranque con la sesión (también en Rust).
import { Storage } from "nsh";
import { run } from "process";
import { ApiKey, Gateway, Startup } from "maka-tutor-nsh/native";

export type ModelOption = { id: string; label: string; note: string };

export const MODELS: ModelOption[] = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "Equilibrado" },
  { id: "claude-opus-5-5", label: "Opus 5.5", note: "El más capaz" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", note: "El más rápido" },
  { id: "claude-fable-5-2", label: "Fable 5.2", note: "Explicaciones" },
  { id: "deepseek-flash", label: "DeepSeek V4.1 Flash", note: "1017 · necesita el gateway de DeepSeek" },
];

/** DeepSeek por su API compatible con la de Anthropic (api-docs.deepseek.com). */
export const DEEPSEEK = {
  url: "https://api.deepseek.com/anthropic",
  /** Sirve DeepSeek-V4.1-Flash-1017; admite imágenes. */
  model: "deepseek-flash",
};

/** Un modelo que solo existe detrás de un gateway (no en la API de Anthropic). */
export const isGatewayOnlyModel = (id: string) => id.startsWith("deepseek");

export const DEFAULT_MODEL = MODELS[0].id;

const MODEL_KEY = "model";

export const modelLabel = (id: string) => MODELS.find((m) => m.id === id)?.label ?? id;

/** Un modelo escrito a mano (`opus`, `claude-opus-5-5[1m]`, el de un gateway). */
export const isCustomModel = (id: string) => !MODELS.some((m) => m.id === id);

/** Lanza si `id` no puede ser un nombre de modelo para `claude --model`. */
export function validateModel(id: string): string {
  const value = id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:\/\[\]-]{0,99}$/.test(value)) {
    throw new Error("Nombre de modelo no válido (letras, números, . _ - : / [ ]).");
  }
  return value;
}

export async function loadModel(): Promise<string> {
  const stored = await Storage.getItem(MODEL_KEY).catch(() => null);
  if (!stored) return DEFAULT_MODEL;
  try {
    return validateModel(stored);
  } catch {
    return DEFAULT_MODEL;
  }
}

export async function saveModel(id: string): Promise<void> {
  if (id === DEFAULT_MODEL) await Storage.removeItem(MODEL_KEY);
  else await Storage.setItem(MODEL_KEY, id);
}

/** Pone en uso la API key guardada, si hay, y la devuelve enmascarada. */
export function loadApiKey(): string | null {
  return ApiKey.load() ? (ApiKey.hint() ?? null) : null;
}

/** Guarda la key (lanza si no es válida) y devuelve su versión enmascarada. */
export function saveApiKey(value: string): string | null {
  ApiKey.save(value);
  return ApiKey.hint() ?? null;
}

export function clearApiKey(): void {
  ApiKey.clear();
}

/** El gateway guardado (ya en uso desde `loadApiKey`), para mostrarlo. */
export const gatewayHint = (): string | null => Gateway.hint() ?? null;

/** Guarda URL y token (lanza si no son válidos) y devuelve cómo mostrarlo. */
export function saveGateway(url: string, token: string): string | null {
  Gateway.save(url, token);
  return gatewayHint();
}

export function clearGateway(): void {
  Gateway.clear();
}

export const launchAtLogin = () => Startup.enabled();

export function setLaunchAtLogin(enabled: boolean): void {
  Startup.set(enabled);
}

/** La versión del CLI `claude`, o `null` si no está en el PATH. */
export async function claudeVersion(): Promise<string | null> {
  try {
    const out = await run("claude", ["--version"], { timeoutMs: 15000 });
    return out.code === 0 ? out.stdout.trim().split(/\s+/)[0] || null : null;
  } catch {
    return null;
  }
}

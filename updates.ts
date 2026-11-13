// Actualizaciones de la app: las versiones que publica GitHub Actions en los
// Releases de EijunnN/maka-tutor-nsh (nsh.json "updater", manifiesto firmado
// con la clave cuya parte pública va en nsh.json). Comprueba al arrancar y
// cada pocas horas; instalar descarga, reemplaza la app y la reinicia.
import { signal } from "nsh";
import { checkForUpdate, downloadUpdate, installAndRestart, shellInfo, type AppUpdate } from "nsh/updater";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; update: AppUpdate }
  | { kind: "downloading"; update: AppUpdate; progress: number }
  | { kind: "installing"; update: AppUpdate }
  | { kind: "error"; message: string };

export const updateState = signal<UpdateState>({ kind: "idle" });

const HOURS = 6;

/** La versión instalada (null en `nsh run`, donde no se actualiza). */
export function currentVersion(): string | null {
  try {
    return shellInfo().version ?? null;
  } catch {
    return null;
  }
}

/** Busca una versión nueva. `quiet`: sin mostrar errores de red (comprobación de fondo). */
export async function checkUpdates(quiet = false): Promise<void> {
  const state = updateState();
  if (state.kind === "checking" || state.kind === "downloading" || state.kind === "installing") return;
  updateState.set({ kind: "checking" });
  try {
    const update = await checkForUpdate();
    updateState.set(update ? { kind: "available", update } : { kind: "current" });
  } catch (error) {
    updateState.set(quiet ? { kind: "idle" } : { kind: "error", message: errorText(error) });
  }
}

/** Descarga la versión nueva, reemplaza la app y la reinicia. */
export async function installUpdate(): Promise<void> {
  const state = updateState();
  if (state.kind !== "available") return;
  const { update } = state;
  if (!update.canInstall) {
    updateState.set({ kind: "error", message: `No se puede instalar aquí; descárgala desde ${update.url}` });
    return;
  }
  try {
    updateState.set({ kind: "downloading", update, progress: 0 });
    await downloadUpdate(({ received, total }) =>
      updateState.set({ kind: "downloading", update, progress: total ? received / total : 0 }),
    );
    updateState.set({ kind: "installing", update });
    await installAndRestart();
  } catch (error) {
    updateState.set({ kind: "error", message: `No se pudo actualizar: ${errorText(error)}` });
  }
}

/** Comprueba al poco de arrancar y luego cada `HOURS` horas. Devuelve cómo pararlo. */
export function watchUpdates(): () => void {
  const first = setTimeout(() => void checkUpdates(true), 8_000);
  const every = setInterval(() => void checkUpdates(true), HOURS * 3_600_000);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

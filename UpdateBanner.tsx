// Aviso de versión nueva, arriba del panel: «Versión 0.2.0 disponible ·
// Actualizar», el progreso de la descarga y los errores. Sin versión nueva no
// se ve nada.
import { Text, View } from "nsh";
import { Button } from "nsh/base";
import { installUpdate, updateState } from "./updates";

// El cuerpo de un componente corre una sola vez: lo que cambia va en la expresión.
export function UpdateBanner() {
  return <>{["available", "downloading", "installing", "error"].includes(updateState().kind) ? <Banner /> : null}</>;
}

function Banner() {
  return <>{(() => {
  const s = updateState();
  return (
    <View class="mx-3 mb-2 flex-row items-center gap-2 rounded-[14px] bg-[#30D158]/[0.12] px-3 py-2">
      <Text class="text-[13px] text-[#30D158]">⬆</Text>
      <View class="flex-1 gap-0.5">
        <Text class="text-[13px] font-semibold text-white/90">
          {s.kind === "available"
            ? `Versión ${s.update.version} disponible`
            : s.kind === "downloading"
              ? `Descargando ${s.update.version}… ${Math.round(s.progress * 100)} %`
              : s.kind === "installing"
                ? `Instalando ${s.update.version}…`
                : "Actualización"}
        </Text>
        {s.kind === "error" ? <Text class="text-[11px] text-[#FF6961]">{s.message}</Text> : null}
        {s.kind === "available" && s.update.notes ? (
          <Text class="text-[11px] text-white/50">{s.update.notes.split(/\r?\n/).filter(Boolean).slice(0, 2).join(" · ")}</Text>
        ) : null}
        {s.kind === "downloading" ? (
          <View class="h-1 overflow-hidden rounded-full bg-white/10">
            <View class="h-1 rounded-full bg-[#30D158]" style={{ width: `${Math.round(s.progress * 100)}%` }} />
          </View>
        ) : null}
      </View>
      {s.kind === "available" ? (
        <Button onPress={() => void installUpdate()} class="rounded-full bg-[#30D158] px-3 py-1.5 active:opacity-80">
          <Text class="text-[13px] font-semibold text-black">Actualizar</Text>
        </Button>
      ) : null}
      {s.kind === "error" ? (
        <Button onPress={() => updateState.set({ kind: "idle" })} class="rounded-full px-2 py-1 active:bg-white/10">
          <Text class="text-[13px] text-white/50">✕</Text>
        </Button>
      ) : null}
    </View>
  );
  })()}</>;
}

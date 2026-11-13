// Las capturas adjuntas a la próxima pregunta (chat o reunión): una píldora
// por captura con su ✕, y «Quitar todas» cuando hay varias.
import { Scroll, Text, View } from "nsh";
import { Button } from "nsh/base";
import type { Shot } from "maka-tutor-nsh/native";

const pill =
  "flex-row items-center gap-1.5 rounded-full border border-black/5 bg-white/50 px-3 py-1.5 transition-transform duration-150 active:scale-95 dark:border-white/10 dark:bg-white/10";

export function Shots(props: { shots: Shot[]; onRemove: (index: number) => void; onClear: () => void }) {
  if (props.shots.length === 0) return null;
  return (
    <Scroll horizontal class="max-h-9">
      <View class="flex-row items-center gap-1.5 px-1">
        {props.shots.map((shot, index) => (
          <Button onPress={() => props.onRemove(index)} class={pill}>
            <Text class="text-[11px] font-medium text-[#007AFF] dark:text-[#0A84FF]">
              {`📷 ${props.shots.length > 1 ? `${index + 1} · ` : ""}${shot.sourceWidth}×${shot.sourceHeight}`}
            </Text>
            <Text class="text-[11px] text-black/40 dark:text-white/40">✕</Text>
          </Button>
        ))}
        {props.shots.length > 1 ? (
          <Button onPress={props.onClear} class="rounded-full px-2 py-1 active:bg-black/5 dark:active:bg-white/10">
            <Text class="text-[11px] font-medium text-[#FF3B30] dark:text-[#FF453A]">Quitar todas</Text>
          </Button>
        ) : null}
      </View>
    </Scroll>
  );
}

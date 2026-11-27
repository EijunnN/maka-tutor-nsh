// Piezas comunes de la interfaz (siempre oscura, nsh.json "appearance": "dark").
// Un `<Text>` nunca lleva padding: NSH mide mal su alto y corta la última
// línea, que queda tapada por lo que viene debajo. El hueco lo pone una
// `View` alrededor o un margen.
import { Text, View, type JSX } from "nsh";
import { Button, Input, Switch } from "nsh/base";

export const blue = "#0A84FF";
export const green = "#30D158";
export const red = "#FF453A";

/** Una tarjeta: superficie sólida, sin cristal (el cristal tapaba el texto). */
export const card = "overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.06]";
export const row = "flex-row items-center gap-3 px-3.5 py-3";
export const divider = "ml-3.5 h-px bg-white/[0.08]";
export const label = "text-[14px] text-white/90";
export const muted = "text-[12px] leading-4 text-white/50";
/** Un campo de texto que se ve como tal: fondo hundido, borde y placeholder legible. */
export const field =
  "rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-[14px] text-white placeholder:text-white/40 focus:border-[#0A84FF]";

/** Un bloque con título, su tarjeta y una nota debajo (en rojo si es un error). */
export function Section(props: {
  title: string;
  action?: JSX.Element | null;
  note?: string | null;
  error?: string | null;
  plain?: boolean;
  children?: JSX.Element | JSX.Element[];
}) {
  return (
    <View class="gap-1.5">
      <View class="min-h-[20px] flex-row items-center justify-between px-3.5">
        <Text class="text-[12px] font-semibold uppercase tracking-wide text-white/45">{props.title}</Text>
        {props.action ?? null}
      </View>
      {props.plain ? props.children : <View class={card}>{props.children}</View>}
      {props.error || props.note ? (
        <View class="px-3.5">
          <Text class={props.error ? `text-[12px] leading-4 text-[${red}]` : muted}>{props.error || props.note}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function Divider() {
  return <View class={divider} />;
}

/** Botón de texto (en la cabecera de una sección, o «Quitar»). */
export function TextButton(props: { text: string; onPress: () => void; tone?: "blue" | "red"; disabled?: boolean }) {
  return (
    <Button
      onPress={props.onPress}
      disabled={props.disabled}
      class="rounded-full px-2.5 py-1 active:bg-white/10 disabled:opacity-30"
    >
      <Text class={`text-[13px] font-medium ${props.tone === "red" ? `text-[${red}]` : `text-[${blue}]`}`}>{props.text}</Text>
    </Button>
  );
}

/** Botón principal: azul, a lo ancho. */
export function PrimaryButton(props: { text: string; onPress: () => void; disabled?: boolean; tone?: "blue" | "red" }) {
  const color = props.tone === "red" ? red : blue;
  return (
    <Button
      onPress={props.onPress}
      disabled={props.disabled}
      class="items-center rounded-xl py-3 transition-transform duration-150 active:scale-[0.98] disabled:opacity-35"
      style={{ backgroundColor: color }}
    >
      <Text class="text-[15px] font-semibold text-white">{props.text}</Text>
    </Button>
  );
}

/** Un campo de texto suelto. */
export function Field(props: { value: string; onChange: (value: string) => void; placeholder: string; multiline?: boolean; label?: string }) {
  return (
    <Input
      class={props.multiline ? `${field} min-h-[76px] leading-5` : field}
      value={props.value}
      onChange={({ value }) => props.onChange(value)}
      placeholder={props.placeholder}
      accessibilityLabel={props.label ?? props.placeholder}
      multiline={props.multiline}
      autoCorrect={false}
    />
  );
}

/** Un campo con su botón de guardar al lado (claves, modelo propio). */
export function FieldRow(props: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  placeholder: string;
  button?: string;
  masked?: boolean;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <View class="flex-row items-center gap-2 px-3 py-2.5">
      <Input
        class={`flex-1 ${field}`}
        value={props.value}
        onChange={({ value }) => props.onChange(value)}
        onSubmit={props.onSave}
        placeholder={props.placeholder}
        accessibilityLabel={props.label ?? props.placeholder}
        masked={props.masked}
        autoCorrect={false}
        autoCapitalize="none"
      />
      <Button
        onPress={props.onSave}
        disabled={props.disabled || !props.value.trim()}
        class="rounded-xl px-3.5 py-2 transition-transform duration-150 active:scale-95 disabled:opacity-35"
        style={{ backgroundColor: blue }}
      >
        <Text class="text-[13px] font-semibold text-white">{props.button ?? "Guardar"}</Text>
      </Button>
    </View>
  );
}

/** Una fila con título, descripción opcional y algo a la derecha. */
export function Row(props: { title: string; detail?: string | null; children?: JSX.Element | JSX.Element[] | null }) {
  return (
    <View class={row}>
      <View class="flex-1 gap-0.5">
        <Text class={label}>{props.title}</Text>
        {props.detail ? <Text class={muted}>{props.detail}</Text> : null}
      </View>
      {props.children ?? null}
    </View>
  );
}

/** Interruptor con el aspecto de iOS. */
export function Toggle(props: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <Switch
      checked={props.checked}
      onChange={({ checked }) => props.onChange(checked)}
      accessibilityLabel={props.label}
      class="h-[26px] w-[44px]"
      trackClass="h-[26px] w-[44px] rounded-full bg-white/20 transition-colors duration-200 checked:bg-[#34C759]"
      thumbClass="m-[2px] size-[22px] rounded-full bg-white shadow transition-transform duration-200 checked:translate-x-[18px]"
    />
  );
}

/** Una opción de una lista de elección única, con ✓ si es la elegida. */
export function Choice(props: { title: string; detail?: string | null; chosen: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <Button onPress={props.onPress} disabled={props.disabled} class={`${row} active:bg-white/[0.06] disabled:opacity-50`}>
      <View class="flex-1 gap-0.5">
        <Text class={props.chosen ? "text-[14px] font-medium text-white" : label}>{props.title}</Text>
        {props.detail ? <Text class={muted}>{props.detail}</Text> : null}
      </View>
      <View
        class="size-5 items-center justify-center rounded-full border"
        style={{ borderColor: props.chosen ? blue : "rgb(255 255 255 / 0.25)", backgroundColor: props.chosen ? blue : "transparent" }}
      >
        {props.chosen ? <Text class="text-[11px] font-bold text-white">✓</Text> : null}
      </View>
    </Button>
  );
}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

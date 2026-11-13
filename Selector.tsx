// Selector de región: una ventana transparente sobre el monitor capturado.
// Arrastrar recorta, un clic sin arrastrar se queda con la pantalla entera y
// Escape cancela (la ventana se abre con `closeOnEscape`). La imagen no se
// vuelve a capturar: `Screen.crop` recorta la que ya se tomó, así que lo que
// se ve debajo es solo la guía.
import { PanResponder, signal, Text, View } from "nsh";

type Point = { x: number; y: number };
type Size = { width: number; height: number };

/** Región en fracciones (0 a 1) del monitor, o `"full"` para el entero. */
export type Selection = { x: number; y: number; width: number; height: number } | "full";

/** Menos de esto (en puntos) cuenta como un clic, no como un arrastre. */
const MIN_DRAG = 8;

export function Selector(props: { sourceWidth: number; sourceHeight: number; onDone: (selection: Selection) => void }) {
  const size = signal<Size>({ width: 0, height: 0 });
  const start = signal<Point | null>(null);
  const end = signal<Point | null>(null);

  const rect = () => {
    const a = start();
    const b = end();
    if (!a || !b) return null;
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    };
  };
  const dragging = () => {
    const r = rect();
    return !!r && (r.width >= MIN_DRAG || r.height >= MIN_DRAG);
  };

  const finish = () => {
    const r = rect();
    const { width, height } = size();
    start.set(null);
    end.set(null);
    if (!r || !width || !height || (r.width < MIN_DRAG && r.height < MIN_DRAG)) {
      props.onDone("full");
      return;
    }
    props.onDone({ x: r.x / width, y: r.y / height, width: r.width / width, height: r.height / height });
  };

  // Tamaño de la región en píxeles reales del monitor, para la etiqueta.
  const pixels = () => {
    const r = rect();
    const { width, height } = size();
    if (!r || !width) return "";
    return `${Math.round((r.width / width) * props.sourceWidth)} × ${Math.round((r.height / height) * props.sourceHeight)}`;
  };

  // Arrastre con el sistema de gestos (ratón incluido): posiciones en la
  // superficie, que es la ventana entera, así que coinciden con el monitor.
  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponderCapture: () => true,
    onPanResponderGrant: (e) => {
      start.set({ x: e.pageX, y: e.pageY });
      end.set({ x: e.pageX, y: e.pageY });
    },
    onPanResponderMove: (_, g) => {
      const a = start();
      if (a) end.set({ x: a.x + g.dx, y: a.y + g.dy });
    },
    onPanResponderRelease: (_, g) => {
      const a = start();
      if (a) end.set({ x: a.x + g.dx, y: a.y + g.dy });
      finish();
    },
    onPanResponderTerminate: () => {
      start.set(null);
      end.set(null);
    },
  });

  const shade = "absolute bg-black/40";

  return (
    <View
      class="flex-1"
      {...responder.panHandlers}
      onLayout={({ bounds }) => size.set(bounds.size)}
    >
      {dragging() ? (
        <>
          {/* Cuatro bandas oscuras alrededor de la región: la región queda nítida. */}
          <View class={shade} style={{ left: 0, top: 0, right: 0, height: rect()!.y }} />
          <View class={shade} style={{ left: 0, top: rect()!.y + rect()!.height, right: 0, bottom: 0 }} />
          <View class={shade} style={{ left: 0, top: rect()!.y, width: rect()!.x, height: rect()!.height }} />
          <View
            class={shade}
            style={{ left: rect()!.x + rect()!.width, top: rect()!.y, right: 0, height: rect()!.height }}
          />
          <View
            class="absolute rounded-[3px] border-2 border-white"
            style={{
              left: rect()!.x,
              top: rect()!.y,
              width: rect()!.width,
              height: rect()!.height,
              boxShadow: "0 0 0 1px rgb(0 122 255 / 0.9), 0 8px 24px rgb(0 0 0 / 0.35)",
            }}
          />
          <View
            class="absolute rounded-full bg-black/70 px-2 py-0.5"
            style={{ left: rect()!.x, top: Math.max(4, rect()!.y - 26) }}
          >
            <Text class="text-[11px] font-medium text-white">{pixels()}</Text>
          </View>
        </>
      ) : (
        <View class="absolute inset-0 bg-black/25" />
      )}

      {/* Instrucciones, en una píldora de cristal arriba al centro. */}
      <View class="absolute inset-x-0 top-6 items-center pointer-events-none">
        <View
          class="flex-row items-center gap-3 rounded-full border border-white/20 bg-black/55 px-4 py-2"
          style={{ backdropFilter: "blur(20px) saturate(180%)" }}
        >
          <Text class="text-[13px] font-medium text-white">Arrastra para recortar</Text>
          <Text class="text-[12px] text-white/60">Clic: pantalla entera · Esc: cancelar</Text>
        </View>
      </View>
    </View>
  );
}

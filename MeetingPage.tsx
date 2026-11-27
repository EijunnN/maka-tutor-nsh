// Panel de reunión: preparar la escucha (clave de AssemblyAI la primera vez,
// qué app, quién eres y el contexto) y, mientras escucha, la transcripción y
// lo que Maka propone.
import { Scroll, signal, Text, View, type ScrollRef } from "nsh";
import { Button, Input, TextView } from "nsh/base";
import { Meeting, TranscriptionKey, type Shot } from "maka-tutor-nsh/native";
import { LARGE_CONTEXT_CHARS, MAX_SHOTS, ME, type MeetingController, type Source, type Turn } from "./meeting";
import { Shots } from "./Shots";
import {
  card,
  Choice,
  Divider,
  errorText,
  Field,
  FieldRow,
  muted,
  PrimaryButton,
  red,
  Row,
  safe,
  Section,
  TextButton,
  Toggle,
} from "./ui";

type LiveProps = {
  meeting: MeetingController;
  /** Las capturas adjuntas (las mismas que las del chat). */
  shots: () => Shot[];
  onCapture: () => void;
  onRemoveShot: (index: number) => void;
  onClearShots: () => void;
};

export function MeetingPage(props: LiveProps) {
  const m = props.meeting;
  return <View class="flex-1">{m.active ? <Live {...props} /> : <Setup meeting={m} />}</View>;
}

/** El nombre de la app tal como la conoce el usuario. */
const APP_NAMES: [RegExp, string][] = [
  [/teams/i, "Microsoft Teams"],
  [/msedge/i, "Microsoft Edge"],
  [/chrome/i, "Google Chrome"],
  [/brave/i, "Brave"],
  [/firefox/i, "Firefox"],
  [/opera/i, "Opera"],
  [/discord/i, "Discord"],
  [/zoom/i, "Zoom"],
  [/zoho/i, "Zoho"],
];
const appName = (process: string) =>
  APP_NAMES.find(([pattern]) => pattern.test(process))?.[1] ?? process.replace(/\.exe$/i, "");

/** Antes de escuchar. */
function Setup(props: { meeting: MeetingController }) {
  const m = props.meeting;
  const keyHint = signal(safe(() => TranscriptionKey.hint() ?? null, null));
  const keyDraft = signal("");
  const keyError = signal("");
  const sources = signal<Source[]>([]);
  const chosen = signal<number | null>(null); // pid; null = todo el equipo
  const startError = signal("");
  const docError = signal("");

  const refresh = () => {
    try {
      const list = Meeting.sources();
      sources.set(list);
      // Lo que hubiera elegido y siga abierto; si no, Teams o Discord.
      const keep = list.find((s) => s.pid === chosen());
      const call = list.find((s) => /teams|discord/i.test(s.name));
      chosen.set(keep?.pid ?? call?.pid ?? list[0]?.pid ?? null);
    } catch (error) {
      startError.set(errorText(error));
    }
  };
  refresh();

  const saveKey = () => {
    try {
      TranscriptionKey.save(keyDraft());
      keyHint.set(TranscriptionKey.hint() ?? null);
      keyDraft.set("");
      keyError.set("");
    } catch (error) {
      keyError.set(errorText(error));
    }
  };

  const attach = () => {
    docError.set("");
    m.attachDocs().catch((error) => docError.set(errorText(error)));
  };
  const contextChars = () => m.contextText().length;

  const start = () => {
    startError.set("");
    try {
      m.start(sources().find((s) => s.pid === chosen()) ?? null);
    } catch (error) {
      startError.set(errorText(error));
    }
  };

  return (
    <View class="flex-1">
      <Scroll class="flex-1" contentClass="gap-6 px-4 pt-4 pb-4">
        {m.status() === "error" ? (
          <View class="rounded-2xl border border-[#FF453A]/30 bg-[#FF453A]/10 px-3.5 py-3">
            <Text class={`text-[13px] leading-5 text-[${red}]`}>{m.message()}</Text>
          </View>
        ) : null}

        {keyHint() ? null : (
          <Section
            title="Primero, conecta la transcripción"
            error={keyError() || null}
            note="Crea una clave en assemblyai.com (API Keys) y pégala aquí. Se guarda en el almacén de claves del sistema; luego la cambias en Ajustes."
          >
            <FieldRow value={keyDraft()} onChange={keyDraft.set} onSave={saveKey} placeholder="Clave de AssemblyAI" masked />
          </Section>
        )}

        <Section
          title="Qué escuchar"
          action={<TextButton text="Actualizar" onPress={refresh} />}
          note="Solo el audio de esa app: lo que dicen los demás. Un navegador incluye todas sus pestañas."
        >
          {sources().map((source, index) => (
            <View>
              {index > 0 ? <Divider /> : null}
              <Choice
                title={appName(source.name)}
                chosen={chosen() === source.pid}
                onPress={() => chosen.set(source.pid)}
              />
            </View>
          ))}
          {sources().length > 0 ? <Divider /> : null}
          <Choice
            title="Todo el audio del equipo"
            detail="Cualquier app que suene"
            chosen={chosen() === null}
            onPress={() => chosen.set(null)}
          />
        </Section>

        <Section
          title="Tú en la reunión"
          note={m.microphone() ? "Usa auriculares: con altavoces, el micrófono también recoge a los demás." : null}
        >
          <View class="px-3 py-2.5">
            <Field value={m.me()} onChange={(value) => m.setMe(value)} placeholder="Tu nombre y tu papel: «Darwin, backend»" label="Quién eres" />
          </View>
          <Divider />
          <Row title="Incluir mi micrófono" detail="Lo tuyo sale como «Tú»; Maka no te responde">
            <Toggle checked={m.microphone()} onChange={(checked) => m.setMicrophone(checked)} label="Incluir mi micrófono" />
          </Row>
          <Divider />
          <Row title="Sugerir automáticamente" detail="Cuando te preguntan o pueden necesitarte">
            <Toggle checked={m.autoAnswer()} onChange={(checked) => m.setAutoAnswer(checked)} label="Sugerir automáticamente" />
          </Row>
        </Section>

        <Section
          title="Contexto (opcional)"
          action={<TextButton text="Adjuntar .md" onPress={attach} />}
          error={
            docError() ||
            (contextChars() > LARGE_CONTEXT_CHARS
              ? `Son ${contextChars().toLocaleString("es")} caracteres: puede pasar del límite del modelo. Quita algún documento.`
              : null)
          }
          note="Agenda, notas o documentos. Maka los lee al empezar y se recuerdan entre reuniones."
        >
          {m.docs().map((doc) => (
            <View>
              <Row title={`📄 ${doc.name}`} detail={`${doc.text.length.toLocaleString("es")} caracteres`}>
                <TextButton text="Quitar" tone="red" onPress={() => void m.removeDoc(doc.name)} />
              </Row>
              <Divider />
            </View>
          ))}
          <View class="px-3 py-2.5">
            <Field
              value={m.context()}
              onChange={(value) => m.setContext(value)}
              placeholder="Pega la agenda o datos que Maka debe conocer…"
              label="Notas de la reunión"
              multiline
            />
          </View>
        </Section>
      </Scroll>

      {/* Siempre a la vista, sin desplazarse. */}
      <View class="gap-2 border-t border-white/[0.08] px-4 pt-3 pb-4">
        {startError() ? (
          <Text class={`text-[12px] leading-4 text-[${red}]`}>{startError()}</Text>
        ) : null}
        <PrimaryButton
          text={keyHint() ? "Empezar a escuchar" : "Guarda la clave para empezar"}
          onPress={start}
          disabled={!keyHint()}
        />
      </View>
    </View>
  );
}

/** Escuchando. */
function Live(props: LiveProps) {
  const m = props.meeting;
  const question = signal("");
  const sendError = signal("");
  const pending = () => m.turns().some((t) => t.status() === "pending");
  /** La voz que se está renombrando (cuadro sobre la barra inferior). */
  const renaming = signal<string | null>(null);

  // La lista sigue a lo último mientras estás abajo; si subes a leer, no te mueve.
  let scroller: ScrollRef | undefined;
  let viewport = 0;
  let atEnd = true;
  const follow = (contentHeight: number) => {
    if (atEnd && scroller) scroller.scrollTo({ y: Math.max(0, contentHeight - viewport), animated: true });
  };

  const send = () => {
    const shots = props.shots();
    if (shots.length === 0) return;
    try {
      m.submit(question(), shots);
      question.set("");
      sendError.set("");
      props.onClearShots();
      atEnd = true;
    } catch (error) {
      sendError.set(errorText(error));
    }
  };

  const listening = () => m.status() === "listening";

  return (
    <View class="flex-1">
      {/* Estado */}
      <View class="px-4 pt-3 pb-2">
        <View class={`${card} flex-row items-center gap-3 px-3.5 py-2.5`}>
          <View
            class="size-2.5 rounded-full"
            style={{
              backgroundColor: listening() ? "#FF453A" : "#FF9F0A",
              boxShadow: listening() ? "0 0 0 3px rgb(255 69 58 / 0.25)" : "none",
            }}
          />
          <View class="flex-1 gap-1">
            <Text class="text-[13px] font-medium text-white/90">{m.message() || "Escuchando"}</Text>
            <View class="h-1 overflow-hidden rounded-full bg-white/10">
              <View class="h-1 rounded-full bg-[#34C759] transition-all duration-100" style={{ width: `${Math.round(m.level() * 100)}%` }} />
            </View>
            <Text class={`line-clamp-1 ${muted}`}>
              {m.docs().length ? `${m.source()} · ${m.docs().length} documento${m.docs().length > 1 ? "s" : ""}` : m.source()}
            </Text>
          </View>
          <Button
            onPress={() => m.stop()}
            class="rounded-xl bg-[#FF453A] px-3 py-1.5 transition-transform duration-150 active:scale-95"
          >
            <Text class="text-[13px] font-semibold text-white">Detener</Text>
          </Button>
        </View>
        <View class="flex-row items-center gap-2 px-1 pt-2">
          <Text class={`flex-1 ${muted}`}>Sugerir automáticamente</Text>
          <Toggle checked={m.autoAnswer()} onChange={(checked) => m.setAutoAnswer(checked)} label="Sugerir automáticamente" />
        </View>
      </View>

      {/* Intervenciones */}
      <Scroll
        class="flex-1"
        ref={(node) => (scroller = node)}
        onLayout={({ bounds }) => (viewport = bounds.size.height)}
        onScroll={({ offset, size, contentSize }) => (atEnd = offset.y + size.height >= contentSize.height - 48)}
        scrollEventThrottle={50}
      >
        <View class="gap-4 px-4 pb-3" onLayout={({ bounds }) => follow(bounds.size.height)}>
          {m.turns().length === 0 && !m.interim() ? (
            <View class="items-center gap-1 px-6 pt-10">
              <Text class="text-[14px] font-medium text-white/70">Escuchando la reunión</Text>
              <Text class="text-center text-[13px] leading-5 text-white/45">
                Lo que digan aparecerá aquí, separado por persona. Toca un nombre para cambiarlo.
              </Text>
            </View>
          ) : null}
          <Each of={m.turns()}>
            {(turn) => (
              <View class="gap-2">
                {turn().speaker === ME || !turn().speaker ? (
                  // Lo tuyo (tu voz o tus capturas): a la derecha, burbuja azul tenue.
                  <View class="max-w-[82%] gap-1 self-end">
                    <Text class="mx-1 self-end text-[11px] font-medium text-white/40">
                      {turn().speaker === ME ? "Tú" : "Tú · captura"}
                    </Text>
                    <View class="rounded-[18px] bg-[#0A84FF]/25 px-3.5 py-2">
                      {turn().shot ? <Text class="text-[11px] font-medium text-white/60">{`📷 ${turn().shot}`}</Text> : null}
                      <Text class="text-[14px] leading-5 text-white/95">{turn().text}</Text>
                    </View>
                  </View>
                ) : (
                  // Un participante: avatar con su inicial y su color, nombre y burbuja gris.
                  <View class="flex-row gap-2 self-stretch pr-10">
                    <Avatar meeting={m} speaker={turn().speaker!} />
                    <View class="flex-1 items-start gap-1">
                      <SpeakerName meeting={m} speaker={turn().speaker!} onRename={(speaker) => renaming.set(speaker)} />
                      <View class="rounded-[18px] bg-white/[0.08] px-3.5 py-2">
                        <Text class="text-[14px] leading-5 text-white/90">{turn().text}</Text>
                      </View>
                    </View>
                  </View>
                )}
                {turn().answer() || turn().status() === "answering" ? <Suggestion turn={turn()} /> : null}
              </View>
            )}
          </Each>
          {m.interim() ? (
            <View class="max-w-[90%] gap-1 self-start pl-9">
              <Text class="mx-1 text-[11px] text-white/35">escuchando…</Text>
              <Text class="mx-1 text-[13px] italic leading-5 text-white/55">{m.interim()}</Text>
            </View>
          ) : null}
        </View>
      </Scroll>

      {/* Renombrar, sugerir y capturas */}
      <View class="gap-2 px-3 pb-3">
        {renaming() ? <RenameBox meeting={m} speaker={renaming()!} onClose={() => renaming.set(null)} /> : null}
        {!renaming() && !m.autoAnswer() && pending() ? (
          // Pedirle a Maka: en su verde, no en el azul de lo tuyo.
          <Button
            onPress={() => m.suggest()}
            class="flex-row items-center justify-center gap-1.5 rounded-xl bg-[#30D158]/15 py-2.5 transition-transform duration-150 active:scale-[0.98]"
          >
            <Text class="text-[13px] font-bold text-[#30D158]">✦</Text>
            <Text class="text-[14px] font-semibold text-[#30D158]">Que Maka sugiera qué decir</Text>
          </Button>
        ) : null}
        {sendError() ? <Text class={`mx-1 text-[12px] text-[${red}]`}>{sendError()}</Text> : null}
        <Shots shots={props.shots()} onRemove={props.onRemoveShot} onClear={props.onClearShots} />
        <View class="flex-row items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.07] p-1.5">
          <Button
            onPress={props.onCapture}
            disabled={props.shots().length >= MAX_SHOTS}
            accessibilityLabel="Capturar la pantalla"
            class="size-8 items-center justify-center rounded-xl bg-white/10 transition-transform duration-150 active:scale-90 disabled:opacity-30"
          >
            <Text class="text-sm">{props.shots().length ? "＋" : "📷"}</Text>
          </Button>
          <Input
            class="flex-1 bg-transparent text-[14px] text-white placeholder:text-white/40"
            value={question()}
            onChange={({ value }) => question.set(value)}
            onSubmit={send}
            placeholder={
              props.shots().length > 1
                ? `Pregunta sobre las ${props.shots().length} capturas…`
                : props.shots().length
                  ? "Pregunta sobre la captura (＋ añade otra)…"
                  : "Captura lo que comparten para analizarlo"
            }
          />
          <Button
            onPress={send}
            disabled={props.shots().length === 0}
            accessibilityLabel="Enviar"
            class="size-8 items-center justify-center rounded-xl bg-[#0A84FF] transition-transform duration-150 active:scale-90 disabled:opacity-30"
          >
            <Text class="text-[15px] font-bold text-white">↑</Text>
          </Button>
        </View>
      </View>
    </View>
  );
}

/** Un color fijo por voz (Hablante 1 siempre el mismo), distinto del azul
 * del usuario y del verde de Maka. */
const VOICE_COLORS = ["#FF9F0A", "#BF5AF2", "#FF6482", "#64D2FF", "#FFD60A", "#AC8E68", "#FF453A", "#5E5CE6"];
export const voiceColor = (speaker: string) => VOICE_COLORS[(Number(speaker.slice(1)) || 0) % VOICE_COLORS.length];

/** El nombre de una voz con su color; al pulsarlo se abre el cuadro para
 * renombrarla (abajo, fuera de la lista: un campo de texto dentro de la lista
 * se dibujaba detrás de la barra inferior). */
function SpeakerName(props: { meeting: MeetingController; speaker: string; onRename: (speaker: string) => void }) {
  return (
    <Button
      onPress={() => props.onRename(props.speaker)}
      class="flex-row items-center gap-1 self-start rounded-full px-1 active:bg-white/10"
    >
      <Text class="text-[12px] font-semibold" style={{ color: voiceColor(props.speaker) }}>
        {props.meeting.speakerLabel(props.speaker)}
      </Text>
      <Text class="text-[10px] text-white/30">✎</Text>
    </Button>
  );
}

/** El cuadro para renombrar una voz, encima de la barra inferior. */
function RenameBox(props: { meeting: MeetingController; speaker: string; onClose: () => void }) {
  const m = props.meeting;
  const draft = signal(m.names()[props.speaker] ?? "");
  const save = () => {
    m.rename(props.speaker, draft());
    props.onClose();
  };
  return (
    <View class="gap-2 rounded-2xl border border-white/10 bg-white/[0.08] px-3 py-2.5">
      <Text class="mx-1 text-[12px] text-white/60">
        {`¿Cómo se llama `}
        <Text style={{ color: voiceColor(props.speaker) }}>{m.speakerLabel(props.speaker)}</Text>
        {"? Vacío: vuelve a su número."}
      </Text>
      <View class="flex-row items-center gap-2">
        <Avatar meeting={m} speaker={props.speaker} inline />
        <Input
          class="flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-1.5 text-[14px] text-white placeholder:text-white/40"
          value={draft()}
          onChange={({ value }) => draft.set(value)}
          onSubmit={save}
          placeholder="Nombre (p. ej. Erick)"
          accessibilityLabel={`Nombre de ${m.speakerLabel(props.speaker)}`}
          autoFocus
        />
        <Button onPress={props.onClose} class="rounded-xl px-2.5 py-1.5 active:bg-white/10">
          <Text class="text-[13px] text-white/60">Cancelar</Text>
        </Button>
        <Button onPress={save} class="rounded-xl bg-[#0A84FF] px-3 py-1.5 active:scale-95">
          <Text class="text-[13px] font-semibold text-white">Guardar</Text>
        </Button>
      </View>
    </View>
  );
}

/** La inicial de la voz en un círculo de su color (sin nombre: el número). */
function Avatar(props: { meeting: MeetingController; speaker: string; inline?: boolean }) {
  const label = () => props.meeting.speakerLabel(props.speaker);
  const initial = () => {
    const name = props.meeting.names()[props.speaker];
    return name ? name.charAt(0).toUpperCase() : label().replace(/\D/g, "") || "?";
  };
  return (
    <View
      class={`${props.inline ? "" : "mt-[18px] "}size-7 items-center justify-center rounded-full`}
      style={{ backgroundColor: `${voiceColor(props.speaker)}33` }}
    >
      <Text class="text-[12px] font-bold" style={{ color: voiceColor(props.speaker) }}>
        {initial()}
      </Text>
    </View>
  );
}

/** Lo que Maka propone decir: su propio avatar y una superficie con un tinte
 * verde suave, sin bordes ni barras, para no confundirlo con las personas. */
function Suggestion(props: { turn: Turn }) {
  const error = () => props.turn.status() === "error";
  const thinking = () => props.turn.status() === "answering" && !props.turn.answer();
  return (
    <View class="flex-row gap-2 self-stretch">
      <View class={`size-7 items-center justify-center rounded-full ${error() ? "bg-[#FF453A]/20" : "bg-[#30D158]/20"}`}>
        <Text class={`text-[13px] font-bold ${error() ? "text-[#FF6961]" : "text-[#30D158]"}`}>✦</Text>
      </View>
      <View class="flex-1 gap-1">
        <Text class={`mx-1 text-[12px] font-semibold ${error() ? "text-[#FF6961]" : "text-[#30D158]"}`}>
          {error() ? "Maka no pudo responder" : thinking() ? "Maka está pensando…" : "Maka sugiere"}
        </Text>
        {props.turn.answer() ? (
          <View class={`rounded-[18px] px-3.5 py-2.5 ${error() ? "bg-[#FF453A]/10" : "bg-[#30D158]/[0.09]"}`}>
            <TextView markdown={props.turn.answer()} options={{ streaming: true }} selectable />
          </View>
        ) : null}
      </View>
    </View>
  );
}

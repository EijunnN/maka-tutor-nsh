// Panel de reunión: preparar la escucha (clave de Deepgram, app, idioma,
// contexto) y, mientras escucha, la transcripción y lo que Claude propone.
import { Scroll, signal, Text, View } from "nsh";
import { Button, Input, Switch, TextView } from "nsh/base";
import { DeepgramKey, Meeting, type Shot } from "maka-tutor-nsh/native";
import { LARGE_CONTEXT_CHARS, MAX_SHOTS, ME, type Language, type MeetingController, type Source, type Turn } from "./meeting";
import { Shots } from "./Shots";

const glass = { glassEffect: "regular", backdropFilter: "blur(24px) saturate(180%)" } as const;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const group =
  "overflow-hidden rounded-2xl border border-white/50 bg-white/55 dark:border-white/10 dark:bg-white/[0.07]";
const row = "flex-row items-center gap-3 px-3.5 py-2.5";
const divider = "ml-3.5 h-px bg-black/5 dark:bg-white/10";
const label = "text-[14px] text-black/85 dark:text-white/90";
const muted = "text-[11px] text-black/45 dark:text-white/45";
const caption = "px-3.5 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-black/40 dark:text-white/40";
const footer = "px-3.5 pt-1.5 text-[11px] leading-4 text-black/45 dark:text-white/45";
const blue = "text-[#007AFF] dark:text-[#0A84FF]";
const red = "text-[#FF3B30] dark:text-[#FF453A]";
const switchProps = {
  class: "h-[26px] w-[44px]",
  trackClass:
    "h-[26px] w-[44px] rounded-full bg-black/15 transition-colors duration-200 checked:bg-[#34C759] dark:bg-white/20",
  thumbClass:
    "m-[2px] size-[22px] rounded-full bg-white shadow transition-transform duration-200 checked:translate-x-[18px]",
};

const LANGUAGES: { id: Language; label: string }[] = [
  { id: "es", label: "Español" },
  { id: "en", label: "English" },
  { id: "multi", label: "Varios" },
];

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

/** Antes de escuchar. */
function Setup(props: { meeting: MeetingController }) {
  const m = props.meeting;
  const keyHint = signal(safe(() => DeepgramKey.hint() ?? null, null));
  const keyDraft = signal("");
  const keyError = signal("");
  const sources = signal<Source[]>([]);
  const chosen = signal<number | null>(null); // pid; null = todo el equipo
  const language = signal<Language>("es");
  const startError = signal("");
  const docError = signal("");

  const attach = () => {
    docError.set("");
    m.attachDocs().catch((error) => docError.set(errorText(error)));
  };
  const contextChars = () => m.contextText().length;

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
      DeepgramKey.save(keyDraft());
      keyHint.set(DeepgramKey.hint() ?? null);
      keyDraft.set("");
      keyError.set("");
    } catch (error) {
      keyError.set(errorText(error));
    }
  };

  const clearKey = () => {
    try {
      DeepgramKey.clear();
      keyHint.set(null);
    } catch (error) {
      keyError.set(errorText(error));
    }
  };

  const start = () => {
    startError.set("");
    try {
      const source = sources().find((s) => s.pid === chosen()) ?? null;
      m.start(source, language());
    } catch (error) {
      startError.set(errorText(error));
    }
  };

  const option = () => `${row} active:bg-black/5 dark:active:bg-white/10`;

  return (
    <Scroll class="flex-1">
      <View class="gap-5 px-4 py-4">
        {m.status() === "error" ? (
          <View class="rounded-2xl border border-[#FF3B30]/30 bg-[#FF3B30]/10 px-3.5 py-2.5">
            <Text class={`text-[13px] ${red}`}>{m.message()}</Text>
          </View>
        ) : null}

        {/* Clave de Deepgram */}
        <View>
          <Text class={caption}>Transcripción (Deepgram)</Text>
          <View class={group} style={glass}>
            {keyHint() ? (
              <View class={row}>
                <View class="flex-1 gap-0.5">
                  <Text class={label}>Clave guardada</Text>
                  <Text class={muted}>{keyHint()!}</Text>
                </View>
                <Button onPress={clearKey} class="rounded-full px-3 py-1 active:bg-black/5 dark:active:bg-white/10">
                  <Text class={`text-[13px] font-medium ${red}`}>Quitar</Text>
                </Button>
              </View>
            ) : (
              <View class={row}>
                <Input
                  class="flex-1 bg-transparent text-[14px] text-black/90 dark:text-white/95"
                  value={keyDraft()}
                  onChange={({ value }) => keyDraft.set(value)}
                  onSubmit={saveKey}
                  placeholder="Clave API de Deepgram"
                  masked
                />
                <Button
                  onPress={saveKey}
                  disabled={!keyDraft().trim()}
                  class="rounded-full bg-[#007AFF] px-3 py-1 transition-transform duration-150 active:scale-95 disabled:opacity-30 dark:bg-[#0A84FF]"
                >
                  <Text class="text-[13px] font-medium text-white">Guardar</Text>
                </Button>
              </View>
            )}
          </View>
          <Text class={keyError() ? `${footer} ${red}` : footer}>
            {keyError() ||
              "Se guarda en el almacén de claves del sistema (Windows: Administrador de credenciales; Linux: llavero) y solo la usa la captura. Las respuestas las genera Claude con el modelo de Ajustes."}
          </Text>
        </View>

        {/* Fuente */}
        <View>
          <View class="flex-row items-center justify-between pr-1">
            <Text class={caption}>Qué escuchar</Text>
            <Button onPress={refresh} class="rounded-full px-2 py-0.5 active:bg-black/5 dark:active:bg-white/10">
              <Text class={`text-[12px] font-medium ${blue}`}>Actualizar</Text>
            </Button>
          </View>
          <View class={group} style={glass}>
            {sources().map((source, index) => (
              <View>
                {index > 0 ? <View class={divider} /> : null}
                <Button onPress={() => chosen.set(source.pid)} class={option()}>
                  <View class="flex-1 gap-0.5">
                    <Text class={label}>{source.name.replace(/\.exe$/i, "")}</Text>
                    <Text class={muted}>{`Proceso ${source.pid} y sus hijos`}</Text>
                  </View>
                  {chosen() === source.pid ? <Text class={`text-[15px] font-semibold ${blue}`}>✓</Text> : null}
                </Button>
              </View>
            ))}
            {sources().length > 0 ? <View class={divider} /> : null}
            <Button onPress={() => chosen.set(null)} class={option()}>
              <View class="flex-1 gap-0.5">
                <Text class={label}>Todo el audio del equipo</Text>
                <Text class={muted}>Incluye cualquier otra app que suene</Text>
              </View>
              {chosen() === null ? <Text class={`text-[15px] font-semibold ${blue}`}>✓</Text> : null}
            </Button>
          </View>
          <Text class={footer}>
            Solo el audio que reproduce esa app (los demás participantes); un navegador incluye todas sus pestañas.
            Deepgram distingue las voces («Hablante 1», «Hablante 2»…): toca un nombre durante la reunión para cambiarlo.
          </Text>
        </View>

        {/* Idioma y respuestas */}
        <View>
          <Text class={caption}>Idioma y respuestas</Text>
          <View class={group} style={glass}>
            <View class={`${row} gap-1.5`}>
              {LANGUAGES.map((l) => (
                <Button
                  onPress={() => language.set(l.id)}
                  class={`flex-1 items-center rounded-full py-1.5 ${language() === l.id ? "bg-[#007AFF] dark:bg-[#0A84FF]" : "bg-black/5 dark:bg-white/10"}`}
                >
                  <Text class={`text-[13px] font-medium ${language() === l.id ? "text-white" : "text-black/70 dark:text-white/75"}`}>
                    {l.label}
                  </Text>
                </Button>
              ))}
            </View>
            <View class={divider} />
            <View class={row}>
              <View class="flex-1 gap-0.5">
                <Text class={label}>Responder automáticamente</Text>
                <Text class={muted}>Tras cada intervención; si no, «Sugerir respuesta»</Text>
              </View>
              <Switch {...switchProps} checked={m.autoAnswer()} onChange={({ checked }) => m.setAutoAnswer(checked)} />
            </View>
            <View class={divider} />
            <View class={row}>
              <View class="flex-1 gap-0.5">
                <Text class={label}>Incluir mi micrófono</Text>
                <Text class={muted}>Lo que dices sale como «Tú»: Maka no te responde a ti y no repite lo que ya dijiste</Text>
              </View>
              <Switch {...switchProps} checked={m.microphone()} onChange={({ checked }) => m.setMicrophone(checked)} />
            </View>
          </View>
          {m.microphone() ? (
            <Text class={footer}>
              Usa auriculares: con altavoces el micrófono también recoge a los demás y sus palabras saldrían como tuyas.
            </Text>
          ) : null}
        </View>

        {/* Quién eres */}
        <View>
          <Text class={caption}>Quién eres en la reunión</Text>
          <View class={`${group} px-3.5 py-2.5`} style={glass}>
            <Input
              class="bg-transparent text-[13px] leading-5 text-black/85 dark:text-white/90"
              value={m.me()}
              onChange={({ value }) => m.setMe(value)}
              placeholder="Tu nombre y tu papel: «Darwin, llevo el backend»"
            />
          </View>
          <Text class={footer}>
            Con esto Maka sabe cuándo te preguntan a ti. Si nadie te pide nada, no propone: pulsa «Sugerir respuesta» para
            forzarlo. Se recuerda.
          </Text>
        </View>

        {/* Documentos */}
        <View>
          <View class="flex-row items-center justify-between pr-1">
            <Text class={caption}>Documentos de contexto (.md)</Text>
            <Button onPress={attach} class="rounded-full px-2 py-0.5 active:bg-black/5 dark:active:bg-white/10">
              <Text class={`text-[12px] font-medium ${blue}`}>Adjuntar…</Text>
            </Button>
          </View>
          <View class={group} style={glass}>
            {m.docs().length === 0 ? (
              <Button onPress={attach} class={`${row} active:bg-black/5 dark:active:bg-white/10`}>
                <Text class={`flex-1 text-[13px] ${muted}`}>Ningún documento. Adjunta uno o varios .md</Text>
              </Button>
            ) : (
              m.docs().map((doc, index) => (
                <View>
                  {index > 0 ? <View class={divider} /> : null}
                  <View class={row}>
                    <View class="flex-1 gap-0.5">
                      <Text class={label}>{`📄 ${doc.name}`}</Text>
                      <Text class={muted}>{`${doc.text.length.toLocaleString("es")} caracteres`}</Text>
                    </View>
                    <Button
                      onPress={() => void m.removeDoc(doc.name)}
                      class="rounded-full px-3 py-1 active:bg-black/5 dark:active:bg-white/10"
                    >
                      <Text class={`text-[13px] font-medium ${red}`}>Quitar</Text>
                    </Button>
                  </View>
                </View>
              ))
            )}
          </View>
          <Text class={docError() || contextChars() > LARGE_CONTEXT_CHARS ? `${footer} ${red}` : footer}>
            {docError() ||
              (contextChars() > LARGE_CONTEXT_CHARS
                ? `El contexto ocupa ${contextChars().toLocaleString("es")} caracteres: puede pasar del millón de tokens del modelo y entonces Claude no podrá responder. Quita algún documento.`
                : `Van enteros, sin recortar; Maka los lee al empezar a escuchar, antes de la primera pregunta (${contextChars().toLocaleString("es")} caracteres ahora). Se recuerdan entre reuniones; uno con el mismo nombre sustituye al anterior.`)}
          </Text>
        </View>

        {/* Notas */}
        <View>
          <Text class={caption}>Notas de la reunión (opcional)</Text>
          <View class={`${group} px-3.5 py-2.5`} style={glass}>
            <Input
              class="min-h-[72px] bg-transparent text-[13px] leading-5 text-black/85 dark:text-white/90"
              value={m.context()}
              onChange={({ value }) => m.setContext(value)}
              placeholder="Pega la agenda, notas o datos que Claude debe conocer…"
              multiline
            />
          </View>
          <Text class={footer}>Va con cada respuesta: cuanto más largo, más coste y latencia. Se recuerda.</Text>
        </View>

        {startError() ? <Text class={`px-3.5 text-[12px] ${red}`}>{startError()}</Text> : null}
        <Button
          onPress={start}
          disabled={!keyHint()}
          class="items-center rounded-full bg-[#007AFF] py-3 transition-transform duration-150 active:scale-[0.98] disabled:opacity-30 dark:bg-[#0A84FF]"
          style={{ boxShadow: "0 4px 14px rgb(0 122 255 / 0.3)" }}
        >
          <Text class="text-[15px] font-semibold text-white">Escuchar reunión</Text>
        </Button>
      </View>
    </Scroll>
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

  const send = () => {
    const shots = props.shots();
    if (shots.length === 0) return;
    try {
      m.submit(question(), shots);
      question.set("");
      sendError.set("");
      props.onClearShots();
    } catch (error) {
      sendError.set(errorText(error));
    }
  };

  return (
    <View class="flex-1">
      {/* Estado */}
      <View class="gap-2 px-4 pt-3 pb-2">
        <View class={`${group} ${row}`} style={glass}>
          <View
            class={`size-2.5 rounded-full ${m.status() === "listening" ? "bg-[#FF3B30]" : "bg-[#FF9F0A]"}`}
            style={{ boxShadow: m.status() === "listening" ? "0 0 0 3px rgb(255 59 48 / 0.2)" : "none" }}
          />
          <View class="flex-1 gap-1">
            <Text class="text-[13px] font-medium text-black/85 dark:text-white/90">{m.message() || "Escuchando"}</Text>
            <View class="h-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
              <View
                class="h-1 rounded-full bg-[#34C759] transition-all duration-100"
                style={{ width: `${Math.round(m.level() * 100)}%` }}
              />
            </View>
            <Text class={muted}>
              {m.docs().length ? `${m.source()} · ${m.docs().length} documento${m.docs().length > 1 ? "s" : ""}` : m.source()}
            </Text>
          </View>
          <Button
            onPress={() => m.stop()}
            class="rounded-full bg-[#FF3B30] px-3 py-1.5 transition-transform duration-150 active:scale-95 dark:bg-[#FF453A]"
          >
            <Text class="text-[13px] font-semibold text-white">Detener</Text>
          </Button>
        </View>
        <View class="flex-row items-center gap-2 px-1">
          <Text class={`flex-1 ${muted}`}>Responder automáticamente</Text>
          <Switch {...switchProps} checked={m.autoAnswer()} onChange={({ checked }) => m.setAutoAnswer(checked)} />
        </View>
      </View>

      {/* Intervenciones */}
      <Scroll class="flex-1">
        <View class="gap-4 px-4 pb-3">
          {m.turns().length === 0 && !m.interim() ? (
            <Text class="pt-8 text-center text-[13px] text-black/45 dark:text-white/45">
              Cuando alguien hable, la transcripción aparecerá aquí.
            </Text>
          ) : null}
          <Each of={m.turns()}>
            {(turn) => (
              <View class="gap-2">
                {turn().speaker === ME || !turn().speaker ? (
                  // Lo tuyo (tu voz o tus capturas): a la derecha, burbuja azul tenue.
                  <View class="max-w-[82%] gap-1 self-end">
                    <Text class="self-end px-1 text-[11px] font-medium text-white/40">
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
                      <View class="rounded-[18px] bg-white/[0.07] px-3.5 py-2">
                        <Text class="text-[14px] leading-5 text-white/85">{turn().text}</Text>
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
              <Text class="px-1 text-[11px] text-white/35">escuchando…</Text>
              <Text class="px-1 text-[13px] italic leading-5 text-white/50">{m.interim()}</Text>
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
            class="flex-row items-center justify-center gap-1.5 rounded-full bg-[#30D158]/15 py-2 transition-transform duration-150 active:scale-[0.98]"
          >
            <Text class="text-[13px] font-bold text-[#30D158]">✦</Text>
            <Text class="text-[14px] font-semibold text-[#30D158]">Que Maka sugiera qué decir</Text>
          </Button>
        ) : null}
        {sendError() ? <Text class={`px-1 text-[11px] ${red}`}>{sendError()}</Text> : null}
        <Shots shots={props.shots()} onRemove={props.onRemoveShot} onClear={props.onClearShots} />
        <View class="flex-row items-center gap-2 rounded-full bg-white/[0.08] py-1.5 pr-1.5 pl-1.5">
          <Button
            onPress={props.onCapture}
            disabled={props.shots().length >= MAX_SHOTS}
            class="size-8 items-center justify-center rounded-full bg-black/5 transition-transform duration-150 active:scale-90 disabled:opacity-30 dark:bg-white/10"
          >
            <Text class="text-sm">{props.shots().length ? "＋" : "📷"}</Text>
          </Button>
          <Input
            class="flex-1 bg-transparent text-[14px] text-black/90 dark:text-white/95"
            value={question()}
            onChange={({ value }) => question.set(value)}
            onSubmit={send}
            placeholder={
              props.shots().length > 1
                ? `Pregunta sobre las ${props.shots().length} capturas…`
                : props.shots().length
                  ? "Pregunta sobre la captura (＋ añade otra)…"
                  : "📷 Captura la pantalla compartida para analizarla"
            }
          />
          <Button
            onPress={send}
            disabled={props.shots().length === 0}
            class="size-8 items-center justify-center rounded-full bg-[#007AFF] transition-transform duration-150 active:scale-90 disabled:opacity-30 dark:bg-[#0A84FF]"
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
      <Text class="text-[10px] text-white/25">✎</Text>
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
    <View class="gap-2 rounded-[18px] bg-white/[0.08] px-3 py-2.5">
      <Text class="px-1 text-[12px] text-white/55">
        {`¿Cómo se llama `}
        <Text style={{ color: voiceColor(props.speaker) }}>{m.speakerLabel(props.speaker)}</Text>
        {"? Vacío: vuelve a su número."}
      </Text>
      <View class="flex-row items-center gap-2">
        <Avatar meeting={m} speaker={props.speaker} inline />
        <Input
          class="flex-1 rounded-full bg-white/10 px-3 py-1.5 text-[14px] text-white"
          value={draft()}
          onChange={({ value }) => draft.set(value)}
          onSubmit={save}
          placeholder="Nombre (p. ej. Erick)"
          accessibilityLabel={`Nombre de ${m.speakerLabel(props.speaker)}`}
          autoFocus
        />
        <Button onPress={props.onClose} class="rounded-full px-2.5 py-1.5 active:bg-white/10">
          <Text class="text-[13px] text-white/60">Cancelar</Text>
        </Button>
        <Button onPress={save} class="rounded-full bg-white/15 px-3 py-1.5 active:bg-white/25">
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
        <Text class={`px-1 text-[12px] font-semibold ${error() ? "text-[#FF6961]" : "text-[#30D158]"}`}>
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

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

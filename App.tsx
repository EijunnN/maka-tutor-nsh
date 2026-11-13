// Maka Tutor sobre NSH (prueba de concepto). Bucle central:
//   Ctrl+Shift+Espacio → captura del monitor bajo el cursor (Rust, GDI) →
//   selector de región sobre ese monitor → el panel flotante aparece →
//   preguntas → Claude responde en streaming (CLI `claude` en stream-json,
//   sin Node). Las conversaciones se guardan en el directorio de datos.
// El panel se excluye de las capturas (SetWindowDisplayAffinity), vive en la
// bandeja y tiene un "modo fantasma" en el que los clics lo atraviesan.
import { platform } from "process";
import { cleanup, effect, mount, Scroll, signal, Text, View } from "nsh";
import { Button, Input, TextView } from "nsh/base";
import { currentWindow, displays, GlobalShortcut, Tray, Window, type WindowRef } from "nsh/desktop";
import { Screen, type Shot } from "maka-tutor-nsh/native";
import { ClaudeSession } from "./claude";
import * as Settings from "./settings";
import { SettingsPage } from "./SettingsPage";
import * as History from "./history";
import { MAX_SHOTS, MeetingController, shotsLabel } from "./meeting";
import { Shots } from "./Shots";
import { UpdateBanner } from "./UpdateBanner";
import { checkUpdates, watchUpdates } from "./updates";
import { MeetingPage } from "./MeetingPage";
import { type Selection, Selector } from "./Selector";
import icon from "./tray.svg";

const HOTKEY = "mod+shift+space";
const HOTKEY_LABEL = "Ctrl+Shift+Espacio";

type Message = {
  role: "user" | "assistant";
  text: ReturnType<typeof signal<string>>;
  shot?: string;
};

// Material de cristal: Liquid Glass en macOS/iOS 26; en Windows, el desenfoque de respaldo.
const glass = { glassEffect: "regular", backdropFilter: "blur(24px) saturate(180%)" } as const;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const describe = (shot: Shot) => `${shot.sourceWidth}×${shot.sourceHeight}`;

/** El display (en puntos) del monitor que capturó Rust (en píxeles): el de
 * origen y tamaño más parecidos una vez escalados. */
const displayFor = (shot: Shot) => {
  let best: ReturnType<typeof displays>[number] | null = null;
  let bestScore = Infinity;
  for (const d of displays()) {
    const k = d.scaleFactor || 1;
    const score =
      Math.abs(d.bounds.origin.x * k - shot.sourceX) +
      Math.abs(d.bounds.origin.y * k - shot.sourceY) +
      Math.abs(d.bounds.size.width * k - shot.sourceWidth) +
      Math.abs(d.bounds.size.height * k - shot.sourceHeight);
    if (score < bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
};

function App() {
  const win = currentWindow();
  const model = signal(Settings.DEFAULT_MODEL);
  const session = new ClaudeSession(model());
  cleanup(() => session.dispose());
  // Modo reunión: sigue escuchando aunque se cambie de página.
  const meeting = new MeetingController(() => model());
  cleanup(() => meeting.stop());
  Settings.loadModel().then((id) => {
    model.set(id);
    session.setModel(id);
  });

  const messages = signal<Message[]>([]);
  const draft = signal("");
  // Las capturas adjuntas a la próxima pregunta (chat o reunión): cada
  // captura nueva se suma a las anteriores.
  const shots = signal<Shot[]>([]);
  const busy = signal(false);
  const status = signal("");
  const addShot = (next: Shot, message: string) => {
    shots.set([...shots(), next].slice(-MAX_SHOTS));
    status.set(shots().length > 1 ? `${message} · ${shots().length} capturas adjuntas` : message);
    if (page() !== "meeting") page.set("chat");
  };
  const removeShot = (index: number) => shots.set(shots().filter((_, i) => i !== index));
  const protectedWindows = signal(0);
  const ghost = signal(false);

  // Historial: la conversación abierta, si ya se guardó, y la lista.
  const conversationId = signal<string | null>(null);
  const createdAt = signal(0);
  // Transcripción de una conversación retomada: el CLI empieza sin memoria,
  // así que va delante de la primera pregunta nueva.
  const resumeContext = signal<string | null>(null);
  // Qué muestra el panel: el chat, el historial o los ajustes. En Linux no hay
  // captura de pantalla: se abre en la reunión.
  const linux = platform === "linux";
  const page = signal<"chat" | "history" | "settings" | "meeting">(linux ? "meeting" : "chat");
  const history = signal<History.Conversation[]>([]);
  const query = signal("");

  // La API key guardada (enmascarada): `load` la pone en el entorno del que
  // NSH lanza `claude`.
  const keyHint = signal<string | null>(null);
  const gatewayHint = signal<string | null>(null);
  try {
    keyHint.set(Settings.loadApiKey());
    gatewayHint.set(Settings.gatewayHint());
  } catch (error) {
    status.set(`No se pudo leer la API key: ${errorText(error)}`);
  }

  // Panel flotante: por encima de todo, fuera de la barra de tareas y en todos
  // los escritorios virtuales.
  win.set({
    level: "floating",
    taskbar: false,
    workspaces: "all",
    // Cristal en nsh.json: sin marco y con el acrílico de Windows 11 detrás
    // (sin `transparent`, que en Windows quita las esquinas y la sombra).
  });

  // Fuera de capturas, grabaciones y screen sharing: al arrancar y cada vez que
  // aparece (por si la ventana se recrea).
  const protect = () => protectedWindows.set(Screen.protect(true));
  setTimeout(protect, 0);
  win.on("focusChange", ({ focused }) => focused && protect());

  // Cerrar oculta: la app sigue en la bandeja.
  win.on("closePress", () => win.hide());

  // Captura el monitor y abre encima el selector de región; al elegir, la
  // captura (recortada o entera) se suma a las adjuntas y el panel aparece.
  // Windows: la app está excluida de las capturas (`Screen.protect`) y el
  // selector es una ventana transparente sobre la pantalla real. Linux: no
  // hay exclusión, así que primero se esconde la ventana; y como allí las
  // ventanas `overlay` dejan pasar los clics, el selector es una ventana a
  // pantalla completa que muestra la propia captura de fondo.
  let selector: WindowRef | null = null;
  let capturing = false;
  const captureAndAsk = async () => {
    if (selector || capturing) return;
    if (shots().length >= MAX_SHOTS) {
      status.set(`Como mucho ${MAX_SHOTS} capturas por pregunta: envía o quita alguna.`);
      win.focus();
      return;
    }
    capturing = true;
    const wasVisible = !!win.state()?.visible;
    let full: Shot;
    try {
      if (linux) {
        win.hide();
        // Que el compositor quite la ventana antes de capturar.
        await new Promise((r) => setTimeout(r, 350));
      }
      full = Screen.capture();
    } catch (error) {
      status.set(`No se pudo capturar: ${errorText(error)}`);
      win.focus();
      return;
    } finally {
      capturing = false;
    }
    const display = linux ? null : displayFor(full);
    if (!linux && !display) {
      addShot(full, `Pantalla entera ${describe(full)}`);
      win.focus();
      return;
    }
    win.hide();
    let done = false;
    const finish = (selection: Selection | null) => {
      if (done) return;
      done = true;
      const open = selector;
      selector = null;
      open?.close();
      if (selection === null) {
        status.set("Captura cancelada");
        if (wasVisible) win.focus();
        return;
      }
      try {
        const next = selection === "full" ? full : Screen.crop(selection.x, selection.y, selection.width, selection.height);
        addShot(next, selection === "full" ? `Pantalla entera ${describe(next)}` : `Región ${describe(next)}`);
      } catch (error) {
        status.set(`No se pudo recortar: ${errorText(error)}`);
      }
      win.focus();
    };
    const content = () => (
      <Selector
        sourceWidth={full.sourceWidth}
        sourceHeight={full.sourceHeight}
        background={linux ? `data:image/jpeg;base64,${full.data}` : undefined}
        onDone={finish}
      />
    );
    selector = linux
      ? Window.open(content, {
          id: "selector",
          kind: "normal",
          title: "Maka Tutor · captura",
          frame: "none",
          defaultMode: "fullScreen",
          taskbar: false,
          closeOnEscape: true,
          activate: true,
        })
      : Window.open(content, {
          id: "selector",
          kind: "overlay",
          defaultPosition: display!.bounds.origin,
          defaultSize: display!.bounds.size,
          frame: "none",
          transparent: true,
          shadow: false,
          taskbar: false,
          level: "floating",
          workspaces: "current",
          pointerEvents: "auto",
          closeOnEscape: true,
          activate: true,
        });
    // Escape (o cualquier otro cierre) cancela.
    selector.on("close", () => finish(null));
  };
  GlobalShortcut.register(HOTKEY, () => void captureAndAsk()).then((ok) => {
    if (!ok) status.set(`${HOTKEY_LABEL} está ocupado por otra app`);
  });
  cleanup(() => GlobalShortcut.unregisterAll());
  // Versiones nuevas desde los Releases de GitHub (nsh.json "updater").
  cleanup(watchUpdates());
  // En Linux la bandeja puede no verse (GNOME sin la extensión AppIndicator) y
  // el atajo depende del portal del escritorio: la ventana se muestra al abrir.
  if (linux) win.focus();

  const setGhost = (on: boolean) => {
    ghost.set(on);
    win.set({ pointerEvents: on ? "none" : "auto" });
  };

  const send = async () => {
    const text = draft().trim();
    if (!text || busy()) return;
    const images = shots();
    shots.set([]);
    draft.set("");
    const answer = signal("");
    messages.set([
      ...messages(),
      { role: "user", text: signal(text), shot: images.length ? shotsLabel(images) : undefined },
      { role: "assistant", text: answer },
    ]);
    const context = resumeContext();
    resumeContext.set(null);
    const prompt = context
      ? `Retomamos esta conversación anterior:\n\n${context}\n\n---\n\nNueva pregunta: ${text}`
      : text;
    busy.set(true);
    try {
      await session.ask(prompt, images.map((s) => s.data), (delta) => answer.set(answer() + delta));
    } catch (error) {
      answer.set(`${answer()}\n\n> **Error:** ${errorText(error)}`);
    } finally {
      busy.set(false);
      persist();
    }
  };

  const storedMessages = () => messages().map((m) => ({ role: m.role, text: m.text() ?? "", shot: m.shot }));

  /** Reinicia `claude` (otro modelo, otra key) sin perder la conversación:
   * su transcripción va delante de la siguiente pregunta. */
  const restartKeepingContext = () => {
    const stored = storedMessages();
    if (stored.length > 0) resumeContext.set(History.transcript(stored));
    session.reset();
  };

  const changeModel = (id: string) => {
    if (id === model() || busy()) return;
    model.set(id);
    session.setModel(id);
    restartKeepingContext();
    Settings.saveModel(id).catch((error) => status.set(`No se pudo guardar el modelo: ${errorText(error)}`));
  };

  const changeKey = (hint: string | null) => {
    keyHint.set(hint);
    if (!busy()) restartKeepingContext();
  };

  const changeGateway = (hint: string | null) => {
    gatewayHint.set(hint);
    // Sin gateway, un modelo de DeepSeek no existe: vuelve al de por defecto.
    if (!hint && Settings.isGatewayOnlyModel(model())) changeModel(Settings.DEFAULT_MODEL);
    if (!busy()) restartKeepingContext();
  };

  const toggleSettings = () => page.set(page() === "settings" ? "chat" : "settings");
  const toggleMeeting = () => page.set(page() === "meeting" ? "chat" : "meeting");

  /** Guarda la conversación abierta (la crea la primera vez). */
  const persist = () => {
    const stored = storedMessages();
    if (stored.length === 0) return;
    let id = conversationId();
    if (!id) {
      id = History.newId();
      conversationId.set(id);
      createdAt.set(Date.now());
    }
    History.save({ id, title: History.titleOf(stored), createdAt: createdAt(), updatedAt: Date.now(), messages: stored }).catch(
      (error) => status.set(`No se pudo guardar: ${errorText(error)}`),
    );
  };

  const newChat = () => {
    session.reset();
    messages.set([]);
    shots.set([]);
    busy.set(false);
    conversationId.set(null);
    resumeContext.set(null);
    page.set("chat");
  };

  const refreshHistory = () =>
    History.list()
      .then((all) => history.set(all))
      .catch((error) => status.set(`No se pudo leer el historial: ${errorText(error)}`));

  const toggleHistory = () => {
    if (page() === "history") return page.set("chat");
    query.set("");
    page.set("history");
    refreshHistory();
  };

  const openConversation = (conversation: History.Conversation) => {
    session.reset();
    busy.set(false);
    messages.set(conversation.messages.map((m) => ({ role: m.role, text: signal(m.text), shot: m.shot })));
    conversationId.set(conversation.id);
    createdAt.set(conversation.createdAt);
    resumeContext.set(History.transcript(conversation.messages));
    page.set("chat");
  };

  const deleteConversation = (id: string) => {
    History.remove(id)
      .catch((error) => status.set(`No se pudo borrar: ${errorText(error)}`))
      .then(() => {
        if (conversationId() === id) {
          session.reset();
          messages.set([]);
          conversationId.set(null);
          resumeContext.set(null);
        }
        return refreshHistory();
      });
  };

  effect(() => {
    Tray.set({
      icon,
      tooltip: "Maka Tutor",
      onClick: () => (win.state()?.visible ? win.hide() : win.focus()),
      menu: [
        { label: `Recortar y preguntar (${HOTKEY_LABEL})`, onSelect: () => void captureAndAsk() },
        { label: win.state()?.visible ? "Ocultar" : "Mostrar", onSelect: () => (win.state()?.visible ? win.hide() : win.focus()) },
        { label: ghost() ? "Salir del modo fantasma" : "Modo fantasma (los clics atraviesan)", onSelect: () => setGhost(!ghost()) },
        { label: "Nueva conversación", onSelect: newChat },
        {
          label: "Historial",
          onSelect: () => {
            win.focus();
            if (page() !== "history") toggleHistory();
          },
        },
        meeting.active
          ? { label: "Detener escucha de la reunión", onSelect: () => meeting.stop() }
          : {
              label: "Reunión",
              onSelect: () => {
                win.focus();
                page.set("meeting");
              },
            },
        {
          label: "Ajustes",
          onSelect: () => {
            win.focus();
            page.set("settings");
          },
        },
        {
          label: "Buscar actualizaciones",
          onSelect: () => {
            win.focus();
            void checkUpdates();
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  });
  cleanup(() => Tray.set(null));

  // Botón "píldora" de cristal: hairline, relleno translúcido y respuesta al pulsar.
  const pill = "flex-row items-center gap-1.5 rounded-full border border-black/5 bg-white/50 px-3 py-1.5 transition-transform duration-150 active:scale-95 dark:border-white/10 dark:bg-white/10";

  return (
    // Siempre oscuro (nsh.json "appearance": "dark"), como el Maka de Electron:
    // grafito casi opaco sobre el acrílico, borde fino y brillo arriba.
    <View
      class="flex-1 border border-white/10"
      style={{
        backgroundColor: "rgb(24 24 27 / 0.82)",
        boxShadow: "inset 0 1px 0 rgb(255 255 255 / 0.18), inset 0 -1px 0 rgb(0 0 0 / 0.18)",
      }}
    >
      {/* Cabecera: arrastra la ventana. */}
      <View desktop={{ windowDrag: true }} class="flex-row items-center gap-3 px-4 pt-3.5 pb-2.5">
        <View class="size-8 items-center justify-center rounded-[10px] bg-[#007AFF] dark:bg-[#0A84FF]" style={{ boxShadow: "0 2px 8px rgb(0 122 255 / 0.35)" }}>
          <Text class="text-sm font-bold text-white">M</Text>
        </View>
        <View class="flex-1">
          <Text class="text-[15px] font-semibold tracking-tight text-black/90 dark:text-white/95">Maka Tutor</Text>
          <Text class="text-[11px] text-black/45 dark:text-white/45">
            {`${meeting.active ? "● Reunión · " : ""}${Settings.modelLabel(model())}${gatewayHint() ? " · gateway" : keyHint() ? " · API key" : ""} · ${protectedWindows() > 0 ? "invisible en capturas" : "visible en capturas"}${ghost() ? " · fantasma" : ""}`}
          </Text>
        </View>
        <Button onPress={toggleHistory} class={pill}>
          <Text class="text-xs font-medium text-black/75 dark:text-white/80">{page() === "history" ? "Chat" : "Historial"}</Text>
        </Button>
        <Button onPress={newChat} class={pill}>
          <Text class="text-xs font-medium text-black/75 dark:text-white/80">Nueva</Text>
        </Button>
        <Button
          onPress={toggleMeeting}
          class={`size-7 items-center justify-center rounded-full transition-transform duration-150 active:scale-90 ${page() === "meeting" ? "bg-[#007AFF] dark:bg-[#0A84FF]" : meeting.active ? "bg-[#FF3B30]/15" : "bg-black/5 dark:bg-white/10"}`}
        >
          <Text class={`text-[12px] ${page() === "meeting" ? "text-white" : meeting.active ? "text-[#FF3B30]" : "text-black/55 dark:text-white/60"}`}>🎙</Text>
        </Button>
        <Button
          onPress={toggleSettings}
          class={`size-7 items-center justify-center rounded-full transition-transform duration-150 active:scale-90 ${page() === "settings" ? "bg-[#007AFF] dark:bg-[#0A84FF]" : "bg-black/5 dark:bg-white/10"}`}
        >
          <Text class={`text-[13px] ${page() === "settings" ? "text-white" : "text-black/55 dark:text-white/60"}`}>⚙</Text>
        </Button>
        <Button onPress={() => win.hide()} class="size-7 items-center justify-center rounded-full bg-black/5 transition-transform duration-150 active:scale-90 dark:bg-white/10">
          <Text class="text-xs text-black/55 dark:text-white/60">✕</Text>
        </Button>
      </View>
      <View class="mx-4 h-px bg-black/5 dark:bg-white/10" />

      <UpdateBanner />
      {page() === "meeting" ? (
        <MeetingPage meeting={meeting} shots={shots} onCapture={() => void captureAndAsk()} onRemoveShot={removeShot} onClearShots={() => shots.set([])} />
      ) : page() === "settings" ? (
        <SettingsPage model={model()} busy={busy()} onModel={changeModel} keyHint={keyHint()} onKeyChange={changeKey} gatewayHint={gatewayHint()} onGatewayChange={changeGateway} />
      ) : page() === "history" ? (
        <View class="flex-1 gap-3 px-4 pt-3">
          <View
            class="flex-row items-center gap-2 rounded-full border border-white/60 bg-white/65 px-3.5 py-1.5 dark:border-white/10 dark:bg-white/10"
            style={glass}
          >
            <Text class="text-[13px] text-black/40 dark:text-white/40">⌕</Text>
            <Input
              class="flex-1 bg-transparent text-[14px] text-black/90 dark:text-white/95"
              value={query()}
              onChange={({ value }) => query.set(value)}
              placeholder="Buscar en el historial…"
              autoFocus
            />
          </View>
          <Scroll class="flex-1">
            <View class="gap-1.5 pb-4">
              {history().filter((c) => History.matches(c, query())).length === 0 ? (
                <Text class="pt-10 text-center text-[13px] text-black/45 dark:text-white/45">
                  {query().trim() ? "Nada coincide con la búsqueda." : "Aún no hay conversaciones guardadas."}
                </Text>
              ) : null}
              <Each of={history().filter((c) => History.matches(c, query()))}>
                {(conversation) => (
                  <View
                    class="flex-row items-center gap-2 rounded-2xl border border-white/50 bg-white/50 py-1.5 pr-1.5 pl-3.5 dark:border-white/10 dark:bg-white/[0.06]"
                    style={glass}
                  >
                    <Button
                      onPress={() => openConversation(conversation())}
                      class="flex-1 gap-0.5 py-1 transition-transform duration-150 active:scale-[0.98]"
                    >
                      <Text class="line-clamp-1 text-[14px] font-medium text-black/85 dark:text-white/90">
                        {conversation().title}
                      </Text>
                      <Text class="text-[11px] text-black/45 dark:text-white/45">
                        {`${History.when(conversation().updatedAt)} · ${Math.ceil(conversation().messages.length / 2)} pregunta(s)`}
                      </Text>
                    </Button>
                    <Button
                      onPress={() => deleteConversation(conversation().id)}
                      class="size-7 items-center justify-center rounded-full transition-transform duration-150 active:scale-90 active:bg-black/5 dark:active:bg-white/10"
                    >
                      <Text class="text-xs text-black/40 dark:text-white/40">✕</Text>
                    </Button>
                  </View>
                )}
              </Each>
            </View>
          </Scroll>
        </View>
      ) : (
      <Scroll class="flex-1">
        <View class="gap-2.5 px-4 py-4">
          {messages().length === 0 ? (
            <View class="items-center gap-3 px-6 pt-16">
              <View class="size-14 items-center justify-center rounded-2xl border border-white/50 bg-white/40 dark:border-white/10 dark:bg-white/10" style={glass}>
                <Text class="text-2xl">🎓</Text>
              </View>
              <Text class="text-[17px] font-semibold tracking-tight text-black/85 dark:text-white/90">Pregunta sobre tu pantalla</Text>
              <Text class="text-center text-[13px] leading-5 text-black/50 dark:text-white/50">
                Captura lo que tienes delante y Claude te lo explica paso a paso.
              </Text>
              <View class="flex-row gap-1.5 pt-1">
                {["Ctrl", "Shift", "Espacio"].map((key) => (
                  <View class="rounded-md border border-black/10 bg-white/60 px-2 py-0.5 dark:border-white/15 dark:bg-white/10">
                    <Text class="text-[11px] font-medium text-black/60 dark:text-white/70">{key}</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}
          <Each of={messages()}>
            {(message) =>
              message().role === "user" ? (
                // Tú: a la derecha, burbuja azul.
                <View class="max-w-[82%] gap-1 self-end">
                  <Text class="self-end px-1 text-[11px] font-medium text-white/40">Tú</Text>
                  <View class="gap-0.5 rounded-[18px] bg-[#0A84FF] px-3.5 py-2">
                    {message().shot ? (
                      <Text class="text-[11px] font-medium text-white/75">{`📷 ${message().shot}`}</Text>
                    ) : null}
                    <Text class="text-[14px] leading-5 text-white">{message().text()}</Text>
                  </View>
                </View>
              ) : (
                // Maka: su avatar y una superficie con tinte verde suave, sin bordes.
                <View class="flex-row gap-2 self-stretch">
                  <View class="size-7 items-center justify-center rounded-full bg-[#30D158]/20">
                    <Text class="text-[13px] font-bold text-[#30D158]">✦</Text>
                  </View>
                  <View class="flex-1 gap-1">
                    <Text class="px-1 text-[12px] font-semibold text-[#30D158]">
                      {message().text() ? "Maka" : "Maka está pensando…"}
                    </Text>
                    {message().text() ? (
                      <View class="rounded-[18px] bg-[#30D158]/[0.09] px-3.5 py-2.5">
                        <TextView markdown={message().text()} options={{ streaming: true }} selectable />
                      </View>
                    ) : null}
                  </View>
                </View>
              )
            }
          </Each>
        </View>
      </Scroll>
      )}

      {/* Compositor flotante. */}
      {page() !== "chat" ? null : (
      <View class="gap-2 px-3 pb-3">
        <Shots shots={shots()} onRemove={removeShot} onClear={() => shots.set([])} />
        {status() ? (
          <Text class="px-1 text-[11px] text-black/40 dark:text-white/40">{status()}</Text>
        ) : null}
        <View
          class="flex-row items-center gap-2 rounded-full border border-white/60 bg-white/65 py-1.5 pr-1.5 pl-1.5 dark:border-white/10 dark:bg-white/10"
          style={{ ...glass, boxShadow: "0 4px 16px rgb(0 0 0 / 0.08)" }}
        >
          <Button
            onPress={() => void captureAndAsk()}
            disabled={shots().length >= MAX_SHOTS}
            class="size-8 items-center justify-center rounded-full bg-black/5 transition-transform duration-150 active:scale-90 disabled:opacity-30 dark:bg-white/10"
          >
            <Text class="text-sm">{shots().length ? "＋" : "📷"}</Text>
          </Button>
          <Input
            class="flex-1 bg-transparent text-[14px] text-black/90 dark:text-white/95"
            value={draft()}
            onChange={({ value }) => draft.set(value)}
            onSubmit={send}
            placeholder={
              shots().length > 1
                ? `Pregunta sobre las ${shots().length} capturas…`
                : shots().length
                  ? "Pregunta sobre la captura (＋ añade otra)…"
                  : "Pregunta lo que quieras…"
            }
            autoFocus
          />
          <Button
            onPress={send}
            disabled={busy() || !draft().trim()}
            class="size-8 items-center justify-center rounded-full bg-[#007AFF] transition-transform duration-150 active:scale-90 disabled:opacity-30 dark:bg-[#0A84FF]"
          >
            <Text class="text-[15px] font-bold text-white">{busy() ? "…" : "↑"}</Text>
          </Button>
        </View>
      </View>
      )}
    </View>
  );
}

mount(App);

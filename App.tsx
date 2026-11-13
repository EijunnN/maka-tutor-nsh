// Maka Tutor sobre NSH (prueba de concepto). Bucle central:
//   Ctrl+Shift+Espacio → captura del monitor bajo el cursor (Rust, GDI) →
//   selector de región sobre ese monitor → el panel flotante aparece →
//   preguntas → Claude responde en streaming (CLI `claude` en stream-json,
//   sin Node). Las conversaciones se guardan en el directorio de datos.
// El panel se excluye de las capturas (SetWindowDisplayAffinity), vive en la
// bandeja y tiene un "modo fantasma" en el que los clics lo atraviesan.
import { cleanup, effect, mount, Scroll, signal, Text, View } from "nsh";
import { Button, Input, TextView } from "nsh/base";
import { currentWindow, displays, GlobalShortcut, Tray, Window, type WindowRef } from "nsh/desktop";
import { Screen, type Shot } from "maka-tutor-nsh/native";
import { ClaudeSession, MODEL } from "./claude";
import * as History from "./history";
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
  const session = new ClaudeSession();
  cleanup(() => session.dispose());

  const messages = signal<Message[]>([]);
  const draft = signal("");
  const shot = signal<Shot | null>(null);
  const busy = signal(false);
  const status = signal("");
  const protectedWindows = signal(0);
  const ghost = signal(false);

  // Historial: la conversación abierta, si ya se guardó, y la lista.
  const conversationId = signal<string | null>(null);
  const createdAt = signal(0);
  // Transcripción de una conversación retomada: el CLI empieza sin memoria,
  // así que va delante de la primera pregunta nueva.
  const resumeContext = signal<string | null>(null);
  const showHistory = signal(false);
  const history = signal<History.Conversation[]>([]);
  const query = signal("");

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
  // captura (recortada o entera) queda adjunta y el panel aparece.
  let selector: WindowRef | null = null;
  const captureAndAsk = () => {
    if (selector) return;
    let full: Shot;
    try {
      full = Screen.capture();
    } catch (error) {
      status.set(`No se pudo capturar: ${errorText(error)}`);
      win.focus();
      return;
    }
    const display = displayFor(full);
    if (!display) {
      shot.set(full);
      status.set(`Pantalla entera ${describe(full)}`);
      win.focus();
      return;
    }
    const wasVisible = !!win.state()?.visible;
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
        shot.set(next);
        status.set(selection === "full" ? `Pantalla entera ${describe(next)}` : `Región ${describe(next)}`);
      } catch (error) {
        status.set(`No se pudo recortar: ${errorText(error)}`);
      }
      showHistory.set(false);
      win.focus();
    };
    selector = Window.open(
      () => <Selector sourceWidth={full.sourceWidth} sourceHeight={full.sourceHeight} onDone={finish} />,
      {
        id: "selector",
        kind: "overlay",
        defaultPosition: display.bounds.origin,
        defaultSize: display.bounds.size,
        frame: "none",
        transparent: true,
        shadow: false,
        taskbar: false,
        level: "floating",
        workspaces: "current",
        pointerEvents: "auto",
        closeOnEscape: true,
        activate: true,
      },
    );
    // Escape (o cualquier otro cierre) cancela.
    selector.on("close", () => finish(null));
  };
  GlobalShortcut.register(HOTKEY, captureAndAsk).then((ok) => {
    if (!ok) status.set(`${HOTKEY_LABEL} está ocupado por otra app`);
  });
  cleanup(() => GlobalShortcut.unregisterAll());

  const setGhost = (on: boolean) => {
    ghost.set(on);
    win.set({ pointerEvents: on ? "none" : "auto" });
  };

  const send = async () => {
    const text = draft().trim();
    if (!text || busy()) return;
    const image = shot();
    shot.set(null);
    draft.set("");
    const answer = signal("");
    messages.set([
      ...messages(),
      { role: "user", text: signal(text), shot: image ? describe(image) : undefined },
      { role: "assistant", text: answer },
    ]);
    const context = resumeContext();
    resumeContext.set(null);
    const prompt = context
      ? `Retomamos esta conversación anterior:\n\n${context}\n\n---\n\nNueva pregunta: ${text}`
      : text;
    busy.set(true);
    try {
      await session.ask(prompt, image?.data ?? null, (delta) => answer.set(answer() + delta));
    } catch (error) {
      answer.set(`${answer()}\n\n> **Error:** ${errorText(error)}`);
    } finally {
      busy.set(false);
      persist();
    }
  };

  /** Guarda la conversación abierta (la crea la primera vez). */
  const persist = () => {
    const stored = messages().map((m) => ({ role: m.role, text: m.text() ?? "", shot: m.shot }));
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
    shot.set(null);
    busy.set(false);
    conversationId.set(null);
    resumeContext.set(null);
    showHistory.set(false);
  };

  const refreshHistory = () =>
    History.list()
      .then((all) => history.set(all))
      .catch((error) => status.set(`No se pudo leer el historial: ${errorText(error)}`));

  const toggleHistory = () => {
    if (showHistory()) return showHistory.set(false);
    query.set("");
    showHistory.set(true);
    refreshHistory();
  };

  const openConversation = (conversation: History.Conversation) => {
    session.reset();
    busy.set(false);
    messages.set(conversation.messages.map((m) => ({ role: m.role, text: signal(m.text), shot: m.shot })));
    conversationId.set(conversation.id);
    createdAt.set(conversation.createdAt);
    resumeContext.set(History.transcript(conversation.messages));
    showHistory.set(false);
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
        { label: `Recortar y preguntar (${HOTKEY_LABEL})`, onSelect: captureAndAsk },
        { label: win.state()?.visible ? "Ocultar" : "Mostrar", onSelect: () => (win.state()?.visible ? win.hide() : win.focus()) },
        { label: ghost() ? "Salir del modo fantasma" : "Modo fantasma (los clics atraviesan)", onSelect: () => setGhost(!ghost()) },
        { label: "Nueva conversación", onSelect: newChat },
        {
          label: "Historial",
          onSelect: () => {
            win.focus();
            if (!showHistory()) toggleHistory();
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
    <View class="flex-1 bg-white/25 dark:bg-black/20">
      {/* Cabecera: arrastra la ventana. */}
      <View desktop={{ windowDrag: true }} class="flex-row items-center gap-3 px-4 pt-3.5 pb-2.5">
        <View class="size-8 items-center justify-center rounded-[10px] bg-[#007AFF] dark:bg-[#0A84FF]" style={{ boxShadow: "0 2px 8px rgb(0 122 255 / 0.35)" }}>
          <Text class="text-sm font-bold text-white">M</Text>
        </View>
        <View class="flex-1">
          <Text class="text-[15px] font-semibold tracking-tight text-black/90 dark:text-white/95">Maka Tutor</Text>
          <Text class="text-[11px] text-black/45 dark:text-white/45">
            {`${MODEL.replace("claude-", "")} · ${protectedWindows() > 0 ? "invisible en capturas" : "visible en capturas"}${ghost() ? " · fantasma" : ""}`}
          </Text>
        </View>
        <Button onPress={toggleHistory} class={pill}>
          <Text class="text-xs font-medium text-black/75 dark:text-white/80">{showHistory() ? "Chat" : "Historial"}</Text>
        </Button>
        <Button onPress={newChat} class={pill}>
          <Text class="text-xs font-medium text-black/75 dark:text-white/80">Nueva</Text>
        </Button>
        <Button onPress={() => win.hide()} class="size-7 items-center justify-center rounded-full bg-black/5 transition-transform duration-150 active:scale-90 dark:bg-white/10">
          <Text class="text-xs text-black/55 dark:text-white/60">✕</Text>
        </Button>
      </View>
      <View class="mx-4 h-px bg-black/5 dark:bg-white/10" />

      {showHistory() ? (
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
                <View class="max-w-[85%] gap-0.5 self-end rounded-[18px] bg-[#007AFF] px-3.5 py-2 dark:bg-[#0A84FF]">
                  {message().shot ? (
                    <Text class="text-[11px] text-white/75">{`📷 ${message().shot}`}</Text>
                  ) : null}
                  <Text class="text-[14px] leading-5 text-white">{message().text()}</Text>
                </View>
              ) : (
                <View class="max-w-[95%] self-start rounded-[18px] border border-white/50 bg-white/55 px-3.5 py-2.5 dark:border-white/10 dark:bg-white/[0.07]" style={glass}>
                  {message().text() ? (
                    <TextView markdown={message().text()} options={{ streaming: true }} selectable />
                  ) : (
                    <Text class="text-[13px] text-black/45 dark:text-white/45">Pensando…</Text>
                  )}
                </View>
              )
            }
          </Each>
        </View>
      </Scroll>
      )}

      {/* Compositor flotante. */}
      {showHistory() ? null : (
      <View class="gap-2 px-3 pb-3">
        {shot() || status() ? (
          <View class="flex-row items-center gap-2 px-1">
            {shot() ? (
              <Button onPress={() => shot.set(null)} class={pill}>
                <Text class="text-[11px] font-medium text-[#007AFF] dark:text-[#0A84FF]">{`📷 ${describe(shot()!)}`}</Text>
                <Text class="text-[11px] text-black/40 dark:text-white/40">✕</Text>
              </Button>
            ) : null}
            <Text class="flex-1 text-[11px] text-black/40 dark:text-white/40">{status()}</Text>
          </View>
        ) : null}
        <View
          class="flex-row items-center gap-2 rounded-full border border-white/60 bg-white/65 py-1.5 pr-1.5 pl-1.5 dark:border-white/10 dark:bg-white/10"
          style={{ ...glass, boxShadow: "0 4px 16px rgb(0 0 0 / 0.08)" }}
        >
          <Button onPress={captureAndAsk} class="size-8 items-center justify-center rounded-full bg-black/5 transition-transform duration-150 active:scale-90 dark:bg-white/10">
            <Text class="text-sm">📷</Text>
          </Button>
          <Input
            class="flex-1 bg-transparent text-[14px] text-black/90 dark:text-white/95"
            value={draft()}
            onChange={({ value }) => draft.set(value)}
            onSubmit={send}
            placeholder={shot() ? "Pregunta sobre la captura…" : "Pregunta lo que quieras…"}
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

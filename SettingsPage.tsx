// Ajustes, como una lista agrupada de iOS sobre cristal: modelo, API key,
// arranque con la sesión y el CLI de Claude.
import { Scroll, signal, Text, View } from "nsh";
import { Button, Input, Switch } from "nsh/base";
import * as Settings from "./settings";
import { checkUpdates, currentVersion, updateState } from "./updates";

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

export function SettingsPage(props: {
  model: string;
  busy: boolean;
  onModel: (id: string) => void;
  keyHint: string | null;
  onKeyChange: (hint: string | null) => void;
  gatewayHint: string | null;
  onGatewayChange: (hint: string | null) => void;
}) {
  // DeepSeek: solo la key; la URL y el modelo los pone la app.
  const provider = signal<"deepseek" | "custom">("deepseek");
  const keyDraft = signal("");
  const keyError = signal("");
  const customDraft = signal(Settings.isCustomModel(props.model) ? props.model : "");
  const modelError = signal("");
  const gatewayUrl = signal("");
  const gatewayToken = signal("");
  const gatewayError = signal("");

  const useCustomModel = () => {
    try {
      props.onModel(Settings.validateModel(customDraft()));
      modelError.set("");
    } catch (error) {
      modelError.set(errorText(error));
    }
  };

  const gatewayReady = () => !!gatewayToken().trim() && (provider() === "deepseek" || !!gatewayUrl().trim());

  const saveGateway = () => {
    if (!gatewayReady()) return;
    try {
      const deepseek = provider() === "deepseek";
      props.onGatewayChange(Settings.saveGateway(deepseek ? Settings.DEEPSEEK.url : gatewayUrl(), gatewayToken()));
      if (deepseek) props.onModel(Settings.DEEPSEEK.model);
      gatewayUrl.set("");
      gatewayToken.set("");
      gatewayError.set("");
    } catch (error) {
      gatewayError.set(errorText(error));
    }
  };

  const clearGateway = () => {
    try {
      Settings.clearGateway();
      props.onGatewayChange(null);
      gatewayError.set("");
    } catch (error) {
      gatewayError.set(errorText(error));
    }
  };

  const launch = signal(safe(() => Settings.launchAtLogin(), false));
  const launchError = signal("");
  const cli = signal<string | null | undefined>(undefined);
  Settings.claudeVersion().then((version) => cli.set(version));

  const saveKey = () => {
    const value = keyDraft().trim();
    if (!value) return;
    try {
      props.onKeyChange(Settings.saveApiKey(value));
      keyDraft.set("");
      keyError.set("");
    } catch (error) {
      keyError.set(errorText(error));
    }
  };

  const clearKey = () => {
    try {
      Settings.clearApiKey();
      props.onKeyChange(null);
      keyError.set("");
    } catch (error) {
      keyError.set(errorText(error));
    }
  };

  const toggleLaunch = (checked: boolean) => {
    try {
      Settings.setLaunchAtLogin(checked);
      launch.set(checked);
      launchError.set("");
    } catch (error) {
      launchError.set(errorText(error));
    }
  };

  return (
    <Scroll class="flex-1">
      <View class="gap-5 px-4 py-4">
        {/* Modelo */}
        <View>
          <Text class={caption}>Modelo</Text>
          <View class={group} style={glass}>
            {Settings.MODELS.map((model, index) => (
              <View>
                {index > 0 ? <View class={divider} /> : null}
                <Button
                  onPress={() => props.onModel(model.id)}
                  disabled={props.busy}
                  class={`${row} active:bg-black/5 disabled:opacity-50 dark:active:bg-white/10`}
                >
                  <View class="flex-1 gap-0.5">
                    <Text class={label}>{model.label}</Text>
                    <Text class={muted}>{model.note}</Text>
                  </View>
                  {props.model === model.id ? (
                    <Text class="text-[15px] font-semibold text-[#007AFF] dark:text-[#0A84FF]">✓</Text>
                  ) : null}
                </Button>
              </View>
            ))}
            <View class={divider} />
            <View class={row}>
              <Input
                class="flex-1 bg-transparent text-[14px] text-black/90 dark:text-white/95"
                value={customDraft()}
                onChange={({ value }) => customDraft.set(value)}
                onSubmit={useCustomModel}
                placeholder="Otro modelo (p. ej. opus)"
              />
              {Settings.isCustomModel(props.model) && customDraft().trim() === props.model ? (
                <Text class="text-[15px] font-semibold text-[#007AFF] dark:text-[#0A84FF]">✓</Text>
              ) : (
                <Button
                  onPress={useCustomModel}
                  disabled={!customDraft().trim() || props.busy}
                  class="rounded-full bg-[#007AFF] px-3 py-1 transition-transform duration-150 active:scale-95 disabled:opacity-30 dark:bg-[#0A84FF]"
                >
                  <Text class="text-[13px] font-medium text-white">Usar</Text>
                </Button>
              )}
            </View>
          </View>
          <Text class={modelError() ? `${footer} text-[#FF3B30] dark:text-[#FF453A]` : footer}>
            {modelError() || props.busy
              ? "Espera a que termine la respuesta para cambiarlo."
              : "Se aplica a la siguiente pregunta; la conversación abierta se conserva."}
          </Text>
        </View>

        {/* API key */}
        <View>
          <Text class={caption}>API key de Anthropic</Text>
          <View class={group} style={glass}>
            {props.keyHint ? (
              <View class={row}>
                <View class="flex-1 gap-0.5">
                  <Text class={label}>Guardada</Text>
                  <Text class={muted}>{props.keyHint}</Text>
                </View>
                <Button onPress={clearKey} class="rounded-full px-3 py-1 active:bg-black/5 dark:active:bg-white/10">
                  <Text class="text-[13px] font-medium text-[#FF3B30] dark:text-[#FF453A]">Quitar</Text>
                </Button>
              </View>
            ) : (
              <View class={row}>
                <Input
                  class="flex-1 bg-transparent text-[14px] text-black/90 dark:text-white/95"
                  value={keyDraft()}
                  onChange={({ value }) => keyDraft.set(value)}
                  onSubmit={saveKey}
                  placeholder="sk-ant-…"
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
          <Text class={keyError() ? `${footer} text-[#FF3B30] dark:text-[#FF453A]` : footer}>
            {keyError() ||
              (props.gatewayHint
                ? "Ahora manda el gateway; la key se usará si lo quitas."
                : props.keyHint
                ? "Claude usa esta key (se factura por uso). Se guarda cifrada en el Administrador de credenciales de Windows."
                : "Sin key, Claude usa la sesión de `claude login` (tu suscripción). La key se guarda cifrada en el Administrador de credenciales de Windows.")}
          </Text>
        </View>

        {/* Gateway */}
        <View>
          <Text class={caption}>Gateway (opcional)</Text>
          <View class={group} style={glass}>
            {props.gatewayHint ? (
              <View class={row}>
                <View class="flex-1 gap-0.5">
                  <Text class={label}>En uso</Text>
                  <Text class={muted}>{props.gatewayHint}</Text>
                </View>
                <Button onPress={clearGateway} class="rounded-full px-3 py-1 active:bg-black/5 dark:active:bg-white/10">
                  <Text class="text-[13px] font-medium text-[#FF3B30] dark:text-[#FF453A]">Quitar</Text>
                </Button>
              </View>
            ) : (
              <View>
                <View class={`${row} gap-1.5`}>
                  {(
                    [
                      ["deepseek", "DeepSeek"],
                      ["custom", "Otro servidor"],
                    ] as const
                  ).map(([id, text]) => (
                    <Button
                      onPress={() => provider.set(id)}
                      class={`flex-1 items-center rounded-full py-1.5 ${provider() === id ? "bg-[#007AFF] dark:bg-[#0A84FF]" : "bg-black/5 dark:bg-white/10"}`}
                    >
                      <Text class={`text-[13px] font-medium ${provider() === id ? "text-white" : "text-black/70 dark:text-white/75"}`}>
                        {text}
                      </Text>
                    </Button>
                  ))}
                </View>
                <View class={divider} />
                {provider() === "custom" ? (
                  <View>
                    <View class={row}>
                      <Input
                        class="flex-1 bg-transparent text-[14px] text-black/90 dark:text-white/95"
                        value={gatewayUrl()}
                        onChange={({ value }) => gatewayUrl.set(value)}
                        placeholder="URL (https://…)"
                      />
                    </View>
                    <View class={divider} />
                  </View>
                ) : null}
                <View class={row}>
                  <Input
                    class="flex-1 bg-transparent text-[14px] text-black/90 dark:text-white/95"
                    value={gatewayToken()}
                    onChange={({ value }) => gatewayToken.set(value)}
                    onSubmit={saveGateway}
                    placeholder={provider() === "deepseek" ? "API key de DeepSeek (sk-…)" : "Token"}
                    masked
                  />
                  <Button
                    onPress={saveGateway}
                    disabled={!gatewayReady()}
                    class="rounded-full bg-[#007AFF] px-3 py-1 transition-transform duration-150 active:scale-95 disabled:opacity-30 dark:bg-[#0A84FF]"
                  >
                    <Text class="text-[13px] font-medium text-white">Guardar</Text>
                  </Button>
                </View>
              </View>
            )}
          </View>
          <Text class={gatewayError() ? `${footer} text-[#FF3B30] dark:text-[#FF453A]` : footer}>
            {gatewayError() ||
              (provider() === "deepseek" && !props.gatewayHint
                ? "Usa la API de DeepSeek compatible con Anthropic y elige DeepSeek V4.1 Flash (deepseek-flash, admite capturas). Se factura en tu cuenta de DeepSeek. La key se guarda en el almacén de claves del sistema."
                : "Como ANTHROPIC_BASE_URL y ANTHROPIC_AUTH_TOKEN en la terminal: chat y reunión van por ese servidor. Tiene prioridad sobre la API key. El token se guarda en el almacén de claves del sistema.")}
          </Text>
        </View>

        {/* General */}
        <View>
          <Text class={caption}>General</Text>
          <View class={group} style={glass}>
            <View class={row}>
              <Text class={`flex-1 ${label}`}>Abrir al iniciar sesión</Text>
              <Switch
                checked={launch()}
                onChange={({ checked }) => toggleLaunch(checked)}
                class="h-[26px] w-[44px]"
                trackClass="h-[26px] w-[44px] rounded-full bg-black/15 transition-colors duration-200 checked:bg-[#34C759] dark:bg-white/20"
                thumbClass="m-[2px] size-[22px] rounded-full bg-white shadow transition-transform duration-200 checked:translate-x-[18px]"
              />
            </View>
          </View>
          {launchError() ? (
            <Text class={`${footer} text-[#FF3B30] dark:text-[#FF453A]`}>{launchError()}</Text>
          ) : (
            <Text class={footer}>Arranca oculta en la bandeja, lista para {"Ctrl+Shift+Espacio"}.</Text>
          )}
        </View>

        {/* Acerca de */}
        <View>
          <Text class={caption}>Claude</Text>
          <View class={group} style={glass}>
            <View class={row}>
              <Text class={`flex-1 ${label}`}>CLI de Claude</Text>
              <Text class={muted}>
                {cli() === undefined ? "Comprobando…" : cli() ? `v${cli()}` : "No encontrado en el PATH"}
              </Text>
            </View>
          </View>
        </View>

        {/* Versión y actualizaciones */}
        <View>
          <Text class={caption}>Maka Tutor</Text>
          <View class={group} style={glass}>
            <View class={row}>
              <View class="flex-1 gap-0.5">
                <Text class={label}>{`Versión ${currentVersion() ?? "de desarrollo"}`}</Text>
                <Text class={muted}>
                  {(() => {
                    const s = updateState();
                    if (s.kind === "checking") return "Buscando…";
                    if (s.kind === "current") return "Tienes la última versión";
                    if (s.kind === "available") return `Hay una nueva: ${s.update.version} (arriba, «Actualizar»)`;
                    if (s.kind === "downloading" || s.kind === "installing") return `Actualizando a ${s.update.version}…`;
                    if (s.kind === "error") return s.message;
                    return "Se comprueba sola al abrir la app y cada 6 horas";
                  })()}
                </Text>
              </View>
              <Button
                onPress={() => void checkUpdates()}
                disabled={!currentVersion() || updateState().kind === "checking"}
                class="rounded-full px-3 py-1 active:bg-black/5 disabled:opacity-30 dark:active:bg-white/10"
              >
                <Text class="text-[13px] font-medium text-[#007AFF] dark:text-[#0A84FF]">Buscar</Text>
              </Button>
            </View>
          </View>
        </View>
      </View>
    </Scroll>
  );
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

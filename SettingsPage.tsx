// Ajustes: modelo, cómo se conecta Claude (sesión, API key o gateway), la
// clave de la transcripción, arranque con la sesión y versiones.
import { Scroll, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { TranscriptionKey } from "maka-tutor-nsh/native";
import * as Settings from "./settings";
import { checkUpdates, currentVersion, updateState } from "./updates";
import { Choice, Divider, errorText, Field, FieldRow, Row, safe, Section, TextButton, Toggle } from "./ui";

export function SettingsPage(props: {
  model: string;
  busy: boolean;
  onModel: (id: string) => void;
  keyHint: string | null;
  onKeyChange: (hint: string | null) => void;
  gatewayHint: string | null;
  onGatewayChange: (hint: string | null) => void;
}) {
  return (
    <Scroll class="flex-1" contentClass="gap-6 px-4 pt-4 pb-6">
      <ModelSection {...props} />
      <ClaudeAccess {...props} />
      <TranscriptionSection />
      <GeneralSection />
      <AboutSection />
    </Scroll>
  );
}

function ModelSection(props: { model: string; busy: boolean; onModel: (id: string) => void }) {
  const custom = signal(Settings.isCustomModel(props.model) ? props.model : "");
  const error = signal("");
  const useCustom = () => {
    try {
      props.onModel(Settings.validateModel(custom()));
      error.set("");
    } catch (e) {
      error.set(errorText(e));
    }
  };
  return (
    <Section
      title="Modelo"
      error={error() || null}
      note={props.busy ? "Espera a que termine la respuesta para cambiarlo." : "Se aplica a la siguiente pregunta; la conversación sigue."}
    >
      {Settings.MODELS.map((model, index) => (
        <View>
          {index > 0 ? <Divider /> : null}
          <Choice
            title={model.label}
            detail={model.note}
            chosen={props.model === model.id}
            onPress={() => props.onModel(model.id)}
            disabled={props.busy}
          />
        </View>
      ))}
      <Divider />
      <FieldRow
        value={custom()}
        onChange={custom.set}
        onSave={useCustom}
        placeholder="Otro modelo (p. ej. opus)"
        button={Settings.isCustomModel(props.model) && custom().trim() === props.model ? "✓ En uso" : "Usar"}
        disabled={props.busy || (Settings.isCustomModel(props.model) && custom().trim() === props.model)}
      />
    </Section>
  );
}

/** Cómo llega Claude: la sesión de `claude login`, una API key o un gateway. */
function ClaudeAccess(props: {
  model: string;
  onModel: (id: string) => void;
  keyHint: string | null;
  onKeyChange: (hint: string | null) => void;
  gatewayHint: string | null;
  onGatewayChange: (hint: string | null) => void;
}) {
  const keyDraft = signal("");
  const keyError = signal("");
  const provider = signal<"deepseek" | "custom">("deepseek");
  const gatewayUrl = signal("");
  const gatewayToken = signal("");
  const gatewayError = signal("");

  const saveKey = () => {
    if (!keyDraft().trim()) return;
    try {
      props.onKeyChange(Settings.saveApiKey(keyDraft().trim()));
      keyDraft.set("");
      keyError.set("");
    } catch (e) {
      keyError.set(errorText(e));
    }
  };
  const clearKey = () => {
    try {
      Settings.clearApiKey();
      props.onKeyChange(null);
      keyError.set("");
    } catch (e) {
      keyError.set(errorText(e));
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
    } catch (e) {
      gatewayError.set(errorText(e));
    }
  };
  const clearGateway = () => {
    try {
      Settings.clearGateway();
      props.onGatewayChange(null);
      gatewayError.set("");
    } catch (e) {
      gatewayError.set(errorText(e));
    }
  };

  const using = props.gatewayHint ? "un gateway" : props.keyHint ? "tu API key" : "tu sesión de claude login";

  return (
    <View class="gap-6">
      <Section
        title="API key de Anthropic (opcional)"
        error={keyError() || null}
        note={
          props.gatewayHint
            ? "Ahora manda el gateway; la key se usará si lo quitas."
            : props.keyHint
              ? "Se factura por uso. Guardada en el almacén de claves del sistema."
              : `Sin key, Claude usa ${using} (tu suscripción).`
        }
      >
        {props.keyHint ? (
          <Row title="Guardada" detail={props.keyHint}>
            <TextButton text="Quitar" tone="red" onPress={clearKey} />
          </Row>
        ) : (
          <FieldRow value={keyDraft()} onChange={keyDraft.set} onSave={saveKey} placeholder="sk-ant-…" masked label="API key de Anthropic" />
        )}
      </Section>

      <Section
        title="Gateway (opcional)"
        error={gatewayError() || null}
        note={
          props.gatewayHint
            ? "Chat y reunión van por este servidor; tiene prioridad sobre la API key."
            : provider() === "deepseek"
              ? "DeepSeek V4.1 Flash por su API compatible con Anthropic (admite capturas). Se factura en tu cuenta de DeepSeek."
              : "Como ANTHROPIC_BASE_URL y ANTHROPIC_AUTH_TOKEN en la terminal."
        }
      >
        {props.gatewayHint ? (
          <Row title="En uso" detail={props.gatewayHint}>
            <TextButton text="Quitar" tone="red" onPress={clearGateway} />
          </Row>
        ) : (
          <View>
            <View class="flex-row gap-1.5 px-3 pt-3">
              {(
                [
                  ["deepseek", "DeepSeek"],
                  ["custom", "Otro servidor"],
                ] as const
              ).map(([id, text]) => (
                <Button
                  onPress={() => provider.set(id)}
                  class={`flex-1 items-center rounded-lg py-1.5 ${provider() === id ? "bg-white/15" : "bg-transparent active:bg-white/[0.06]"}`}
                >
                  <Text class={`text-[13px] font-medium ${provider() === id ? "text-white" : "text-white/55"}`}>{text}</Text>
                </Button>
              ))}
            </View>
            {provider() === "custom" ? (
              <View class="px-3 pt-2.5">
                <Field value={gatewayUrl()} onChange={gatewayUrl.set} placeholder="URL (https://…)" />
              </View>
            ) : null}
            <FieldRow
              value={gatewayToken()}
              onChange={gatewayToken.set}
              onSave={saveGateway}
              placeholder={provider() === "deepseek" ? "API key de DeepSeek (sk-…)" : "Token"}
              masked
              disabled={!gatewayReady()}
            />
          </View>
        )}
      </Section>
    </View>
  );
}

/** La clave de AssemblyAI (modo reunión). */
function TranscriptionSection() {
  const hint = signal(safe(() => TranscriptionKey.hint() ?? null, null));
  const draft = signal("");
  const error = signal("");
  const save = () => {
    try {
      TranscriptionKey.save(draft());
      hint.set(TranscriptionKey.hint() ?? null);
      draft.set("");
      error.set("");
    } catch (e) {
      error.set(errorText(e));
    }
  };
  const clear = () => {
    try {
      TranscriptionKey.clear();
      hint.set(null);
    } catch (e) {
      error.set(errorText(e));
    }
  };
  return (
    <Section
      title="Transcripción de reuniones"
      error={error() || null}
      note="AssemblyAI transcribe y separa las voces en directo. La clave se guarda en el almacén de claves del sistema."
    >
      {hint() ? (
        <Row title="Clave de AssemblyAI" detail={hint()}>
          <TextButton text="Quitar" tone="red" onPress={clear} />
        </Row>
      ) : (
        <FieldRow value={draft()} onChange={draft.set} onSave={save} placeholder="Clave de AssemblyAI" masked />
      )}
    </Section>
  );
}

function GeneralSection() {
  const launch = signal(safe(() => Settings.launchAtLogin(), false));
  const error = signal("");
  const toggle = (checked: boolean) => {
    try {
      Settings.setLaunchAtLogin(checked);
      launch.set(checked);
      error.set("");
    } catch (e) {
      error.set(errorText(e));
    }
  };
  return (
    <Section title="General" error={error() || null} note="Arranca oculta en la bandeja, lista para Ctrl+Shift+Espacio.">
      <Row title="Abrir al iniciar sesión">
        <Toggle checked={launch()} onChange={toggle} label="Abrir al iniciar sesión" />
      </Row>
    </Section>
  );
}

function AboutSection() {
  const cli = signal<string | null | undefined>(undefined);
  Settings.claudeVersion().then((version) => cli.set(version));
  const updates = () => {
    const s = updateState();
    if (s.kind === "checking") return "Buscando…";
    if (s.kind === "current") return "Tienes la última versión";
    if (s.kind === "available") return `Hay una nueva: ${s.update.version} (arriba, «Actualizar»)`;
    if (s.kind === "downloading" || s.kind === "installing") return `Actualizando a ${s.update.version}…`;
    if (s.kind === "error") return s.message;
    return "Se comprueba sola al abrir y cada 6 horas";
  };
  return (
    <Section title="Acerca de">
      <Row title={`Maka Tutor ${currentVersion() ?? "(desarrollo)"}`} detail={updates()}>
        <TextButton
          text="Buscar"
          onPress={() => void checkUpdates()}
          disabled={!currentVersion() || updateState().kind === "checking"}
        />
      </Row>
      <Divider />
      <Row title="CLI de Claude">
        <Text class="text-[13px] text-white/55" style={{ color: cli() === null ? "#FF9F0A" : undefined }}>
          {cli() === undefined ? "Comprobando…" : cli() ? `v${cli()}` : "No está en el PATH"}
        </Text>
      </Row>
    </Section>
  );
}


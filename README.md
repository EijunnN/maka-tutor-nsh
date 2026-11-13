# Maka Tutor NSH

Prueba de concepto de Maka Tutor sobre [NSH](https://nsh.dev) (v0.5.0) en lugar de Electron. Valida primero lo que
NSH no trae de serie; el Maka Tutor de Electron sigue intacto en `../maka-tutor`.

## Qué valida

| Pieza | Cómo | Estado |
|---|---|---|
| Captura de pantalla | Rust, GDI `BitBlt` del monitor bajo el cursor → JPEG ≤1568 px en base64 (`src/screen.rs`, `Screen.capture()`) | ✓ test: 1920×1080 → 1568×882, ~270 KB, captura juegos |
| Recorte de región | `Screen.crop` recorta en Rust la última captura (fracciones, sin líos de DPI); `Selector.tsx` es una ventana `overlay` transparente sobre ese monitor: arrastrar recorta, clic = pantalla entera, Esc cancela | ✓ tests de recorte; probar a mano |
| Historial | `history.ts`: un JSON por conversación en `<dataDir>/conversations` (sin las imágenes); buscar, abrir, borrar. Al retomar una, su transcripción va delante de la siguiente pregunta | ✓ helpers probados; probar a mano |
| Ajustes | `SettingsPage.tsx` (⚙ en la cabecera): modelo (Storage de NSH), API key, arrancar con la sesión, versión del CLI. Cambiar modelo o key reinicia `claude` conservando la conversación | probar a mano |
| API key cifrada | Rust (`src/settings.rs`): Administrador de credenciales de Windows; la key nunca vuelve a JS, `ApiKey.load()` la pone en el entorno del proceso y NSH la pasa a `claude` (`ANTHROPIC_API_KEY` concedida) | ✓ test: guardar, leer, borrar |
| Arranque con la sesión | Rust: valor en `HKCU\…\Run` con este ejecutable (en `nsh run` es el host de desarrollo: probarlo con la app empaquetada) | compila; probar a mano |
| Audio del sistema | Rust (`src/audio.rs`): WASAPI loopback de una app y sus hijos (`ActivateAudioInterfaceAsync`, process loopback) o de todo el equipo; PCM s16 estéreo 48 kHz. Sin micrófono | ✓ test con tono real: equipo y proceso lo oyen, otro proceso no |
| Modo reunión | Rust (`src/meeting.rs`): hilo captura → WebSocket de Deepgram Nova-3 (tungstenite + SChannel), reintentos, silencio de relleno, la app elegida vigilada; la clave de Deepgram no sale de Rust. JS (`meeting.ts`, `MeetingPage.tsx`, 🎙): Teams, Discord o cualquier app; documentos .md de contexto (se recuerdan; el prompt va por `--system-prompt-file`); intervenciones, respuestas de Claude de una en una (proceso persistente, `--effort low`), capturas y contexto pegado | ✓ tests de lógica (bun) y rechazo real de clave falsa; probar con una reunión |
| Fuera de capturas | Rust, `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` en todas las ventanas del proceso (`Screen.protect(true)`) | compila; probar a mano |
| Claude sin Node | CLI `claude` en `stream-json` con `process.spawn` de NSH, imagen por stdin (`claude.ts`) | ✓ probado por CLI: streaming y visión |
| Panel flotante | `level: "floating"`, sin barra de tareas, en todos los escritorios, arrastrable | probar a mano |
| Atajo global | `GlobalShortcut` `Ctrl+Shift+Espacio`: captura y muestra el panel | probar a mano |
| Bandeja | `Tray` con menú: capturar, mostrar/ocultar, modo fantasma, nueva conversación, salir | probar a mano |
| Click-through | Modo fantasma: `pointerEvents: "none"` (permiso `windows.overlay`) | probar a mano |
| Markdown en streaming | `TextView` de `nsh/base` con `streaming: true` (sustituye a react-markdown) | probar a mano |

Quién habla (modo reunión): Deepgram separa las voces (`diarize=true`: «Hablante 1», «Hablante 2»…; se renombran
tocando el nombre y Claude recibe el cambio) y, con «Incluir mi micrófono», el micrófono va en un canal propio
(`multichannel=true`: canal 0 el usuario, canal 1 lo demás; `audio::start_with_microphone` los mezcla), así que lo
que dice el usuario sale como «Tú», sin pedir respuesta. Claude responde a la última voz pendiente.

Varias capturas por pregunta (chat y reunión): cada captura se suma a las anteriores, hasta 10; el mensaje va a `claude` por trozos (`claude-io.ts`), porque el stdin de NSH deja esperar como mucho 1 MiB.

## Publicar una versión

```sh
bun scripts/release.ts patch      # o minor, major, o una versión: 0.3.0
```

Sube `version` y `build` en `nsh.json`, hace commit y el tag `vX.Y.Z` y los sube. GitHub Actions
(`.github/workflows/release.yml`) pasa los tests, empaqueta Windows (`windows-latest`) y Linux (`ubuntu-24.04`), firma el
manifiesto de actualización (`latest.json`) con el secreto `NSH_UPDATE_KEY` y crea el Release. Las apps instaladas lo
ven solas (`nsh.json` `"updater"`: `github` + `publicKey`): al abrir y cada 6 horas, o con «Buscar actualizaciones» en
la bandeja o en Ajustes, y muestran «Versión X disponible · Actualizar», que descarga, comprueba la firma, reemplaza la
app y la reinicia. En cada push a `master` el mismo workflow solo prueba y empaqueta.

La clave de firma se creó con `nsh keygen`; la parte secreta está en el secreto `NSH_UPDATE_KEY` del repositorio (y una
copia fuera del repo, en `~/.maka-tutor-nsh-keys/`). Si se pierde, las apps instaladas no aceptarán versiones firmadas
con otra: habría que instalar a mano una versión con la nueva `publicKey`.

## Uso

```sh
nsh run          # host de Windows con hot reload (la primera vez compila ~3 min)
nsh check        # cargo check + tipos de App.tsx contra las declaraciones generadas
cargo test       # tests de Rust (captura real del escritorio y de audio: suena un tono)
cargo test -- --ignored        # + conexión real con Deepgram (clave falsa → rechazo)
bun test tests/meeting.test.ts # lógica del modo reunión, con Rust y Claude simulados
nsh package --target windows
```

La app arranca oculta en la bandeja. `Ctrl+Shift+Espacio` captura el monitor donde está el cursor y abre el panel.

## Linux

La app abre la ventana directamente en la reunión.

- Captura: en X11 se lee el monitor bajo el puntero (`x11rb`); en Wayland se pide al portal de capturas del escritorio
  (`org.freedesktop.portal.Screenshot` por D-Bus con `zbus`; GNOME puede pedir permiso la primera vez) y, sin portal,
  a `grim` (Sway, Hyprland). La ventana se esconde antes de capturar (en Linux no se puede excluir de las capturas) y
  el selector de región es una ventana a pantalla completa con la propia captura de fondo: allí las ventanas
  `overlay` dejan pasar los clics. `xvfb-run -a -s "-screen 0 1280x720x24" cargo test -- --ignored` prueba la de X11.

- Audio: `parec`/`pactl` (PulseAudio o PipeWire con `pipewire-pulse`). Una app = sus flujos de reproducción (los de su
  árbol de procesos o, en Flatpak, los que llevan su nombre), mezclados; se buscan de nuevo cada 1,5 s. Teams va
  por el navegador (no hay app oficial para Linux); Discord, la app.
- Claves: `secret-tool` (llavero del escritorio); sin él, `~/.config/maka-tutor-nsh/keys/` con permisos 0600.
- Arranque con la sesión: `~/.config/autostart/com.eijunnn.makatutornsh.desktop`.
- Requisitos donde corre: Ubuntu 24.04+ o equivalente (glibc 2.39, GTK 4.14), `libwebkitgtk-6.0-4`,
  `pulseaudio-utils`, `libsecret-tools` y `claude` en el `PATH`. La bandeja necesita en GNOME la extensión
  AppIndicator.
- Compilar (en Linux o WSL con Ubuntu 24.04): `nsh package App.tsx --target linux` → `.nsh/out/Maka Tutor NSH.tar.gz`.
  `cargo test -- --include-ignored` incluye una captura real de un tono con `paplay`.

## Notas

- Requiere Rust ≥ 1.97 y el CLI `claude` nativo en el `PATH` (`~/.local/bin/claude.exe`), con sesión iniciada.
- `claude` se lanza sin CLAUDE.md, reglas, skills ni MCP del usuario (`--setting-sources ""`, `--strict-mcp-config`,
  `--disable-slash-commands`): el contexto pasa de ~48k a ~3k tokens. No se usa `--bare` porque exige
  `ANTHROPIC_API_KEY` y no usa el OAuth.
- El stdin de un proceso de NSH admite como mucho 1 MiB en cola: por eso la captura va en JPEG y reescalada.
- Al declarar `capabilities` en `nsh.json`, todo lo que no se lista queda denegado.
- Cristal: ventana sin marco con el acrílico de Windows 11 (`"frame": "none"`, `"backdrop": "hud"` en `nsh.json`).
  Solo se ve en la app empaquetada (`nsh package --target windows`, en `.nsh/out/`): con `nsh run` la ventana se
  crea antes de leer `nsh.json` y sale opaca. No usar `"transparent": true`: en Windows quita las esquinas y la sombra.

# Maka Tutor NSH

Prueba de concepto de Maka Tutor sobre [NSH](https://nsh.dev) (v0.5.0) en lugar de Electron. Valida primero lo que
NSH no trae de serie; el Maka Tutor de Electron sigue intacto en `../maka-tutor`.

## Qué valida

| Pieza | Cómo | Estado |
|---|---|---|
| Captura de pantalla | Rust, GDI `BitBlt` del monitor bajo el cursor → JPEG ≤1568 px en base64 (`src/screen.rs`, `Screen.capture()`) | ✓ test: 1920×1080 → 1568×882, ~270 KB, captura juegos |
| Recorte de región | `Screen.crop` recorta en Rust la última captura (fracciones, sin líos de DPI); `Selector.tsx` es una ventana `overlay` transparente sobre ese monitor: arrastrar recorta, clic = pantalla entera, Esc cancela | ✓ tests de recorte; probar a mano |
| Historial | `history.ts`: un JSON por conversación en `<dataDir>/conversations` (sin las imágenes); buscar, abrir, borrar. Al retomar una, su transcripción va delante de la siguiente pregunta | ✓ helpers probados; probar a mano |
| Fuera de capturas | Rust, `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` en todas las ventanas del proceso (`Screen.protect(true)`) | compila; probar a mano |
| Claude sin Node | CLI `claude` en `stream-json` con `process.spawn` de NSH, imagen por stdin (`claude.ts`) | ✓ probado por CLI: streaming y visión |
| Panel flotante | `level: "floating"`, sin barra de tareas, en todos los escritorios, arrastrable | probar a mano |
| Atajo global | `GlobalShortcut` `Ctrl+Shift+Espacio`: captura y muestra el panel | probar a mano |
| Bandeja | `Tray` con menú: capturar, mostrar/ocultar, modo fantasma, nueva conversación, salir | probar a mano |
| Click-through | Modo fantasma: `pointerEvents: "none"` (permiso `windows.overlay`) | probar a mano |
| Markdown en streaming | `TextView` de `nsh/base` con `streaming: true` (sustituye a react-markdown) | probar a mano |

Pendiente: audio del sistema (WASAPI loopback) para el modo reunión.

## Uso

```sh
nsh run          # host de Windows con hot reload (la primera vez compila ~3 min)
nsh check        # cargo check + tipos de App.tsx contra las declaraciones generadas
cargo test       # tests de Rust (captura real del escritorio)
nsh package --target windows
```

La app arranca oculta en la bandeja. `Ctrl+Shift+Espacio` captura el monitor donde está el cursor y abre el panel.

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

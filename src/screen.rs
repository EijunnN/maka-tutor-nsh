//! `Screen`: captura del monitor bajo el cursor (GDI `BitBlt`, reescalada y
//! en JPEG para mandarla a Claude) y exclusión de las ventanas de la app de
//! las capturas (`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`), el
//! equivalente de `setContentProtection` de Electron.

use nsh_core::prelude::*;

/// Lado largo máximo de la imagen enviada: lo que Claude aprovecha sin
/// reescalarla él.
const MAX_EDGE: u32 = 1568;

/// Calidad JPEG: mantiene la línea de stream-json bien por debajo del MiB que
/// admite el stdin de un proceso de NSH.
const JPEG_QUALITY: u8 = 80;

/// Una captura de pantalla.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Shot {
    /// La imagen en JPEG, en base64 (sin prefijo `data:`).
    pub data: String,
    /// Ancho de la imagen enviada, en píxeles.
    pub width: u32,
    /// Alto de la imagen enviada, en píxeles.
    pub height: u32,
    /// Ancho original del monitor, en píxeles.
    pub source_width: u32,
    /// Alto original del monitor, en píxeles.
    pub source_height: u32,
    /// Esquina del monitor capturado en la pantalla virtual, en píxeles: con
    /// ella la app sabe sobre qué display abrir el selector de región.
    pub source_x: i32,
    /// Ídem, vertical.
    pub source_y: i32,
}

/// La última captura a tamaño completo, para recortarla sin volver a capturar
/// (el selector de región tapa la pantalla mientras el usuario elige).
struct Frame {
    rgb: Vec<u8>,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
}

static LAST: std::sync::Mutex<Option<Frame>> = std::sync::Mutex::new(None);

/// La pantalla: capturarla y esconder la app de las capturas.
#[module]
pub struct Screen;

#[module]
impl Screen {
    /// Captura el monitor donde está el cursor. Las ventanas excluidas con
    /// `protect(true)` no salen en ella.
    pub fn capture() -> Result<Shot, String> {
        let frame = imp::grab()?;
        let shot = encode(frame.rgb.clone(), frame.width, frame.height, frame.x, frame.y)?;
        *LAST.lock().map_err(|_| "captura bloqueada")? = Some(frame);
        Ok(shot)
    }

    /// Recorta la última captura de `capture()`: `x`, `y`, `width` y `height`
    /// son fracciones (0 a 1) de su ancho y alto, así que no dependen del
    /// escalado del monitor. Lanza si no hay captura o la región es vacía.
    pub fn crop(x: f64, y: f64, width: f64, height: f64) -> Result<Shot, String> {
        let last = LAST.lock().map_err(|_| "captura bloqueada")?;
        let frame = last.as_ref().ok_or("no hay ninguna captura que recortar")?;
        let (rgb, w, h) = crop_rgb(frame, x, y, width, height)?;
        encode(rgb, w, h, frame.x, frame.y)
    }

    /// Excluye (`true`) o vuelve a incluir (`false`) todas las ventanas de la
    /// app en capturas, grabaciones y screen sharing; devuelve cuántas
    /// ventanas cambió.
    pub fn protect(exclude: bool) -> u32 {
        imp::protect(exclude)
    }
}

/// Los píxeles de `frame` dentro de la región en fracciones, ya acotada a la
/// imagen.
fn crop_rgb(frame: &Frame, x: f64, y: f64, width: f64, height: f64) -> Result<(Vec<u8>, u32, u32), String> {
    let clamp = |v: f64| if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 };
    let (fw, fh) = (frame.width as f64, frame.height as f64);
    let left = (clamp(x) * fw).floor() as u32;
    let top = (clamp(y) * fh).floor() as u32;
    let right = (clamp(x + width) * fw).ceil() as u32;
    let bottom = (clamp(y + height) * fh).ceil() as u32;
    if right <= left + 1 || bottom <= top + 1 {
        return Err("la región está vacía".into());
    }
    let (w, h) = (right - left, bottom - top);
    let stride = frame.width as usize * 3;
    let mut rgb = Vec::with_capacity(w as usize * h as usize * 3);
    for row in top..bottom {
        let start = row as usize * stride + left as usize * 3;
        rgb.extend_from_slice(&frame.rgb[start..start + w as usize * 3]);
    }
    Ok((rgb, w, h))
}

/// Reescala a `MAX_EDGE` y codifica en JPEG base64.
fn encode(rgb: Vec<u8>, width: u32, height: u32, source_x: i32, source_y: i32) -> Result<Shot, String> {
    use base64::Engine as _;
    use image::{DynamicImage, ImageEncoder, RgbImage, codecs::jpeg::JpegEncoder, imageops::FilterType};

    let source = RgbImage::from_raw(width, height, rgb).ok_or("captura con tamaño inválido")?;
    let scale = (MAX_EDGE as f32 / width.max(height) as f32).min(1.0);
    let image = if scale < 1.0 {
        let w = ((width as f32) * scale).round() as u32;
        let h = ((height as f32) * scale).round() as u32;
        DynamicImage::ImageRgb8(source).resize_exact(w, h, FilterType::Triangle).into_rgb8()
    } else {
        source
    };
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
        .write_image(image.as_raw(), image.width(), image.height(), image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("no se pudo codificar la captura: {e}"))?;
    Ok(Shot {
        data: base64::engine::general_purpose::STANDARD.encode(jpeg),
        width: image.width(),
        height: image.height(),
        source_width: width,
        source_height: height,
        source_x,
        source_y,
    })
}

#[cfg(windows)]
mod imp {
    use super::Frame;
    use windows::Win32::{
        Foundation::{HWND, LPARAM, POINT},
        Graphics::Gdi::{
            BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleBitmap,
            CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits,
            GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromPoint, ReleaseDC,
            SRCCOPY, SelectObject,
        },
        System::Threading::GetCurrentProcessId,
        UI::WindowsAndMessaging::{
            EnumWindows, GetCursorPos, GetWindowThreadProcessId, SetWindowDisplayAffinity,
            WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
        },
    };
    use windows::core::BOOL;

    pub(super) fn grab() -> Result<Frame, String> {
        // SAFETY: llamadas GDI sobre DCs y bitmaps propios, liberados antes de salir.
        unsafe {
            let mut cursor = POINT::default();
            GetCursorPos(&mut cursor).map_err(|e| format!("GetCursorPos: {e}"))?;
            let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO {
                cbSize: size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if !GetMonitorInfoW(monitor, &mut info).as_bool() {
                return Err("GetMonitorInfoW falló".into());
            }
            let r = info.rcMonitor;
            let (x, y) = (r.left, r.top);
            let (w, h) = (r.right - r.left, r.bottom - r.top);

            let screen = GetDC(None);
            let memory = CreateCompatibleDC(Some(screen));
            let bitmap = CreateCompatibleBitmap(screen, w, h);
            let previous = SelectObject(memory, bitmap.into());
            let blit = BitBlt(memory, 0, 0, w, h, Some(screen), x, y, SRCCOPY | CAPTUREBLT);

            let mut header = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // de arriba abajo
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bgra = vec![0u8; (w * h * 4) as usize];
            let lines = GetDIBits(
                memory,
                bitmap,
                0,
                h as u32,
                Some(bgra.as_mut_ptr().cast()),
                &mut header,
                DIB_RGB_COLORS,
            );

            SelectObject(memory, previous);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);

            blit.map_err(|e| format!("BitBlt: {e}"))?;
            if lines == 0 {
                return Err("GetDIBits no copió nada".into());
            }
            let rgb = bgra
                .chunks_exact(4)
                .flat_map(|p| [p[2], p[1], p[0]])
                .collect();
            Ok(Frame { rgb, width: w as u32, height: h as u32, x, y })
        }
    }

    pub(super) fn protect(exclude: bool) -> u32 {
        struct State {
            pid: u32,
            exclude: bool,
            changed: u32,
        }
        unsafe extern "system" fn each(hwnd: HWND, state: LPARAM) -> BOOL {
            // SAFETY: `state` es el `&mut State` que `protect` pasa a EnumWindows.
            let state = unsafe { &mut *(state.0 as *mut State) };
            let mut pid = 0;
            // SAFETY: consulta de una ventana que EnumWindows acaba de dar.
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            if pid == state.pid {
                let affinity = if state.exclude { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
                // SAFETY: la ventana es de este proceso.
                if unsafe { SetWindowDisplayAffinity(hwnd, affinity) }.is_ok() {
                    state.changed += 1;
                }
            }
            true.into()
        }
        let mut state = State {
            // SAFETY: sin precondiciones.
            pid: unsafe { GetCurrentProcessId() },
            exclude,
            changed: 0,
        };
        // SAFETY: `each` solo usa `state` mientras dura la llamada.
        let _ = unsafe { EnumWindows(Some(each), LPARAM(&mut state as *mut State as isize)) };
        state.changed
    }
}

#[cfg(test)]
mod tests {
    use super::{Frame, crop_rgb};

    fn frame() -> Frame {
        // 4×2, cada píxel con su índice en los tres canales.
        let rgb = (0..8u8).flat_map(|i| [i, i, i]).collect();
        Frame { rgb, width: 4, height: 2, x: 0, y: 0 }
    }

    #[test]
    fn recorta_la_mitad_derecha() {
        let (rgb, w, h) = crop_rgb(&frame(), 0.5, 0.0, 0.5, 1.0).unwrap();
        assert_eq!((w, h), (2, 2));
        assert_eq!(rgb, vec![2, 2, 2, 3, 3, 3, 6, 6, 6, 7, 7, 7]);
    }

    #[test]
    fn acota_regiones_fuera_de_la_imagen() {
        let (_, w, h) = crop_rgb(&frame(), -1.0, -1.0, 5.0, 5.0).unwrap();
        assert_eq!((w, h), (4, 2));
    }

    #[test]
    fn rechaza_regiones_vacias() {
        assert!(crop_rgb(&frame(), 0.5, 0.5, 0.0, 0.0).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn lee_la_ruta_de_la_uri_del_portal() {
        use std::path::PathBuf;
        assert_eq!(
            super::imp::file_path("file:///home/ana/Im%C3%A1genes/Captura%20de%20pantalla.png"),
            Some(PathBuf::from("/home/ana/Imágenes/Captura de pantalla.png"))
        );
        assert_eq!(super::imp::file_path("https://example.com/a.png"), None);
    }

    /// Con un servidor X (`xvfb-run -a -s "-screen 0 1280x720x24" cargo test -- --ignored`).
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore]
    fn captura_la_pantalla_x11() {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::{ConnectionExt as _, CreateWindowAux, WindowClass};

        // Una ventana azul (#3366cc) a pantalla completa: la captura debe verla.
        let (conn, screen) = x11rb::connect(None).expect("servidor X");
        let root = &conn.setup().roots[screen];
        let window = conn.generate_id().unwrap();
        conn.create_window(
            x11rb::COPY_DEPTH_FROM_PARENT,
            window,
            root.root,
            0,
            0,
            1280,
            720,
            0,
            WindowClass::INPUT_OUTPUT,
            0,
            &CreateWindowAux::new().background_pixel(0x3366cc).override_redirect(1),
        )
        .unwrap();
        conn.map_window(window).unwrap();
        conn.flush().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));

        let frame = super::imp::x11_grab().expect("captura X11");
        assert_eq!((frame.width, frame.height), (1280, 720));
        assert_eq!(frame.rgb.len(), 1280 * 720 * 3);
        let center = (360 * 1280 + 640) * 3;
        assert_eq!(&frame.rgb[center..center + 3], &[0x33, 0x66, 0xcc], "el píxel central es el azul de la ventana");
        let shot = super::encode(frame.rgb, frame.width, frame.height, 0, 0).expect("JPEG");
        assert_eq!((shot.width, shot.height), (1280, 720));
    }
}

/// Linux. En una sesión Wayland (GNOME, KDE) solo el escritorio puede leer la
/// pantalla: se le pide al portal de capturas (`org.freedesktop.portal.
/// Screenshot`, la primera vez puede pedir permiso) y, si no hay portal, a
/// `grim` (Sway, Hyprland). En X11 se lee directamente el monitor donde está
/// el puntero. No hay forma de excluir ventanas de las capturas: la app se
/// esconde antes de capturar (`App.tsx`).
#[cfg(target_os = "linux")]
mod imp {
    use super::Frame;
    use std::time::Duration;

    pub(super) fn grab() -> Result<Frame, String> {
        let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty());
        let x11 = std::env::var_os("DISPLAY").is_some_and(|v| !v.is_empty());
        let mut errors = Vec::new();
        // En Wayland, X11 (XWayland) solo ve las ventanas X: el resto sale negro.
        let attempts: &[(&str, fn() -> Result<Frame, String>)] = if wayland {
            &[("portal", portal), ("grim", grim)]
        } else {
            &[("X11", x11_grab), ("portal", portal)]
        };
        for (name, attempt) in attempts {
            if *name == "X11" && !x11 {
                continue;
            }
            match attempt() {
                Ok(frame) => return Ok(frame),
                Err(e) => errors.push(format!("{name}: {e}")),
            }
        }
        Err(format!("no se pudo capturar la pantalla ({})", errors.join("; ")))
    }

    pub(super) fn protect(_exclude: bool) -> u32 {
        0
    }

    /// El monitor bajo el puntero, leído del servidor X.
    pub(super) fn x11_grab() -> Result<Frame, String> {
        use x11rb::connection::Connection;
        use x11rb::protocol::randr::ConnectionExt as _;
        use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat, ImageOrder};

        let (conn, screen) = x11rb::connect(None).map_err(|e| e.to_string())?;
        let setup = conn.setup();
        let root = &setup.roots[screen];
        let pointer = conn.query_pointer(root.root).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?;
        let (px, py) = (pointer.root_x as i32, pointer.root_y as i32);
        // El monitor que contiene el puntero (RandR); si no, la pantalla entera.
        let mut area = (0i32, 0i32, root.width_in_pixels as u32, root.height_in_pixels as u32);
        if let Ok(cookie) = conn.randr_get_monitors(root.root, true)
            && let Ok(reply) = cookie.reply()
            && let Some(m) = reply.monitors.iter().find(|m| {
                let (x, y) = (m.x as i32, m.y as i32);
                px >= x && py >= y && px < x + m.width as i32 && py < y + m.height as i32
            })
        {
            area = (m.x as i32, m.y as i32, m.width as u32, m.height as u32);
        }
        let (x, y, width, height) = area;
        let image = conn
            .get_image(ImageFormat::Z_PIXMAP, root.root, x as i16, y as i16, width as u16, height as u16, !0)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        let bpp = setup
            .pixmap_formats
            .iter()
            .find(|f| f.depth == image.depth)
            .map(|f| f.bits_per_pixel)
            .unwrap_or(32);
        if bpp != 32 || image.data.len() < (width * height * 4) as usize {
            return Err(format!("formato de pantalla no compatible ({} bits por píxel)", bpp));
        }
        // 32 bits por píxel: BGRX en orden LSB (lo habitual), XRGB en MSB.
        let lsb = setup.image_byte_order == ImageOrder::LSB_FIRST;
        let mut rgb = Vec::with_capacity((width * height * 3) as usize);
        for px in image.data.chunks_exact(4).take((width * height) as usize) {
            if lsb {
                rgb.extend_from_slice(&[px[2], px[1], px[0]]);
            } else {
                rgb.extend_from_slice(&[px[1], px[2], px[3]]);
            }
        }
        Ok(Frame { rgb, width, height, x, y })
    }

    /// El portal de capturas del escritorio (GNOME, KDE, wlroots con
    /// xdg-desktop-portal-wlr): guarda un PNG y devuelve su URI.
    fn portal() -> Result<Frame, String> {
        // En su propio hilo, con tope: el escritorio puede pedir permiso al usuario.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("maka-portal".into())
            .spawn(move || {
                let _ = tx.send(portal_uri());
            })
            .map_err(|e| e.to_string())?;
        let uri = rx
            .recv_timeout(Duration::from_secs(120))
            .map_err(|_| "el escritorio no respondió a la captura".to_string())??;
        let path = file_path(&uri).ok_or_else(|| format!("respuesta inesperada del portal: {uri}"))?;
        let bytes = std::fs::read(&path).map_err(|e| format!("no se pudo leer la captura: {e}"))?;
        // La guardó el escritorio solo para nosotros: no la dejamos en Imágenes.
        let _ = std::fs::remove_file(&path);
        decode_png(&bytes)
    }

    fn portal_uri() -> Result<String, String> {
        use std::collections::HashMap;
        use zbus::blocking::{Connection, Proxy};
        use zbus::zvariant::{OwnedValue, Value};

        let conn = Connection::session().map_err(|e| format!("sin bus de sesión: {e}"))?;
        let token = format!(
            "maka{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
        );
        let sender = conn
            .unique_name()
            .ok_or("sin nombre en el bus")?
            .as_str()
            .trim_start_matches(':')
            .replace('.', "_");
        // La respuesta llega como señal en un objeto de ruta conocida: se escucha
        // antes de pedir la captura para no perderla.
        let request_path = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
        let request = Proxy::new(&conn, "org.freedesktop.portal.Desktop", request_path.as_str(), "org.freedesktop.portal.Request")
            .map_err(|e| e.to_string())?;
        let mut responses = request.receive_signal("Response").map_err(|e| e.to_string())?;
        let screenshot = Proxy::new(
            &conn,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.Screenshot",
        )
        .map_err(|e| e.to_string())?;
        let mut options: HashMap<&str, Value> = HashMap::new();
        options.insert("handle_token", Value::from(token.as_str()));
        options.insert("interactive", Value::from(false));
        let _: zbus::zvariant::OwnedObjectPath = screenshot
            .call("Screenshot", &("", options))
            .map_err(|e| format!("el escritorio no tiene portal de capturas: {e}"))?;
        let message = responses.next().ok_or("el portal no respondió")?;
        let (code, results): (u32, HashMap<String, OwnedValue>) =
            message.body().deserialize().map_err(|e| e.to_string())?;
        match code {
            0 => {}
            1 => return Err("captura cancelada o permiso denegado".into()),
            _ => return Err("el portal no pudo capturar".into()),
        }
        let uri = results.get("uri").ok_or("el portal no devolvió la captura")?;
        String::try_from(uri.try_clone().map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    }

    /// `grim` (Sway, Hyprland y otros compositores wlroots): PNG por stdout.
    fn grim() -> Result<Frame, String> {
        let output = std::process::Command::new("grim")
            .args(["-t", "png", "-"])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "no está instalado".into() } else { e.to_string() })?;
        if !output.status.success() {
            return Err("grim falló".into());
        }
        decode_png(&output.stdout)
    }

    fn decode_png(bytes: &[u8]) -> Result<Frame, String> {
        let image = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
            .map_err(|e| format!("no se pudo leer la captura: {e}"))?
            .into_rgb8();
        let (width, height) = image.dimensions();
        Ok(Frame { rgb: image.into_raw(), width, height, x: 0, y: 0 })
    }

    /// `file:///ruta%20con%20espacios.png` → la ruta.
    pub(super) fn file_path(uri: &str) -> Option<std::path::PathBuf> {
        let rest = uri.strip_prefix("file://")?;
        let bytes = rest.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%'
                && i + 2 < bytes.len()
                && let Ok(v) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?, 16)
            {
                out.push(v);
                i += 3;
            } else {
                out.push(bytes[i]);
                i += 1;
            }
        }
        Some(std::path::PathBuf::from(String::from_utf8(out).ok()?))
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    use super::Frame;

    pub(super) fn grab() -> Result<Frame, String> {
        Err("la captura de pantalla solo está implementada en Windows y Linux".into())
    }

    pub(super) fn protect(_exclude: bool) -> u32 {
        0
    }
}

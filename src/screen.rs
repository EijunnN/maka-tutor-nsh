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
}

#[cfg(not(windows))]
mod imp {
    use super::Frame;

    pub(super) fn grab() -> Result<Frame, String> {
        Err("la captura de pantalla solo está implementada en Windows".into())
    }

    pub(super) fn protect(_exclude: bool) -> u32 {
        0
    }
}

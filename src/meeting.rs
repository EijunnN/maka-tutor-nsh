//! `Meeting`: escucha de reuniones. Un hilo captura el audio (`audio`) y lo
//! envía a Deepgram por WebSocket (Nova-3, parciales y fin de frase); los
//! mensajes de Deepgram se acumulan y JS los recoge con `poll()` cada ~100 ms
//! (`meeting.ts` los convierte en intervenciones). La clave de Deepgram se lee
//! aquí, del Administrador de credenciales: nunca pasa por JS.
//!
//! Igual que en el Maka de Electron: tres reintentos de conexión sin reenviar
//! audio viejo (lo que suena durante un corte se pierde y se avisa), 100 ms
//! de silencio cuando WASAPI no entrega nada (para que Deepgram cierre la
//! última frase) y parada si la app elegida se cierra o la red no da abasto.

use crate::audio::{self, Target};
use nsh_core::prelude::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Una aplicación que puede estar reproduciendo la reunión.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Source {
    pub pid: u32,
    pub name: String,
}

/// Lo que JS recoge en cada `poll()`.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Poll {
    /// `idle`, `connecting`, `listening` o `error`.
    pub status: String,
    /// Para mostrar: "Escuchando", "Reconectando…", el error.
    pub message: String,
    /// Nivel del audio (0 a 1).
    pub level: f64,
    /// Mensajes JSON de Deepgram llegados desde el último `poll()`, en orden.
    pub messages: Vec<String>,
    /// Se reconectó desde el último `poll()`: el texto a medias se perdió.
    pub reconnected: bool,
}

/// Lo que comparten el hilo de la escucha y `poll()`.
#[derive(Default)]
struct Shared {
    status: String,
    message: String,
    level: f32,
    messages: Vec<String>,
    reconnected: bool,
}

impl Shared {
    fn set(&mut self, status: &str, message: &str) {
        self.status = status.into();
        self.message = message.into();
    }
}

struct Session {
    stop: Arc<AtomicBool>,
    shared: Arc<Mutex<Shared>>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// Más mensajes sin recoger que esto: JS no está leyendo, se descartan los viejos.
const MAX_PENDING: usize = 400;
/// 100 ms de silencio en PCM s16 estéreo a 48 kHz.
const SILENCE: usize = (audio::RATE as usize / 10) * audio::FRAME_BYTES;

/// La escucha de reuniones.
#[module]
pub struct Meeting;

#[module]
impl Meeting {
    /// Apps que suelen llevar reuniones (Teams, Zoom, Zoho, Discord y
    /// navegadores) que están abiertas: un proceso por app, el de arriba del
    /// árbol.
    pub fn sources() -> Result<Vec<Source>, String> {
        let all = imp::processes()?;
        let pattern = ["zoho", "chrome", "msedge", "firefox", "brave", "opera", "discord", "zoom", "teams"];
        let mut sources: Vec<Source> = all
            .iter()
            .filter(|p| {
                let name = p.name.to_lowercase();
                pattern.iter().any(|k| name.contains(k))
                    && !all.iter().any(|parent| parent.pid == p.parent && parent.name.eq_ignore_ascii_case(&p.name))
            })
            .map(|p| Source { pid: p.pid, name: p.name.clone() })
            .collect();
        sources.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.pid.cmp(&b.pid)));
        Ok(sources)
    }

    /// Empieza a escuchar `pid` (o todo el audio del equipo con `None`) y a
    /// transcribir en `language` (`es`, `en` o `multi`). Detiene la escucha
    /// anterior. Lanza si falta la clave o el idioma no es válido; los fallos
    /// de captura o de red llegan por `poll()`.
    /// Con `microphone`, también el micrófono, en su propio canal: lo que dice
    /// el usuario llega aparte (canal 0).
    pub fn start(pid: Option<u32>, language: String, microphone: bool) -> Result<(), String> {
        if !["es", "en", "multi"].contains(&language.as_str()) {
            return Err("idioma no válido".into());
        }
        let key = crate::settings::deepgram_key().ok_or("Guarda tu clave de Deepgram para transcribir.")?;
        if let Some(pid) = pid
            && !imp::alive(pid)
        {
            return Err("La aplicación ya no está abierta. Actualiza la lista.".into());
        }
        Self::stop();
        let stop = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Mutex::new(Shared::default()));
        shared.lock().unwrap().set("connecting", "Conectando la transcripción…");
        let target = pid.map_or(Target::System, Target::Process);
        {
            let stop = Arc::clone(&stop);
            let shared = Arc::clone(&shared);
            std::thread::Builder::new()
                .name("maka-meeting".into())
                .spawn(move || {
                    let result = listen(target, microphone, &language, &key, &stop, &shared);
                    stop.store(true, Ordering::SeqCst);
                    let mut s = shared.lock().unwrap();
                    s.level = 0.0;
                    match result {
                        Err(message) => s.set("error", &message),
                        Ok(()) => s.set("idle", "Escucha detenida"),
                    }
                })
                .map_err(|e| format!("no se pudo crear el hilo de la escucha: {e}"))?;
        }
        *SESSION.lock().map_err(|_| "escucha bloqueada")? = Some(Session { stop, shared });
        Ok(())
    }

    /// Detiene la escucha (captura y conexión). No hace nada si no hay.
    pub fn stop() {
        if let Ok(mut session) = SESSION.lock()
            && let Some(session) = session.take()
        {
            session.stop.store(true, Ordering::SeqCst);
            session.shared.lock().unwrap().set("idle", "Escucha detenida");
        }
    }

    /// El estado y los mensajes de Deepgram nuevos.
    pub fn poll() -> Poll {
        let Ok(session) = SESSION.lock() else {
            return Poll { status: "idle".into(), ..Default::default() };
        };
        let Some(session) = session.as_ref() else {
            return Poll { status: "idle".into(), ..Default::default() };
        };
        let mut s = session.shared.lock().unwrap();
        Poll {
            status: s.status.clone(),
            message: s.message.clone(),
            level: s.level as f64,
            messages: std::mem::take(&mut s.messages),
            reconnected: std::mem::take(&mut s.reconnected),
        }
    }
}

/// El pid del primer proceso con ese nombre (para los tests).
#[allow(dead_code)]
pub(crate) fn find_process(name: &str) -> Option<u32> {
    imp::processes().ok()?.into_iter().find(|p| p.name.eq_ignore_ascii_case(name)).map(|p| p.pid)
}

/// `diarize`: cada palabra trae el número de la voz que la dijo. Con
/// `microphone`, el canal 0 es el micrófono y el 1 lo demás (`multichannel`:
/// Deepgram los transcribe por separado).
fn deepgram_url(language: &str, microphone: bool) -> String {
    format!(
        "wss://api.deepgram.com/v1/listen?model=nova-3&language={language}&encoding=linear16&sample_rate={}&channels={}\
         &interim_results=true&punctuate=true&smart_format=true&endpointing=400&utterance_end_ms=1000&diarize=true{}",
        audio::RATE,
        audio::CHANNELS,
        if microphone { "&multichannel=true" } else { "" }
    )
}

type Socket = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>;

fn connect(language: &str, microphone: bool, key: &str) -> Result<Socket, String> {
    use tungstenite::client::IntoClientRequest;
    let mut request = deepgram_url(language, microphone).into_client_request().map_err(|e| e.to_string())?;
    request.headers_mut().insert(
        "Authorization",
        format!("Token {key}").parse().map_err(|_| "la clave de Deepgram tiene caracteres no válidos")?,
    );
    let (mut socket, _) = tungstenite::connect(request).map_err(|e| match e {
        tungstenite::Error::Http(response) => match response.status().as_u16() {
            401 | 403 => "Deepgram rechazó la clave. Revísala en el panel de reunión.".to_string(),
            402 => "Tu cuenta de Deepgram no tiene saldo.".to_string(),
            code => format!("Deepgram rechazó la conexión ({code})."),
        },
        other => format!("No se pudo conectar con Deepgram: {other}"),
    })?;
    // Lecturas con tope corto: el mismo hilo lee y envía audio.
    let tcp = match socket.get_mut() {
        tungstenite::stream::MaybeTlsStream::Plain(s) => s,
        tungstenite::stream::MaybeTlsStream::NativeTls(s) => s.get_mut(),
        _ => return Err("tipo de conexión inesperado".into()),
    };
    tcp.set_read_timeout(Some(Duration::from_millis(15))).map_err(|e| e.to_string())?;
    tcp.set_nodelay(true).ok();
    Ok(socket)
}

/// Por qué se dejó de usar una conexión.
enum Drop {
    /// Hay que reconectar.
    Lost,
    /// Fin de la escucha, con o sin error.
    Done(Result<(), String>),
}

fn listen(
    target: Target,
    microphone: bool,
    language: &str,
    key: &str,
    stop: &AtomicBool,
    shared: &Mutex<Shared>,
) -> Result<(), String> {
    // La captura primero: si la app no admite captura, falla antes de gastar
    // conexión con Deepgram.
    let stop_capture = Arc::new(AtomicBool::new(false));
    let (tx, rx) = std::sync::mpsc::channel();
    let started = if microphone {
        audio::start_with_microphone(target, Arc::clone(&stop_capture), tx)
    } else {
        audio::start(target, Arc::clone(&stop_capture), tx)
    };
    started.map_err(|e| {
        if e.starts_with("micrófono") {
            format!("No se pudo abrir tu {e}. Desactiva «Incluir mi micrófono» o revisa el permiso del micrófono.")
        } else if matches!(target, Target::Process(_)) {
            format!("No se pudo capturar esa aplicación ({e}). Prueba «Todo el audio del equipo».")
        } else {
            format!("No se pudo capturar el audio del equipo: {e}")
        }
    })?;
    let _stop_capture = StopOnDrop(stop_capture);

    let mut retries = 0u32;
    loop {
        if stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        let mut socket = match connect(language, microphone, key) {
            Ok(socket) => socket,
            // Clave o saldo: no tiene sentido reintentar.
            Err(e) if e.starts_with("Deepgram rechazó") || e.starts_with("Tu cuenta") => return Err(e),
            Err(e) if retries >= 3 => return Err(e),
            Err(_) => {
                retries += 1;
                backoff(retries, stop, shared, &rx);
                continue;
            }
        };
        shared.lock().unwrap().set("listening", "Escuchando");
        match pump(&mut socket, target, &rx, stop, shared) {
            Drop::Done(result) => {
                let _ = socket.send(tungstenite::Message::text(r#"{"type":"CloseStream"}"#));
                let _ = socket.close(None);
                return result;
            }
            Drop::Lost => {
                retries += 1;
                if retries > 3 {
                    return Err("Se perdió la conexión de transcripción. Vuelve a iniciar la escucha.".into());
                }
                shared.lock().unwrap().reconnected = true;
                backoff(retries, stop, shared, &rx);
            }
        }
    }
}

/// Espera antes de reconectar, tirando el audio que llega mientras tanto.
fn backoff(retries: u32, stop: &AtomicBool, shared: &Mutex<Shared>, rx: &Receiver<Result<Vec<u8>, String>>) {
    shared
        .lock()
        .unwrap()
        .set("connecting", "Reconectando… El audio durante el corte no se transcribe.");
    let until = Instant::now() + Duration::from_millis(500 * 2u64.pow(retries.saturating_sub(1)));
    while Instant::now() < until && !stop.load(Ordering::SeqCst) {
        let _ = rx.recv_timeout(Duration::from_millis(50));
    }
}

/// Envía audio y recoge mensajes hasta que la conexión cae o la escucha acaba.
fn pump(
    socket: &mut Socket,
    target: Target,
    rx: &Receiver<Result<Vec<u8>, String>>,
    stop: &AtomicBool,
    shared: &Mutex<Shared>,
) -> Drop {
    use tungstenite::Message;
    let mut last_audio = Instant::now();
    let mut last_silence = Instant::now();
    let mut last_check = Instant::now();
    let mut unsent = 0usize;
    loop {
        if stop.load(Ordering::SeqCst) {
            return Drop::Done(Ok(()));
        }
        // Audio: todo lo que haya, en un mensaje.
        let mut pcm = Vec::new();
        match rx.recv_timeout(Duration::from_millis(30)) {
            Ok(Ok(chunk)) => pcm.extend(chunk),
            Ok(Err(e)) => return Drop::Done(Err(format!("La captura se interrumpió: {e}"))),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Drop::Done(Err("La captura se cerró inesperadamente. Vuelve a iniciar la escucha.".into()));
            }
        }
        while let Ok(next) = rx.try_recv() {
            match next {
                Ok(chunk) => pcm.extend(chunk),
                Err(e) => return Drop::Done(Err(format!("La captura se interrumpió: {e}"))),
            }
        }
        let now = Instant::now();
        if !pcm.is_empty() {
            last_audio = now;
            shared.lock().unwrap().level = audio::level(&pcm);
        } else if now - last_audio > Duration::from_millis(200) && now - last_silence >= Duration::from_millis(100) {
            // WASAPI no entrega nada sin sonido: el silencio mantiene el reloj
            // de Deepgram y le deja cerrar la última frase.
            last_silence = now;
            pcm = vec![0; SILENCE];
            shared.lock().unwrap().level = 0.0;
        }
        if !pcm.is_empty() {
            unsent += pcm.len();
            match socket.send(Message::binary(pcm)) {
                Ok(()) => unsent = 0,
                Err(tungstenite::Error::Io(e)) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => return Drop::Lost,
            }
            // Más de dos segundos de audio sin poder enviarse: la red no da abasto.
            if unsent > 2 * audio::RATE as usize * audio::FRAME_BYTES {
                return Drop::Done(Err("La conexión es demasiado lenta para audio en directo. Se detuvo la escucha.".into()));
            }
        }

        // Mensajes de Deepgram.
        loop {
            match socket.read() {
                Ok(Message::Text(text)) => {
                    if text.contains(r#""type":"Error""#) {
                        return Drop::Done(Err("Deepgram no pudo transcribir el audio. Revisa tu configuración.".into()));
                    }
                    let mut s = shared.lock().unwrap();
                    s.messages.push(text.to_string());
                    if s.messages.len() > MAX_PENDING {
                        let extra = s.messages.len() - MAX_PENDING;
                        s.messages.drain(..extra);
                    }
                }
                Ok(Message::Close(_)) => return Drop::Lost,
                Ok(_) => {}
                Err(tungstenite::Error::Io(e))
                    if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) =>
                {
                    break;
                }
                Err(_) => return Drop::Lost,
            }
        }

        // La app elegida sigue abierta (sin cambiar en silencio a otra).
        if let Target::Process(pid) = target
            && now - last_check > Duration::from_secs(3)
        {
            last_check = now;
            if !imp::alive(pid) {
                return Drop::Done(Err("La aplicación elegida se cerró. Elige de nuevo la fuente.".into()));
            }
        }
    }
}

struct StopOnDrop(Arc<AtomicBool>);
impl std::ops::Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

struct Process {
    pid: u32,
    parent: u32,
    name: String,
}

#[cfg(windows)]
mod imp {
    use super::Process;
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    pub(super) fn processes() -> Result<Vec<Process>, String> {
        // SAFETY: instantánea propia, recorrida con una estructura propia y cerrada al final.
        unsafe {
            let snapshot =
                CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(|e| format!("no se pudo listar procesos: {e}"))?;
            let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut all = Vec::new();
            let mut ok = Process32FirstW(snapshot, &mut entry).is_ok();
            while ok {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                all.push(Process {
                    pid: entry.th32ProcessID,
                    parent: entry.th32ParentProcessID,
                    name: String::from_utf16_lossy(&entry.szExeFile[..len]),
                });
                ok = Process32NextW(snapshot, &mut entry).is_ok();
            }
            let _ = CloseHandle(snapshot);
            Ok(all)
        }
    }

    pub(super) fn alive(pid: u32) -> bool {
        // SAFETY: handle propio, cerrado antes de salir.
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let mut code = 0u32;
            let running = GetExitCodeProcess(handle, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32;
            let _ = CloseHandle(handle);
            running
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::Process;

    pub(super) fn processes() -> Result<Vec<Process>, String> {
        let all = crate::audio::linux_processes();
        if all.is_empty() {
            return Err("no se pudo leer /proc".into());
        }
        Ok(all.into_iter().map(|(pid, parent, name)| Process { pid, parent, name }).collect())
    }

    pub(super) fn alive(pid: u32) -> bool {
        // Un proceso zombi ya terminó: estado `Z` tras el nombre.
        std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|stat| stat.rfind(')').map(|i| stat[i + 1..].trim_start().starts_with('Z')))
            .is_some_and(|zombie| !zombie)
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    use super::Process;

    pub(super) fn processes() -> Result<Vec<Process>, String> {
        Err("la escucha de reuniones requiere Windows o Linux".into())
    }

    pub(super) fn alive(_pid: u32) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{Meeting, deepgram_url, imp};

    #[test]
    fn la_url_pide_lo_que_entrega_la_captura() {
        let url = deepgram_url("es", false);
        assert!(url.starts_with("wss://api.deepgram.com/v1/listen?model=nova-3&language=es"));
        assert!(url.contains("encoding=linear16&sample_rate=48000&channels=2"));
        assert!(url.contains("interim_results=true") && url.contains("utterance_end_ms=1000"));
        assert!(url.contains("diarize=true") && !url.contains("multichannel"));
        assert!(deepgram_url("en", true).ends_with("&diarize=true&multichannel=true"));
    }

    // Red real: `cargo test -- --ignored`. Una clave falsa debe llegar a
    // Deepgram por TLS y ser rechazada con un mensaje claro.
    #[test]
    #[ignore]
    fn deepgram_rechaza_una_clave_falsa() {
        let error = super::connect("es", true, "0000000000000000000000000000000000000000").err().expect("rechazo");
        assert!(error.starts_with("Deepgram rechazó la clave"), "{error}");
    }

    #[test]
    fn rechaza_idiomas_desconocidos() {
        assert!(Meeting::start(None, "klingon".into(), false).is_err());
    }

    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn este_proceso_esta_vivo_y_aparece_en_la_lista() {
        assert!(imp::alive(std::process::id()));
        assert!(!imp::alive(0xFFFF_FFF0));
        assert!(imp::processes().unwrap().iter().any(|p| p.pid == std::process::id()));
    }
}

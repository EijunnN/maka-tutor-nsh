//! `Meeting`: escucha de reuniones. Un hilo captura el audio (`audio`) y lo
//! envía a AssemblyAI por WebSocket (streaming v3: parciales, fin de turno y
//! voces separadas en directo); los `Turn` se acumulan y JS los recoge con
//! `poll()` cada ~100 ms (`meeting.ts` los convierte en intervenciones). La
//! clave de AssemblyAI se lee aquí, del almacén de claves: nunca pasa por JS.
//!
//! Con micrófono van dos conexiones: la del usuario (canal 0 de la captura) y
//! la de los demás (canal 1), la única que separa voces. Tres reintentos de
//! conexión sin reenviar audio viejo (lo que suena durante un corte se pierde
//! y se avisa), silencio cuando WASAPI no entrega nada (para que AssemblyAI
//! cierre el último turno) y parada si la app elegida se cierra o la red no
//! da abasto.

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
    /// Los `Turn` de AssemblyAI llegados desde el último `poll()`, en orden,
    /// como `{"who":"me"|"others","msg":<Turn>}`.
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
        let mut sources: Vec<Source> = all
            .iter()
            .filter(|p| {
                is_call_app(&p.name)
                    && !all.iter().any(|parent| parent.pid == p.parent && parent.name.eq_ignore_ascii_case(&p.name))
            })
            .map(|p| Source { pid: p.pid, name: p.name.clone() })
            .collect();
        sources.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.pid.cmp(&b.pid)));
        Ok(sources)
    }

    /// Empieza a escuchar `pid` (o todo el audio del equipo con `None`) y a
    /// transcribir (el idioma lo detecta AssemblyAI). Detiene la escucha
    /// anterior. Lanza si falta la clave; los fallos de captura o de red
    /// llegan por `poll()`.
    /// Con `microphone`, también el micrófono, en su propia conexión: lo que
    /// dice el usuario llega aparte (`who: "me"`).
    pub fn start(pid: Option<u32>, microphone: bool) -> Result<(), String> {
        let key = crate::settings::transcription_key().ok_or("Guarda tu clave de AssemblyAI para transcribir.")?;
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
                    let result = listen(target, microphone, &key, &stop, &shared);
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

    /// El estado y los `Turn` nuevos.
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

/// Si el proceso puede llevar una llamada: Teams, Zoom, Zoho, Discord o un
/// navegador, sin sus procesos auxiliares (informes de fallos, ayudantes,
/// WebView2, actualizadores), que no suenan y alargaban la lista.
fn is_call_app(name: &str) -> bool {
    let name = name.to_lowercase();
    let stem = name.strip_suffix(".exe").unwrap_or(&name);
    let apps = ["zoho", "chrome", "msedge", "firefox", "brave", "opera", "discord", "zoom", "teams"];
    let helpers = ["crash", "helper", "webview", "update", "service", "elevation", "notification", "proxy"];
    // «teams» al principio o tras un guion (`ms-teams`, `teams`): no `steamservice`.
    let app = apps.iter().any(|k| if *k == "teams" { stem == "teams" || stem == "msteams" || stem.ends_with("-teams") } else { stem.contains(k) });
    app && !helpers.iter().any(|k| stem.contains(k))
}

/// El pid del primer proceso con ese nombre (para los tests).
#[allow(dead_code)]
pub(crate) fn find_process(name: &str) -> Option<u32> {
    imp::processes().ok()?.into_iter().find(|p| p.name.eq_ignore_ascii_case(name)).map(|p| p.pid)
}

/// El modelo de AssemblyAI: el de tiempo real, multilingüe (detecta español,
/// inglés y otros 30 idiomas sin decírselo) y con voces separadas en directo.
const MODEL: &str = "assemblyai-stt-3-7-realtime";
/// AssemblyAI espera mono a 16 kHz; la captura da estéreo a 48 kHz.
const RATE_OUT: u32 = 16_000;
const DECIMATE: usize = (audio::RATE / RATE_OUT) as usize;
/// Bytes de 100 ms de audio enviado (mono s16 a 16 kHz): cada mensaje lleva
/// entre 20 ms y 1 s, o AssemblyAI cierra la sesión (3007).
const CHUNK_100MS: usize = RATE_OUT as usize / 10 * 2;
const MAX_CHUNK: usize = CHUNK_100MS * 10;

/// Quién suena en una conexión: con micrófono, una para el usuario (`me`, sin
/// separar voces) y otra para los demás (`others`, con `speaker_labels`).
#[derive(Clone, Copy, PartialEq, Debug)]
enum Who {
    Me,
    Others,
}

impl Who {
    fn name(self) -> &'static str {
        match self {
            Who::Me => "me",
            Who::Others => "others",
        }
    }
}

fn assemblyai_url(who: Who) -> String {
    format!(
        "wss://streaming.assemblyai.com/v3/ws?speech_model={MODEL}&encoding=pcm_s16le&sample_rate={RATE_OUT}&speaker_labels={}",
        who == Who::Others
    )
}

type Socket = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>;

/// Un error que no se arregla reintentando (clave, saldo).
fn fatal(error: &str) -> bool {
    error.starts_with("AssemblyAI rechazó") || error.starts_with("Tu cuenta")
}

/// Lo que dice un `Error` (o el cierre) de AssemblyAI, para el usuario.
fn describe_error(text: &str) -> String {
    let lower = text.to_lowercase();
    if lower.contains("insufficient funds") || lower.contains("metronome") {
        "Tu cuenta de AssemblyAI no tiene saldo.".into()
    } else if lower.contains("api key") || lower.contains("unauthorized") || lower.contains("authorization") {
        "AssemblyAI rechazó la clave. Revísala en el panel de reunión.".into()
    } else {
        format!("AssemblyAI cortó la transcripción: {text}")
    }
}

/// Conecta y espera el `Begin`: una clave mala se acepta al conectar y se
/// rechaza justo después con un `Error`.
fn connect(who: Who, key: &str) -> Result<Socket, String> {
    use tungstenite::Message;
    use tungstenite::client::IntoClientRequest;
    let mut request = assemblyai_url(who).into_client_request().map_err(|e| e.to_string())?;
    request.headers_mut().insert(
        "Authorization",
        key.parse().map_err(|_| "la clave de AssemblyAI tiene caracteres no válidos")?,
    );
    let (mut socket, _) = tungstenite::connect(request).map_err(|e| match e {
        tungstenite::Error::Http(response) => match response.status().as_u16() {
            401 | 403 => "AssemblyAI rechazó la clave. Revísala en el panel de reunión.".to_string(),
            code => format!("AssemblyAI rechazó la conexión ({code})."),
        },
        other => format!("No se pudo conectar con AssemblyAI: {other}"),
    })?;
    // Lecturas con tope corto: el mismo hilo lee y envía audio.
    let tcp = match socket.get_mut() {
        tungstenite::stream::MaybeTlsStream::Plain(s) => s,
        tungstenite::stream::MaybeTlsStream::NativeTls(s) => s.get_mut(),
        _ => return Err("tipo de conexión inesperado".into()),
    };
    tcp.set_read_timeout(Some(Duration::from_millis(15))).map_err(|e| e.to_string())?;
    tcp.set_nodelay(true).ok();
    let until = Instant::now() + Duration::from_secs(10);
    while Instant::now() < until {
        match socket.read() {
            Ok(Message::Text(text)) if text.contains(r#""type":"Begin""#) => return Ok(socket),
            Ok(Message::Text(text)) if text.contains(r#""type":"Error""#) => return Err(describe_error(&text)),
            Ok(Message::Close(frame)) => {
                return Err(frame.map_or("AssemblyAI cerró la conexión.".into(), |f| describe_error(&f.reason)));
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(e) => return Err(format!("No se pudo conectar con AssemblyAI: {e}")),
        }
    }
    Err("AssemblyAI no respondió al conectar.".into())
}

/// Una conexión, con lo que aún no se le ha enviado y el diezmado en curso.
struct Link {
    who: Who,
    socket: Socket,
    /// PCM mono s16le a 16 kHz pendiente de enviar.
    out: Vec<u8>,
    /// Suma y cuenta de las muestras a 48 kHz de la muestra a 16 kHz en curso.
    acc: (i32, usize),
}

impl Link {
    fn new(who: Who, socket: Socket) -> Self {
        Link { who, socket, out: Vec::new(), acc: (0, 0) }
    }

    fn push(&mut self, sample: i16) {
        if let Some(value) = decimate(&mut self.acc, sample) {
            self.out.extend_from_slice(&value.to_le_bytes());
        }
    }

    /// Envía lo pendiente en trozos de 100 ms a 1 s. `Err` si la conexión cayó.
    fn flush(&mut self) -> Result<(), ()> {
        while self.out.len() >= CHUNK_100MS {
            let take = self.out.len().min(MAX_CHUNK) / 2 * 2;
            let chunk: Vec<u8> = self.out.drain(..take).collect();
            match self.socket.send(tungstenite::Message::binary(chunk)) {
                Ok(()) => {}
                Err(tungstenite::Error::Io(e)) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => return Err(()),
            }
        }
        Ok(())
    }

    fn close(mut self) {
        let _ = self.socket.send(tungstenite::Message::text(r#"{"type":"Terminate"}"#));
        let _ = self.socket.close(None);
    }
}

/// Una muestra a 48 kHz más; cada tres, su media, a 16 kHz (filtro de caja:
/// basta para voz, que apenas tiene energía por encima de 8 kHz).
fn decimate(acc: &mut (i32, usize), sample: i16) -> Option<i16> {
    acc.0 += sample as i32;
    acc.1 += 1;
    if acc.1 < DECIMATE {
        return None;
    }
    let value = (acc.0 / DECIMATE as i32) as i16;
    *acc = (0, 0);
    Some(value)
}

/// Por qué se dejó de usar una conexión.
enum Drop {
    /// Hay que reconectar.
    Lost,
    /// Fin de la escucha, con o sin error.
    Done(Result<(), String>),
}

fn listen(target: Target, microphone: bool, key: &str, stop: &AtomicBool, shared: &Mutex<Shared>) -> Result<(), String> {
    // La captura primero: si la app no admite captura, falla antes de gastar
    // conexión con AssemblyAI.
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
    let whos: &[Who] = if microphone { &[Who::Me, Who::Others] } else { &[Who::Others] };

    let mut retries = 0u32;
    loop {
        if stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        let mut links = Vec::new();
        let mut failed = None;
        for &who in whos {
            match connect(who, key) {
                Ok(socket) => links.push(Link::new(who, socket)),
                Err(e) => {
                    failed = Some(e);
                    break;
                }
            }
        }
        if let Some(e) = failed {
            links.into_iter().for_each(Link::close);
            if fatal(&e) || retries >= 3 {
                return Err(e);
            }
            retries += 1;
            backoff(retries, stop, shared, &rx);
            continue;
        }
        shared.lock().unwrap().set("listening", "Escuchando");
        let result = pump(&mut links, microphone, target, &rx, stop, shared);
        links.into_iter().for_each(Link::close);
        match result {
            Drop::Done(result) => return result,
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

/// Reparte un trozo estéreo s16le a 48 kHz entre las conexiones: con
/// micrófono, el canal 0 a la del usuario y el 1 a la de los demás; sin él,
/// la media de los dos a la única.
fn split(pcm: &[u8], microphone: bool, links: &mut [Link]) {
    for frame in pcm.chunks_exact(audio::FRAME_BYTES) {
        let l = i16::from_le_bytes([frame[0], frame[1]]);
        let r = i16::from_le_bytes([frame[2], frame[3]]);
        for link in links.iter_mut() {
            let sample = match (microphone, link.who) {
                (true, Who::Me) => l,
                (true, Who::Others) => r,
                (false, _) => ((l as i32 + r as i32) / 2) as i16,
            };
            link.push(sample);
        }
    }
}

/// Envía audio y recoge mensajes hasta que una conexión cae o la escucha acaba.
fn pump(
    links: &mut [Link],
    microphone: bool,
    target: Target,
    rx: &Receiver<Result<Vec<u8>, String>>,
    stop: &AtomicBool,
    shared: &Mutex<Shared>,
) -> Drop {
    use tungstenite::Message;
    let mut last_audio = Instant::now();
    let mut last_silence = Instant::now();
    let mut last_check = Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) {
            return Drop::Done(Ok(()));
        }
        // Audio: todo lo que haya.
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
            split(&pcm, microphone, links);
        } else if now - last_audio > Duration::from_millis(200) && now - last_silence >= Duration::from_millis(100) {
            // WASAPI no entrega nada sin sonido: el silencio mantiene el reloj
            // de AssemblyAI y le deja cerrar el último turno.
            last_silence = now;
            shared.lock().unwrap().level = 0.0;
            for link in links.iter_mut() {
                link.out.resize(link.out.len() + CHUNK_100MS, 0);
            }
        }
        for link in links.iter_mut() {
            if link.flush().is_err() {
                return Drop::Lost;
            }
            // Más de dos segundos sin poder enviarse: la red no da abasto.
            if link.out.len() > 20 * CHUNK_100MS {
                return Drop::Done(Err("La conexión es demasiado lenta para audio en directo. Se detuvo la escucha.".into()));
            }
        }

        // Mensajes de AssemblyAI: los `Turn` van a JS, con quién suena.
        for link in links.iter_mut() {
            loop {
                match link.socket.read() {
                    Ok(Message::Text(text)) => {
                        if text.contains(r#""type":"Error""#) {
                            let error = describe_error(&text);
                            return if fatal(&error) { Drop::Done(Err(error)) } else { Drop::Lost };
                        }
                        if !text.contains(r#""type":"Turn""#) {
                            continue;
                        }
                        let mut s = shared.lock().unwrap();
                        s.messages.push(format!(r#"{{"who":"{}","msg":{}}}"#, link.who.name(), text.as_str()));
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
    use super::{CHUNK_100MS, Who, assemblyai_url, decimate, describe_error, fatal, imp, is_call_app};

    #[test]
    fn la_lista_de_apps_deja_fuera_los_ayudantes() {
        for name in ["ms-teams.exe", "Teams.exe", "Discord.exe", "chrome.exe", "msedge.exe", "brave.exe", "Zoom.exe", "firefox"] {
            assert!(is_call_app(name), "{name}");
        }
        for name in [
            "steamservice.exe",
            "BraveCrashHandler.exe",
            "BraveCrashHandler64.exe",
            "DiscordSystemHelper.exe",
            "msedgewebview2.exe",
            "GoogleUpdate.exe",
            "notepad.exe",
        ] {
            assert!(!is_call_app(name), "{name}");
        }
    }

    #[test]
    fn la_url_pide_lo_que_entrega_la_captura() {
        let others = assemblyai_url(Who::Others);
        assert!(others.starts_with("wss://streaming.assemblyai.com/v3/ws?speech_model=assemblyai-stt-3-7-realtime"));
        assert!(others.contains("encoding=pcm_s16le&sample_rate=16000"));
        assert!(others.ends_with("speaker_labels=true"));
        // La voz del usuario no se separa: es una sola.
        assert!(assemblyai_url(Who::Me).ends_with("speaker_labels=false"));
    }

    #[test]
    fn los_errores_de_clave_y_saldo_no_se_reintentan() {
        let key = describe_error(r#"{"type":"Error","error_code":1008,"error":"Unauthorized Connection: Invalid API key"}"#);
        assert!(key.starts_with("AssemblyAI rechazó la clave") && fatal(&key), "{key}");
        let money = describe_error("Insufficient funds");
        assert!(money.starts_with("Tu cuenta") && fatal(&money), "{money}");
        assert!(!fatal(&describe_error("Session Expired: Maximum session duration exceeded")));
    }

    // Red real: `cargo test -- --ignored`. Una clave falsa debe llegar a
    // AssemblyAI por TLS y ser rechazada con un mensaje claro.
    #[test]
    #[ignore]
    fn assemblyai_rechaza_una_clave_falsa() {
        let error = super::connect(Who::Others, "00000000000000000000000000000000").err().expect("rechazo");
        assert!(error.starts_with("AssemblyAI rechazó la clave"), "{error}");
    }

    #[test]
    fn el_audio_sale_en_mono_a_16_khz_y_en_trozos_validos() {
        let mut acc = (0, 0);
        let out: Vec<i16> = [3, 6, 9, -3, -3, -3, 7].iter().filter_map(|&x| decimate(&mut acc, x)).collect();
        assert_eq!(out, vec![6, -3]);
        assert_eq!(acc, (7, 1), "la muestra suelta espera a las dos siguientes");
        // 100 ms a 16 kHz, mono s16: 3200 bytes, dentro de los 20 ms – 1 s que admite.
        assert_eq!(CHUNK_100MS, 3200);
    }

    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn este_proceso_esta_vivo_y_aparece_en_la_lista() {
        assert!(imp::alive(std::process::id()));
        assert!(!imp::alive(0xFFFF_FFF0));
        assert!(imp::processes().unwrap().iter().any(|p| p.pid == std::process::id()));
    }
}

//! Captura del audio que reproduce el equipo (WASAPI en loopback), en un hilo
//! propio: todo el audio de la salida predeterminada o solo el de un proceso y
//! sus hijos (Teams, Zoom, un navegador; Windows 10 build 20348 o posterior).
//! Entrega PCM s16le estéreo a 48 kHz por un canal, en paquetes de unos 10 ms.
//! El micrófono no se abre.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;

/// Frecuencia de muestreo del PCM entregado.
pub const RATE: u32 = 48_000;
/// Canales del PCM entregado.
pub const CHANNELS: u16 = 2;
/// Bytes por cuadro (s16 × canales).
pub const FRAME_BYTES: usize = 2 * CHANNELS as usize;

/// Qué se captura.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    /// Todo lo que suena por la salida predeterminada.
    System,
    /// Solo un proceso y su árbol de procesos.
    Process(u32),
    /// El micrófono predeterminado (la voz del usuario).
    Microphone,
}

/// Arranca la captura en un hilo y espera a que esté inicializada: devuelve
/// `Err` si WASAPI no la acepta. El hilo termina cuando `stop` se activa o
/// cuando nadie escucha ya el canal; los errores posteriores llegan como
/// `Err` por `out`.
pub fn start(target: Target, stop: Arc<AtomicBool>, out: Sender<Result<Vec<u8>, String>>) -> Result<(), String> {
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let thread_stop = Arc::clone(&stop);
    std::thread::Builder::new()
        .name("maka-audio".into())
        .spawn(move || {
            if let Err(error) = imp::run(target, &thread_stop, &out, &ready_tx) {
                // Si falló al iniciar, `ready` lo cuenta; si no, el canal.
                if ready_tx.send(Err(error.clone())).is_err() {
                    let _ = out.send(Err(error));
                }
            }
        })
        .map_err(|e| format!("no se pudo crear el hilo de audio: {e}"))?;
    match ready_rx.recv_timeout(std::time::Duration::from_secs(10)) {
        Ok(result) => result,
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            Err("la captura de audio no respondió".into())
        }
    }
}

/// Como `start`, pero además con el micrófono: el PCM sigue siendo s16 a 48 kHz
/// con dos canales, ahora el 0 el micrófono (la voz del usuario) y el 1 lo que
/// suena (los demás), cada uno en mono. Así `meeting` manda cada canal a su conexión y separa
/// sin error lo que dice el usuario. Falla si el micrófono no se puede abrir.
pub fn start_with_microphone(
    target: Target,
    stop: Arc<AtomicBool>,
    out: Sender<Result<Vec<u8>, String>>,
) -> Result<(), String> {
    let (mic_tx, mic_rx) = std::sync::mpsc::channel();
    start(Target::Microphone, Arc::clone(&stop), mic_tx).map_err(|e| format!("micrófono: {e}"))?;
    let (sys_tx, sys_rx) = std::sync::mpsc::channel();
    if let Err(e) = start(target, Arc::clone(&stop), sys_tx) {
        stop.store(true, Ordering::SeqCst);
        return Err(e);
    }
    std::thread::Builder::new()
        .name("maka-mixer".into())
        .spawn(move || mix(&stop, &mic_rx, &sys_rx, &out))
        .map_err(|e| format!("no se pudo crear el hilo del mezclador: {e}"))?;
    Ok(())
}

/// Mono de un trozo estéreo s16le (media de los dos canales).
fn to_mono(pcm: &[u8], into: &mut std::collections::VecDeque<i16>) {
    for frame in pcm.chunks_exact(FRAME_BYTES) {
        let l = i16::from_le_bytes([frame[0], frame[1]]) as i32;
        let r = i16::from_le_bytes([frame[2], frame[3]]) as i32;
        into.push_back(((l + r) / 2) as i16);
    }
}

/// Cada 20 ms, lo que corresponde al tiempo transcurrido de cada fuente
/// (silencio si no hay), intercalado como [micrófono, sistema].
fn mix(
    stop: &AtomicBool,
    mic: &std::sync::mpsc::Receiver<Result<Vec<u8>, String>>,
    sys: &std::sync::mpsc::Receiver<Result<Vec<u8>, String>>,
    out: &Sender<Result<Vec<u8>, String>>,
) {
    use std::collections::VecDeque;
    use std::sync::mpsc::TryRecvError;
    use std::time::{Duration, Instant};

    let (mut mic_buf, mut sys_buf) = (VecDeque::<i16>::new(), VecDeque::<i16>::new());
    let mut mic_alive = true;
    let mut clock = Instant::now();
    while !stop.load(Ordering::SeqCst) {
        loop {
            match sys.try_recv() {
                Ok(Ok(pcm)) => to_mono(&pcm, &mut sys_buf),
                Ok(Err(e)) => {
                    let _ = out.send(Err(e));
                    stop.store(true, Ordering::SeqCst);
                    return;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    let _ = out.send(Err("la captura de audio se detuvo".into()));
                    stop.store(true, Ordering::SeqCst);
                    return;
                }
            }
        }
        // Si el micrófono falla a mitad, su canal queda en silencio.
        while mic_alive {
            match mic.try_recv() {
                Ok(Ok(pcm)) => to_mono(&pcm, &mut mic_buf),
                Ok(Err(_)) | Err(TryRecvError::Disconnected) => mic_alive = false,
                Err(TryRecvError::Empty) => break,
            }
        }
        std::thread::sleep(Duration::from_millis(20));
        let frames = (clock.elapsed().as_secs_f64() * RATE as f64) as usize;
        if frames == 0 {
            continue;
        }
        clock += Duration::from_secs_f64(frames as f64 / RATE as f64);
        // Relojes distintos: lo que pase de 200 ms de adelanto se descarta.
        for buf in [&mut mic_buf, &mut sys_buf] {
            let excess = buf.len().saturating_sub(frames + RATE as usize / 5);
            buf.drain(..excess);
        }
        if mic_buf.is_empty() && sys_buf.is_empty() {
            continue; // la escucha rellena con silencio
        }
        let mut pcm = Vec::with_capacity(frames * FRAME_BYTES);
        for _ in 0..frames {
            pcm.extend_from_slice(&mic_buf.pop_front().unwrap_or(0).to_le_bytes());
            pcm.extend_from_slice(&sys_buf.pop_front().unwrap_or(0).to_le_bytes());
        }
        if out.send(Ok(pcm)).is_err() {
            stop.store(true, Ordering::SeqCst);
            return;
        }
    }
}

/// Nivel (0 a 1) de un trozo de PCM s16le, para el medidor.
pub fn level(pcm: &[u8]) -> f32 {
    let samples = pcm.len() / 2;
    if samples == 0 {
        return 0.0;
    }
    let energy: f64 = pcm
        .chunks_exact(2)
        .map(|s| {
            let v = i16::from_le_bytes([s[0], s[1]]) as f64 / 32768.0;
            v * v
        })
        .sum();
    ((energy / samples as f64).sqrt() * 5.0).min(1.0) as f32
}

#[cfg(windows)]
mod imp {
    use super::{CHANNELS, FRAME_BYTES, RATE, Target};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::Sender;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::Media::Audio::{
        AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient,
        IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVE_FORMAT_PCM, WAVEFORMATEX, eCapture, eCommunications, eConsole, eRender,
    };
    use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
    use windows::Win32::System::Com::{
        BLOB, CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
    };
    use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};
    use windows::Win32::System::Variant::VT_BLOB;
    use windows::core::{HRESULT, IUnknown, Interface, Ref, implement};

    /// El evento que `ActivateAudioInterfaceAsync` señala al terminar.
    #[implement(IActivateAudioInterfaceCompletionHandler, windows::Win32::System::Com::IAgileObject)]
    struct Activated(isize);

    impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
        fn ActivateCompleted(&self, _operation: Ref<'_, IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
            // SAFETY: el evento vive hasta que `process_client` deja de esperarlo.
            unsafe { SetEvent(HANDLE(self.0 as *mut _)) }
        }
    }

    // Ágil (sin métodos propios): Windows puede completar la activación desde
    // cualquier hilo.
    impl windows::Win32::System::Com::IAgileObject_Impl for Activated_Impl {}

    /// Cierra un HANDLE al salir del ámbito.
    struct Owned(HANDLE);
    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: el handle es nuestro y no se usa después.
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    /// Deshace `CoInitializeEx` al salir del hilo.
    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            // SAFETY: empareja el CoInitializeEx de `run` en este mismo hilo.
            unsafe { CoUninitialize() };
        }
    }

    fn system_client() -> windows::core::Result<IAudioClient> {
        // SAFETY: COM está inicializado en este hilo.
        unsafe {
            let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = devices.GetDefaultAudioEndpoint(eRender, eConsole)?;
            device.Activate(CLSCTX_ALL, None)
        }
    }

    /// El micrófono que Windows usa para llamadas (el de comunicaciones).
    fn microphone_client() -> windows::core::Result<IAudioClient> {
        // SAFETY: COM está inicializado en este hilo.
        unsafe {
            let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = devices.GetDefaultAudioEndpoint(eCapture, eCommunications)?;
            device.Activate(CLSCTX_ALL, None)
        }
    }

    fn process_client(pid: u32) -> Result<IAudioClient, String> {
        // SAFETY: COM inicializado; `params` y `prop` viven durante la activación,
        // que se espera aquí mismo, y `prop` no se libera (apunta a `params`).
        unsafe {
            let event = Owned(CreateEventW(None, false, false, None).map_err(|e| format!("CreateEventW: {e}"))?);
            let params = AUDIOCLIENT_ACTIVATION_PARAMS {
                ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                    ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                        TargetProcessId: pid,
                        ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                    },
                },
            };
            let prop = std::mem::ManuallyDrop::new(PROPVARIANT {
                Anonymous: PROPVARIANT_0 {
                    Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                        vt: VT_BLOB,
                        Anonymous: PROPVARIANT_0_0_0 {
                            blob: BLOB {
                                cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                                pBlobData: &params as *const _ as *mut u8,
                            },
                        },
                        ..Default::default()
                    }),
                },
            });
            let handler: IActivateAudioInterfaceCompletionHandler = Activated(event.0.0 as isize).into();
            let operation = ActivateAudioInterfaceAsync(
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                &IAudioClient::IID,
                Some(&*prop as *const PROPVARIANT),
                &handler,
            )
            .map_err(|e| format!("no se pudo capturar esa aplicación: {e}"))?;
            if WaitForSingleObject(event.0, 5000) != WAIT_OBJECT_0 {
                return Err("Windows no activó la captura de la aplicación".into());
            }
            let mut result = HRESULT(0);
            let mut unknown: Option<IUnknown> = None;
            operation
                .GetActivateResult(&mut result, &mut unknown)
                .map_err(|e| format!("captura de la aplicación: {e}"))?;
            result.ok().map_err(|e| format!("captura de la aplicación: {e}"))?;
            unknown
                .ok_or("Windows no devolvió el cliente de audio")?
                .cast::<IAudioClient>()
                .map_err(|e| format!("captura de la aplicación: {e}"))
        }
    }

    pub(super) fn run(
        target: Target,
        stop: &AtomicBool,
        out: &Sender<Result<Vec<u8>, String>>,
        ready: &Sender<Result<(), String>>,
    ) -> Result<(), String> {
        // SAFETY: inicializa COM en este hilo; `Com` lo deshace al salir.
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|e| format!("COM: {e}"))?;
        let _com = Com;

        let client = match target {
            Target::System => system_client().map_err(|e| format!("no se pudo abrir la salida de audio: {e}"))?,
            Target::Process(pid) => process_client(pid)?,
            Target::Microphone => microphone_client().map_err(|e| format!("no se pudo abrir el micrófono: {e}"))?,
        };

        // Siempre PCM s16 estéreo a 48 kHz: WASAPI convierte desde el formato
        // del mezclador (AUTOCONVERTPCM) y la captura por proceso lo exige.
        let format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM as u16,
            nChannels: CHANNELS,
            nSamplesPerSec: RATE,
            nAvgBytesPerSec: RATE * FRAME_BYTES as u32,
            nBlockAlign: FRAME_BYTES as u16,
            wBitsPerSample: 16,
            cbSize: 0,
        };
        let loopback = if target == Target::Microphone { 0 } else { AUDCLNT_STREAMFLAGS_LOOPBACK };
        let flags =
            loopback | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

        // SAFETY: llamadas COM sobre el cliente recién creado; `event` vive
        // hasta el final de la función y el buffer de GetBuffer se copia antes
        // de ReleaseBuffer.
        unsafe {
            client
                .Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2_000_000, 0, &format, None)
                .map_err(|e| format!("no se pudo iniciar la captura: {e}"))?;
            let event = Owned(CreateEventW(None, false, false, None).map_err(|e| format!("CreateEventW: {e}"))?);
            client.SetEventHandle(event.0).map_err(|e| format!("SetEventHandle: {e}"))?;
            let capture: IAudioCaptureClient = client.GetService().map_err(|e| format!("GetService: {e}"))?;
            client.Start().map_err(|e| format!("no se pudo arrancar la captura: {e}"))?;
            let _ = ready.send(Ok(()));

            let result = (|| -> Result<(), String> {
                while !stop.load(Ordering::SeqCst) {
                    // Sin sonido WASAPI no señala: el tope de 100 ms deja ver `stop`.
                    WaitForSingleObject(event.0, 100);
                    loop {
                        let mut data = std::ptr::null_mut();
                        let mut frames = 0u32;
                        let mut buffer_flags = 0u32;
                        capture
                            .GetBuffer(&mut data, &mut frames, &mut buffer_flags, None, None)
                            .map_err(|e| format!("la captura se interrumpió: {e}"))?;
                        if frames == 0 {
                            let _ = capture.ReleaseBuffer(0);
                            break;
                        }
                        let bytes = frames as usize * FRAME_BYTES;
                        let chunk = if buffer_flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                            vec![0u8; bytes]
                        } else {
                            std::slice::from_raw_parts(data, bytes).to_vec()
                        };
                        capture.ReleaseBuffer(frames).map_err(|e| format!("ReleaseBuffer: {e}"))?;
                        if out.send(Ok(chunk)).is_err() {
                            return Ok(());
                        }
                    }
                }
                Ok(())
            })();
            let _ = client.Stop();
            result
        }
    }
}

/// Linux: PulseAudio o PipeWire (con `pipewire-pulse`), a través de `parec` y
/// `pactl` (paquete `pulseaudio-utils`). Todo el equipo es el monitor de la
/// salida predeterminada; una app es cada uno de sus flujos de reproducción
/// (`sink-input`) grabado con `--monitor-stream`, mezclados aquí. Los flujos
/// aparecen y desaparecen (Discord crea uno al entrar en un canal de voz):
/// se buscan de nuevo cada 1,5 s.
#[cfg(target_os = "linux")]
mod imp {
    use super::{CHANNELS, RATE, Target};
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::io::Read;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::Sender;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// Clave del lector del monitor de todo el equipo.
    const SYSTEM: u32 = u32::MAX;
    const SAMPLES_PER_SEC: usize = RATE as usize * CHANNELS as usize;

    /// Un proceso de `parec` y lo que va leyendo (muestras s16).
    struct Reader {
        child: Child,
        buf: Arc<Mutex<VecDeque<i16>>>,
        done: Arc<AtomicBool>,
    }

    impl Drop for Reader {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    fn missing(tool: &str, e: std::io::Error) -> String {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("falta `{tool}`: instala el paquete pulseaudio-utils")
        } else {
            format!("no se pudo ejecutar `{tool}`: {e}")
        }
    }

    fn parec(source: &[&str]) -> Result<Reader, String> {
        let mut child = Command::new("parec")
            .args(["--raw", "--format=s16le", "--latency-msec=20"])
            .arg(format!("--rate={RATE}"))
            .arg(format!("--channels={CHANNELS}"))
            .args(source)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| missing("parec", e))?;
        let mut stdout = child.stdout.take().ok_or("parec sin salida")?;
        let buf = Arc::new(Mutex::new(VecDeque::new()));
        let done = Arc::new(AtomicBool::new(false));
        let (thread_buf, thread_done) = (Arc::clone(&buf), Arc::clone(&done));
        std::thread::Builder::new()
            .name("maka-parec".into())
            .spawn(move || {
                let mut chunk = [0u8; 4096];
                let mut odd: Option<u8> = None;
                loop {
                    let n = match stdout.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    let mut b = thread_buf.lock().unwrap();
                    let mut bytes = chunk[..n].iter().copied();
                    if let Some(lo) = odd.take() {
                        if let Some(hi) = bytes.next() {
                            b.push_back(i16::from_le_bytes([lo, hi]));
                        }
                    }
                    loop {
                        match (bytes.next(), bytes.next()) {
                            (Some(lo), Some(hi)) => b.push_back(i16::from_le_bytes([lo, hi])),
                            (Some(lo), None) => {
                                odd = Some(lo);
                                break;
                            }
                            _ => break,
                        }
                    }
                    // Nadie lo recoge (no debería pasar): como mucho 1 s.
                    let excess = b.len().saturating_sub(SAMPLES_PER_SEC);
                    b.drain(..excess - excess % CHANNELS as usize);
                }
                thread_done.store(true, Ordering::SeqCst);
            })
            .map_err(|e| format!("no se pudo crear el hilo de parec: {e}"))?;
        Ok(Reader { child, buf, done })
    }

    /// Los procesos: (pid, padre, nombre).
    pub(crate) fn processes() -> Vec<(u32, u32, String)> {
        let Ok(dir) = std::fs::read_dir("/proc") else { return Vec::new() };
        dir.filter_map(|entry| {
            let pid: u32 = entry.ok()?.file_name().to_str()?.parse().ok()?;
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            // "pid (nombre) estado padre …": el nombre puede llevar espacios y paréntesis.
            let close = stat.rfind(')')?;
            let name = stat[stat.find('(')? + 1..close].to_string();
            let parent = stat[close + 1..].split_whitespace().nth(1)?.parse().ok()?;
            Some((pid, parent, name))
        })
        .collect()
    }

    /// `pid` y todos sus descendientes.
    fn tree(pid: u32) -> HashSet<u32> {
        let all = processes();
        let mut set = HashSet::from([pid]);
        loop {
            let before = set.len();
            for (child, parent, _) in &all {
                if set.contains(parent) {
                    set.insert(*child);
                }
            }
            if set.len() == before {
                return set;
            }
        }
    }

    /// Un flujo de reproducción de `pactl list sink-inputs`.
    #[derive(Debug, Default, PartialEq)]
    pub(crate) struct SinkInput {
        pub index: u32,
        pub pid: Option<u32>,
        pub binary: String,
        pub app: String,
    }

    pub(crate) fn parse_sink_inputs(text: &str) -> Vec<SinkInput> {
        let mut inputs: Vec<SinkInput> = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if let Some(index) = line.strip_prefix("Sink Input #") {
                if let Ok(index) = index.trim().parse() {
                    inputs.push(SinkInput { index, ..Default::default() });
                }
                continue;
            }
            let Some(current) = inputs.last_mut() else { continue };
            let Some((key, value)) = line.split_once(" = ") else { continue };
            let value = value.trim().trim_matches('"').to_string();
            match key.trim() {
                "application.process.id" => current.pid = value.parse().ok(),
                "application.process.binary" => current.binary = value,
                "application.name" => current.app = value,
                _ => {}
            }
        }
        inputs
    }

    fn sink_inputs() -> Result<Vec<SinkInput>, String> {
        let output = Command::new("pactl")
            .args(["list", "sink-inputs"])
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|e| missing("pactl", e))?;
        if !output.status.success() {
            return Err("pactl no pudo conectar con el servidor de sonido".into());
        }
        Ok(parse_sink_inputs(&String::from_utf8_lossy(&output.stdout)))
    }

    /// Los flujos de la app: los de su árbol de procesos o, si va en un
    /// sandbox (Flatpak, con otros pids), los que llevan su nombre.
    fn streams_of(pid: u32, name: &str) -> Result<Vec<u32>, String> {
        let tree = tree(pid);
        let name = name.to_lowercase();
        Ok(sink_inputs()?
            .into_iter()
            .filter(|s| {
                s.pid.is_some_and(|p| tree.contains(&p))
                    || (!name.is_empty()
                        && (s.binary.to_lowercase() == name || s.app.to_lowercase().contains(&name)))
            })
            .map(|s| s.index)
            .collect())
    }

    pub(super) fn run(
        target: Target,
        stop: &AtomicBool,
        out: &Sender<Result<Vec<u8>, String>>,
        ready: &Sender<Result<(), String>>,
    ) -> Result<(), String> {
        let mut readers: HashMap<u32, Reader> = HashMap::new();
        let app = match target {
            Target::System => {
                readers.insert(SYSTEM, parec(&["--device=@DEFAULT_MONITOR@"])?);
                None
            }
            Target::Microphone => {
                readers.insert(SYSTEM, parec(&["--device=@DEFAULT_SOURCE@"])?);
                None
            }
            Target::Process(pid) => {
                let name = std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default();
                // Falla aquí si no hay pactl o servidor de sonido.
                sink_inputs()?;
                Some((pid, name.trim().to_string()))
            }
        };
        let _ = ready.send(Ok(()));

        let mut scanned: Option<Instant> = None;
        let mut clock = Instant::now();
        while !stop.load(Ordering::SeqCst) {
            if let Some((pid, name)) = &app
                && scanned.is_none_or(|t| t.elapsed() >= Duration::from_millis(1500))
            {
                scanned = Some(Instant::now());
                for index in streams_of(*pid, name).unwrap_or_default() {
                    if !readers.contains_key(&index)
                        && let Ok(reader) = parec(&[&format!("--monitor-stream={index}")])
                    {
                        readers.insert(index, reader);
                    }
                }
            }
            readers.retain(|_, r| !r.done.load(Ordering::SeqCst) || !r.buf.lock().unwrap().is_empty());
            if app.is_none() && readers.is_empty() {
                return Err("la captura de audio se detuvo".into());
            }

            std::thread::sleep(Duration::from_millis(20));
            // Lo que corresponde al tiempo transcurrido, de cada flujo, sumado.
            let frames = (clock.elapsed().as_secs_f64() * RATE as f64) as usize;
            if frames == 0 {
                continue;
            }
            clock += Duration::from_secs_f64(frames as f64 / RATE as f64);
            let wanted = frames * CHANNELS as usize;
            let mut mix = vec![0i32; wanted];
            let mut any = false;
            for reader in readers.values() {
                let mut b = reader.buf.lock().unwrap();
                // Si se adelanta más de 200 ms (relojes distintos), se descarta lo viejo.
                let excess = b.len().saturating_sub(wanted + SAMPLES_PER_SEC / 5);
                b.drain(..excess - excess % CHANNELS as usize);
                let n = b.len().min(wanted);
                any |= n > 0;
                for (acc, sample) in mix.iter_mut().zip(b.drain(..n)) {
                    *acc += sample as i32;
                }
            }
            // Sin audio no se envía nada: la escucha rellena con silencio.
            if any {
                let pcm: Vec<u8> = mix
                    .into_iter()
                    .flat_map(|v| (v.clamp(i16::MIN as i32, i16::MAX as i32) as i16).to_le_bytes())
                    .collect();
                if out.send(Ok(pcm)).is_err() {
                    break;
                }
            }
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::{SinkInput, parse_sink_inputs};

        #[test]
        fn lee_los_flujos_de_pactl() {
            let text = "Sink Input #42\n\tDriver: protocol-native.c\n\tProperties:\n\t\tapplication.name = \"Discord\"\n\
                        \t\tapplication.process.id = \"1234\"\n\t\tapplication.process.binary = \"Discord\"\n\n\
                        Sink Input #7\n\tProperties:\n\t\tapplication.name = \"Google Chrome\"\n\
                        \t\tapplication.process.binary = \"chrome\"\n";
            assert_eq!(
                parse_sink_inputs(text),
                vec![
                    SinkInput { index: 42, pid: Some(1234), binary: "Discord".into(), app: "Discord".into() },
                    SinkInput { index: 7, pid: None, binary: "chrome".into(), app: "Google Chrome".into() },
                ]
            );
        }

        /// Con servidor de sonido real (`cargo test -- --ignored`): `paplay`
        /// reproduce un tono; lo oye todo el equipo y su proceso, no otro.
        #[test]
        #[ignore]
        fn captura_un_tono_real() {
            use crate::audio::{Target, level, start};
            use std::sync::Arc;
            use std::sync::atomic::{AtomicBool, Ordering};

            let wav = std::env::temp_dir().join("maka-tono.wav");
            std::fs::write(&wav, crate::audio::tests::tone(4000)).unwrap();
            let loudest = |target: Option<Target>| {
                let mut player = std::process::Command::new("paplay").arg(&wav).spawn().expect("paplay");
                std::thread::sleep(std::time::Duration::from_millis(300));
                let target = target.unwrap_or(Target::Process(player.id()));
                let stop = Arc::new(AtomicBool::new(false));
                let (tx, rx) = std::sync::mpsc::channel();
                start(target, Arc::clone(&stop), tx).expect("captura iniciada");
                let until = std::time::Instant::now() + std::time::Duration::from_millis(2000);
                let mut loudest = 0.0f32;
                while std::time::Instant::now() < until {
                    if let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(50)) {
                        loudest = loudest.max(level(&chunk.expect("sin errores")));
                    }
                }
                stop.store(true, Ordering::SeqCst);
                let _ = player.kill();
                let _ = player.wait();
                loudest
            };
            let system = loudest(Some(Target::System));
            assert!(system > 0.05, "todo el equipo: {system}");
            let app = loudest(None);
            assert!(app > 0.05, "el proceso de paplay: {app}");
            // Un proceso ajeno (este test no vale: es el padre de paplay).
            let mut idle = std::process::Command::new("sleep").arg("30").spawn().unwrap();
            let other = loudest(Some(Target::Process(idle.id())));
            let _ = idle.kill();
            let _ = idle.wait();
            assert!(other < 0.02, "otro proceso: {other}");
        }

        #[test]
        fn este_proceso_aparece_en_proc() {
            let me = std::process::id();
            assert!(super::processes().iter().any(|(pid, _, _)| *pid == me));
            assert!(super::tree(me).contains(&me));
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    use super::Target;
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc::Sender;

    pub(super) fn run(
        _target: Target,
        _stop: &AtomicBool,
        _out: &Sender<Result<Vec<u8>, String>>,
        _ready: &Sender<Result<(), String>>,
    ) -> Result<(), String> {
        Err("la captura de audio solo está implementada en Windows y Linux".into())
    }
}

/// Los procesos del sistema (Linux): (pid, padre, nombre).
#[cfg(target_os = "linux")]
pub(crate) fn linux_processes() -> Vec<(u32, u32, String)> {
    imp::processes()
}

#[cfg(test)]
mod tests {
    use super::level;

    #[test]
    fn el_mezclador_pone_el_microfono_en_el_canal_0_y_lo_demas_en_el_1() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        // 200 ms de estéreo constante: micrófono (1000, 3000) → 2000; sistema (-500, -1500) → -1000.
        let stereo = |l: i16, r: i16| -> Vec<u8> {
            std::iter::repeat([l.to_le_bytes(), r.to_le_bytes()].concat()).take(9600).flatten().collect()
        };
        let (mic_tx, mic_rx) = std::sync::mpsc::channel();
        let (sys_tx, sys_rx) = std::sync::mpsc::channel();
        let (out_tx, out_rx) = std::sync::mpsc::channel();
        mic_tx.send(Ok(stereo(1000, 3000))).unwrap();
        sys_tx.send(Ok(stereo(-500, -1500))).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let mixer = std::thread::spawn(move || super::mix(&thread_stop, &mic_rx, &sys_rx, &out_tx));
        std::thread::sleep(std::time::Duration::from_millis(120));
        stop.store(true, Ordering::SeqCst);
        mixer.join().unwrap();
        let pcm: Vec<u8> = out_rx.try_iter().map(|c| c.unwrap()).flatten().collect();
        assert!(pcm.len() >= 4 * 48 * 50, "al menos 50 ms mezclados: {} bytes", pcm.len());
        for frame in pcm.chunks_exact(4) {
            assert_eq!(i16::from_le_bytes([frame[0], frame[1]]), 2000, "canal 0: micrófono");
            assert_eq!(i16::from_le_bytes([frame[2], frame[3]]), -1000, "canal 1: lo demás");
        }
        drop((mic_tx, sys_tx));
    }

    #[test]
    fn el_silencio_tiene_nivel_cero() {
        assert_eq!(level(&[0u8; 400]), 0.0);
    }

    #[test]
    fn el_nivel_se_satura_en_uno() {
        let loud: Vec<u8> = std::iter::repeat(i16::MAX.to_le_bytes()).take(200).flatten().collect();
        assert_eq!(level(&loud), 1.0);
    }

    /// Un WAV de `ms` milisegundos a 440 Hz, bajito, en memoria.
    #[cfg(any(windows, target_os = "linux"))]
    pub(crate) fn tone(ms: u32) -> Vec<u8> {
        let rate = 48_000u32;
        let frames = rate * ms / 1000;
        let mut pcm = Vec::with_capacity(frames as usize * 4);
        for i in 0..frames {
            let v = ((i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 0.15 * 32767.0) as i16;
            pcm.extend_from_slice(&v.to_le_bytes());
            pcm.extend_from_slice(&v.to_le_bytes());
        }
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&rate.to_le_bytes());
        wav.extend_from_slice(&(rate * 4).to_le_bytes());
        wav.extend_from_slice(&4u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        wav.extend_from_slice(&pcm);
        wav
    }

    /// Captura `target` mientras este proceso reproduce un tono; devuelve el
    /// nivel máximo oído.
    #[cfg(windows)]
    fn loudest_while_playing(target: super::Target) -> f32 {
        use super::start;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};
        use windows::core::PCWSTR;

        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = std::sync::mpsc::channel();
        start(target, Arc::clone(&stop), tx).expect("captura iniciada");
        let wav = tone(900);
        // SAFETY: `wav` vive hasta después de que el sonido termina (se espera abajo).
        unsafe { PlaySoundW(PCWSTR(wav.as_ptr().cast()), None, SND_MEMORY | SND_ASYNC | SND_NODEFAULT) }
            .ok()
            .expect("tono reproducido");
        let until = std::time::Instant::now() + std::time::Duration::from_millis(1300);
        let mut loudest = 0.0f32;
        while std::time::Instant::now() < until {
            if let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(50)) {
                loudest = loudest.max(level(&chunk.expect("sin errores de captura")));
            }
        }
        stop.store(true, Ordering::SeqCst);
        loudest
    }

    // Un solo test (no en paralelo): el tono de uno no debe oírse en otro.
    // Necesita una salida de audio (las máquinas de CI no tienen):
    // `cargo test -- --ignored`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn captura_el_tono_del_equipo_y_del_proceso_pero_no_de_otro() {
        use super::Target;
        let system = loudest_while_playing(Target::System);
        assert!(system > 0.05, "todo el equipo: nivel {system}");
        let own = loudest_while_playing(Target::Process(std::process::id()));
        assert!(own > 0.05, "este proceso: nivel {own}");
        // El proceso de la sesión de escritorio (explorer) no reproduce el tono.
        let explorer = crate::meeting::find_process("explorer.exe").expect("explorer abierto");
        let other = loudest_while_playing(Target::Process(explorer));
        assert!(other < 0.02, "proceso ajeno: nivel {other}");
    }
}

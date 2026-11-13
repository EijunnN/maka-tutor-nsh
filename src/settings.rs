//! Ajustes que necesitan el sistema:
//! - `ApiKey`: la API key de Anthropic en el almacén de claves del sistema
//!   (Administrador de credenciales de Windows, llavero en Linux). La key
//!   nunca vuelve a JS: `load` la pone en el entorno del proceso, del que NSH
//!   copia `ANTHROPIC_API_KEY` al lanzar `claude` (la variable está concedida
//!   en `capabilities.process.env`).
//! - `Gateway`: una URL y un token de un proxy compatible con la API de
//!   Anthropic (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, como en la
//!   terminal). Tiene prioridad sobre la API key; el token tampoco vuelve a JS.
//! - `DeepgramKey`: la clave de Deepgram para el modo reunión, también en el
//!   almacén de claves; solo la lee el hilo de la escucha.
//! - `Startup`: arrancar con la sesión.

use nsh_core::prelude::*;

const API_KEY: &str = "ANTHROPIC_API_KEY";
const BASE_URL: &str = "ANTHROPIC_BASE_URL";
const AUTH_TOKEN: &str = "ANTHROPIC_AUTH_TOKEN";

/// La API key de Anthropic.
#[module]
pub struct ApiKey;

#[module]
impl ApiKey {
    /// Guarda `value` (tras validarla) y la deja en uso (salvo que haya un
    /// gateway); lanza si no parece una API key o el sistema no la guarda.
    pub fn save(value: String) -> Result<(), String> {
        let value = value.trim().to_owned();
        validate(&value)?;
        imp::write(imp::TARGET, &value)?;
        apply_env();
        Ok(())
    }

    /// La borra y deja de usarla: `claude` vuelve a la sesión iniciada con
    /// `claude login`.
    pub fn clear() -> Result<(), String> {
        imp::delete(imp::TARGET)?;
        apply_env();
        Ok(())
    }

    /// Pone en uso lo guardado (key o gateway); devuelve si hay key.
    pub fn load() -> bool {
        apply_env();
        imp::read(imp::TARGET).is_some()
    }

    /// La guardada, enmascarada para mostrarla (`sk-ant-…a1b2`), o `None`.
    pub fn hint() -> Option<String> {
        imp::read(imp::TARGET).map(|value| mask(&value))
    }
}

/// Un proxy o gateway compatible con la API de Anthropic.
#[module]
pub struct Gateway;

#[module]
impl Gateway {
    /// Guarda la URL y el token y los deja en uso; lanza si no son válidos o
    /// el sistema no los guarda.
    pub fn save(url: String, token: String) -> Result<(), String> {
        let url = validate_url(&url)?;
        let token = token.trim().to_owned();
        if token.is_empty() || token.len() > 2048 || token.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err("el token no es válido (sin espacios)".into());
        }
        imp::write(imp::GATEWAY, &format!("{url}\n{token}"))?;
        apply_env();
        Ok(())
    }

    /// Lo borra: vuelve la API key, si hay, o la sesión de `claude login`.
    pub fn clear() -> Result<(), String> {
        imp::delete(imp::GATEWAY)?;
        apply_env();
        Ok(())
    }

    /// Lo guardado, para mostrarlo (`pool.example.com · …a1b2`), o `None`.
    pub fn hint() -> Option<String> {
        let (url, token) = stored_gateway()?;
        let host = url.split("://").nth(1).unwrap_or(&url).trim_end_matches('/');
        Some(format!("{host} · …{}", tail(&token)))
    }
}

/// La clave de Deepgram (transcripción del modo reunión).
#[module]
pub struct DeepgramKey;

#[module]
impl DeepgramKey {
    /// La guarda; lanza si el formato no es válido o el sistema no la guarda.
    pub fn save(value: String) -> Result<(), String> {
        let value = value.trim().to_owned();
        if value.len() < 20 || value.len() > 256 || !value.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err("no parece una clave de Deepgram (letras y números, sin espacios)".into());
        }
        imp::write(imp::DEEPGRAM, &value)
    }

    /// La borra.
    pub fn clear() -> Result<(), String> {
        imp::delete(imp::DEEPGRAM)
    }

    /// La guardada, enmascarada (`…a1b2`), o `None`.
    pub fn hint() -> Option<String> {
        imp::read(imp::DEEPGRAM).map(|value| format!("…{}", tail(&value)))
    }
}

/// La clave de Deepgram guardada, para el hilo de la escucha.
pub(crate) fn deepgram_key() -> Option<String> {
    imp::read(imp::DEEPGRAM)
}

/// Arrancar con la sesión.
#[module]
pub struct Startup;

#[module]
impl Startup {
    /// Si la app arranca con la sesión (apuntando a este ejecutable).
    pub fn enabled() -> bool {
        imp::startup_get()
    }

    /// Activa o desactiva el arranque con la sesión para este ejecutable.
    pub fn set(enabled: bool) -> Result<(), String> {
        imp::startup_set(enabled)
    }
}

fn validate(value: &str) -> Result<(), String> {
    if !value.starts_with("sk-ant-") {
        return Err("no parece una API key de Anthropic (empieza por sk-ant-)".into());
    }
    if value.len() < 20 || value.len() > 512 || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("la API key tiene un formato inválido".into());
    }
    Ok(())
}

/// `https://…`, o `http://` solo hacia este equipo; sin la barra final.
fn validate_url(url: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/');
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://").filter(|r| r.starts_with("localhost") || r.starts_with("127.0.0.1")))
        .ok_or("la URL debe empezar por https:// (http:// solo para localhost)")?;
    if rest.is_empty() || url.len() > 512 || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("la URL no es válida".into());
    }
    Ok(url.to_owned())
}

fn stored_gateway() -> Option<(String, String)> {
    let value = imp::read(imp::GATEWAY)?;
    let (url, token) = value.split_once('\n')?;
    (!url.is_empty() && !token.is_empty()).then(|| (url.to_owned(), token.to_owned()))
}

fn tail(value: &str) -> String {
    value.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect()
}

fn mask(value: &str) -> String {
    format!("sk-ant-…{}", tail(value))
}

/// Deja en el entorno lo que `claude` debe usar: el gateway si hay; si no, la
/// API key si hay; si no, nada (la sesión de `claude login`).
fn apply_env() {
    let gateway = stored_gateway();
    let key = if gateway.is_none() { imp::read(imp::TARGET) } else { None };
    // SAFETY: Rust 2024 marca `set_var` como inseguro porque otro hilo podría
    // leer el entorno a la vez. NSH solo lo lee al lanzar un proceso, desde el
    // mismo hilo de JS que llama a este módulo.
    unsafe {
        match &gateway {
            Some((url, token)) => {
                std::env::set_var(BASE_URL, url);
                std::env::set_var(AUTH_TOKEN, token);
            }
            None => {
                std::env::remove_var(BASE_URL);
                std::env::remove_var(AUTH_TOKEN);
            }
        }
        match key {
            Some(key) => std::env::set_var(API_KEY, key),
            None => std::env::remove_var(API_KEY),
        }
    }
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::Security::Credentials::{
        CRED_FLAGS, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree, CredReadW,
        CredWriteW,
    };
    use windows::Win32::System::Registry::{
        HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ, RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW,
    };
    use windows::core::{HSTRING, PWSTR};

    pub(super) const TARGET: &str = "maka-tutor-nsh:anthropic-api-key";
    pub(super) const DEEPGRAM: &str = "maka-tutor-nsh:deepgram-key";
    pub(super) const GATEWAY: &str = "maka-tutor-nsh:gateway";
    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const RUN_VALUE: &str = "Maka Tutor NSH";

    pub(super) fn write(target: &str, value: &str) -> Result<(), String> {
        let mut target: Vec<u16> = target.encode_utf16().chain([0]).collect();
        let mut user: Vec<u16> = "anthropic".encode_utf16().chain([0]).collect();
        let mut blob = value.as_bytes().to_vec();
        let credential = CREDENTIALW {
            Flags: CRED_FLAGS(0),
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            // Solo este usuario de Windows, sin itinerancia de dominio.
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: PWSTR(user.as_mut_ptr()),
            ..Default::default()
        };
        // SAFETY: los punteros apuntan a buffers vivos durante la llamada.
        unsafe { CredWriteW(&credential, 0) }.map_err(|e| format!("no se pudo guardar la API key: {e}"))
    }

    pub(super) fn read(target: &str) -> Option<String> {
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `credential` lo rellena el sistema y se libera con CredFree.
        unsafe {
            CredReadW(&HSTRING::from(target), CRED_TYPE_GENERIC, None, &mut credential).ok()?;
            let c = &*credential;
            let bytes = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize);
            let value = String::from_utf8(bytes.to_vec()).ok();
            CredFree(credential as *const _);
            value
        }
    }

    pub(super) fn delete(target: &str) -> Result<(), String> {
        // SAFETY: llamada simple con una cadena propia.
        match unsafe { CredDeleteW(&HSTRING::from(target), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERROR_NOT_FOUND.to_hresult() => Ok(()),
            Err(e) => Err(format!("no se pudo borrar la API key: {e}")),
        }
    }

    fn exe() -> Result<String, String> {
        let path = std::env::current_exe().map_err(|e| format!("ejecutable desconocido: {e}"))?;
        Ok(format!("\"{}\"", path.display()))
    }

    pub(super) fn startup_get() -> bool {
        let mut buffer = [0u16; 1024];
        let mut size = (buffer.len() * 2) as u32;
        // SAFETY: `buffer` y `size` describen un buffer propio.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                &HSTRING::from(RUN_KEY),
                &HSTRING::from(RUN_VALUE),
                RRF_RT_REG_SZ,
                None,
                Some(buffer.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if status != ERROR_SUCCESS {
            return false;
        }
        let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        let stored = String::from_utf16_lossy(&buffer[..len]);
        exe().is_ok_and(|exe| stored.eq_ignore_ascii_case(&exe))
    }

    pub(super) fn startup_set(enabled: bool) -> Result<(), String> {
        let status = if enabled {
            let data: Vec<u16> = exe()?.encode_utf16().chain([0]).collect();
            // SAFETY: `data` es una cadena UTF-16 terminada en cero.
            unsafe {
                RegSetKeyValueW(
                    HKEY_CURRENT_USER,
                    &HSTRING::from(RUN_KEY),
                    &HSTRING::from(RUN_VALUE),
                    REG_SZ.0,
                    Some(data.as_ptr().cast()),
                    (data.len() * 2) as u32,
                )
            }
        } else {
            // SAFETY: llamada simple con cadenas propias.
            match unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, &HSTRING::from(RUN_KEY), &HSTRING::from(RUN_VALUE)) } {
                s if s == ERROR_FILE_NOT_FOUND => ERROR_SUCCESS,
                s => s,
            }
        };
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!("no se pudo cambiar el arranque con la sesión (error {})", status.0))
        }
    }
}

/// Linux: las claves en el llavero del escritorio (Secret Service: GNOME
/// Keyring, KWallet) con `secret-tool` (paquete `libsecret-tools`); sin él o
/// sin llavero, en un archivo que solo lee el usuario. El arranque con la
/// sesión es una entrada de `~/.config/autostart`.
#[cfg(target_os = "linux")]
mod imp {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    pub(super) const TARGET: &str = "anthropic-api-key";
    pub(super) const DEEPGRAM: &str = "deepgram-key";
    pub(super) const GATEWAY: &str = "gateway";
    const SERVICE: &str = "maka-tutor-nsh";
    const APP_ID: &str = "com.eijunnn.makatutornsh";

    fn config_dir() -> Option<PathBuf> {
        std::env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    }

    fn key_file(target: &str) -> Option<PathBuf> {
        config_dir().map(|d| d.join(SERVICE).join("keys").join(target))
    }

    fn secret_tool(args: &[&str], input: Option<&str>) -> Option<std::process::Output> {
        let mut child = Command::new("secret-tool")
            .args(args)
            .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        if let Some(input) = input {
            child.stdin.take()?.write_all(input.as_bytes()).ok()?;
        }
        child.wait_with_output().ok()
    }

    pub(super) fn write(target: &str, value: &str) -> Result<(), String> {
        let label = format!("Maka Tutor NSH ({target})");
        let stored = secret_tool(&["store", "--label", &label, "service", SERVICE, "account", target], Some(value))
            .is_some_and(|o| o.status.success());
        let file = key_file(target).ok_or("no se encontró la carpeta de configuración")?;
        if stored {
            let _ = std::fs::remove_file(&file);
            return Ok(());
        }
        // Sin llavero: archivo 0600 en una carpeta 0700.
        let dir = file.parent().unwrap();
        std::fs::create_dir_all(dir).map_err(|e| format!("no se pudo guardar la clave: {e}"))?;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&file)
            .map_err(|e| format!("no se pudo guardar la clave: {e}"))?;
        f.write_all(value.as_bytes()).map_err(|e| format!("no se pudo guardar la clave: {e}"))
    }

    pub(super) fn read(target: &str) -> Option<String> {
        if let Some(o) = secret_tool(&["lookup", "service", SERVICE, "account", target], None)
            && o.status.success()
        {
            let value = String::from_utf8_lossy(&o.stdout).trim_end_matches(['\n', '\r']).to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
        let value = std::fs::read_to_string(key_file(target)?).ok()?;
        let value = value.trim().to_string();
        (!value.is_empty()).then_some(value)
    }

    pub(super) fn delete(target: &str) -> Result<(), String> {
        let _ = secret_tool(&["clear", "service", SERVICE, "account", target], None);
        if let Some(file) = key_file(target) {
            match std::fs::remove_file(file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(format!("no se pudo borrar la clave: {e}")),
                _ => {}
            }
        }
        Ok(())
    }

    fn autostart() -> Option<PathBuf> {
        config_dir().map(|d| d.join("autostart").join(format!("{APP_ID}.desktop")))
    }

    fn exe() -> Result<String, String> {
        let path = std::env::current_exe().map_err(|e| format!("ejecutable desconocido: {e}"))?;
        // Entre comillas, escapando lo que la especificación de Desktop Entry pide.
        let quoted = path.display().to_string().replace('\\', "\\\\").replace('"', "\\\"").replace('`', "\\`").replace('$', "\\$");
        Ok(format!("\"{quoted}\""))
    }

    pub(super) fn startup_get() -> bool {
        let (Some(file), Ok(exe)) = (autostart(), exe()) else { return false };
        std::fs::read_to_string(file).is_ok_and(|entry| {
            entry.lines().any(|l| l.trim() == format!("Exec={exe}"))
                && !entry.lines().any(|l| l.trim() == "Hidden=true" || l.trim() == "X-GNOME-Autostart-enabled=false")
        })
    }

    pub(super) fn startup_set(enabled: bool) -> Result<(), String> {
        let file = autostart().ok_or("no se encontró la carpeta de configuración")?;
        if !enabled {
            return match std::fs::remove_file(&file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    Err(format!("no se pudo quitar el arranque con la sesión: {e}"))
                }
                _ => Ok(()),
            };
        }
        let entry = format!(
            "[Desktop Entry]\nType=Application\nName=Maka Tutor\nExec={}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
            exe()?
        );
        std::fs::create_dir_all(file.parent().unwrap())
            .and_then(|_| std::fs::write(&file, entry))
            .map_err(|e| format!("no se pudo activar el arranque con la sesión: {e}"))
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    pub(super) const TARGET: &str = "";
    pub(super) const DEEPGRAM: &str = "";
    pub(super) const GATEWAY: &str = "";
    pub(super) fn write(_target: &str, _value: &str) -> Result<(), String> {
        Err("guardar la API key solo está implementado en Windows".into())
    }
    pub(super) fn read(_target: &str) -> Option<String> {
        None
    }
    pub(super) fn delete(_target: &str) -> Result<(), String> {
        Ok(())
    }
    pub(super) fn startup_get() -> bool {
        false
    }
    pub(super) fn startup_set(_enabled: bool) -> Result<(), String> {
        Err("el arranque con la sesión solo está implementado en Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{mask, validate};

    #[test]
    fn valida_el_formato() {
        assert!(validate("sk-ant-api03-abcdefghijklmnop").is_ok());
        assert!(validate("hola").is_err());
        assert!(validate("sk-ant-con espacio-abcdefghijk").is_err());
    }

    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn guarda_lee_y_borra_en_el_administrador_de_credenciales() {
        // Una credencial propia del test: no toca la key real.
        let target = if cfg!(windows) { "maka-tutor-nsh:test" } else { "test" };
        super::imp::write(target, "sk-ant-test-0123456789").unwrap();
        assert_eq!(super::imp::read(target).as_deref(), Some("sk-ant-test-0123456789"));
        super::imp::delete(target).unwrap();
        assert_eq!(super::imp::read(target), None);
        // Borrar otra vez no falla.
        super::imp::delete(target).unwrap();
    }

    #[test]
    fn valida_la_url_del_gateway() {
        use super::validate_url;
        assert_eq!(validate_url(" https://pool.example.com/ ").unwrap(), "https://pool.example.com");
        assert_eq!(validate_url("http://localhost:8080").unwrap(), "http://localhost:8080");
        assert!(validate_url("http://pool.example.com").is_err());
        assert!(validate_url("pool.example.com").is_err());
        assert!(validate_url("https://").is_err());
    }

    #[test]
    fn enmascara_dejando_los_ultimos_cuatro() {
        assert_eq!(mask("sk-ant-api03-xyz-a1b2"), "sk-ant-…a1b2");
    }
}

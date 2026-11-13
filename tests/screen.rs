//! La captura y la exclusión de capturas, contra el escritorio real.
#![cfg(windows)]

use base64::Engine as _;
use nsh_app_maka_tutor_nsh::Screen;

#[test]
fn captura_el_monitor_en_jpeg_acotado() {
    let shot = Screen::capture().expect("captura");
    assert!(shot.source_width > 0 && shot.source_height > 0);
    assert!(shot.width.max(shot.height) <= 1568);
    let jpeg = base64::engine::general_purpose::STANDARD.decode(&shot.data).unwrap();
    assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "cabecera JPEG");
    // Por debajo del MiB que admite el stdin de un proceso de NSH.
    assert!(shot.data.len() < 900_000, "base64 de {} bytes", shot.data.len());
    std::fs::write(std::env::temp_dir().join("maka-tutor-nsh-shot.jpg"), &jpeg).unwrap();
    println!("{}x{} -> {}x{}, {} KB base64", shot.source_width, shot.source_height, shot.width, shot.height, shot.data.len() / 1024);
}

#[test]
fn protect_sin_ventanas_no_falla() {
    // Un test no tiene ventanas propias: cambia 0 y no rompe.
    assert_eq!(Screen::protect(true), 0);
    assert_eq!(Screen::protect(false), 0);
}

#[test]
fn recorta_la_ultima_captura() {
    let full = Screen::capture().expect("captura");
    let shot = Screen::crop(0.25, 0.25, 0.5, 0.5).expect("recorte");
    assert_eq!(shot.source_width, full.source_width / 2);
    assert_eq!(shot.source_height, full.source_height / 2);
    assert_eq!((shot.source_x, shot.source_y), (full.source_x, full.source_y));
    let jpeg = base64::engine::general_purpose::STANDARD.decode(&shot.data).unwrap();
    std::fs::write(std::env::temp_dir().join("maka-tutor-nsh-crop.jpg"), &jpeg).unwrap();
    assert!(Screen::crop(0.5, 0.5, 0.0, 0.0).is_err());
}

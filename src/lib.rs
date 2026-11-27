//! Lo que NSH no trae y Maka Tutor necesita, en Rust: capturar la pantalla
//! y sacar las ventanas de la app de cualquier captura, guardar las claves
//! cifradas, arrancar con la sesión y escuchar reuniones (audio del sistema →
//! AssemblyAI). `App.tsx` lo importa
//! de `maka-tutor-nsh/native`; sus declaraciones TS se generan en
//! `.nsh/types/maka-tutor-nsh/native.d.ts`.

mod audio;
mod meeting;
mod screen;
mod settings;

use nsh_core::prelude::*;

pub use crate::screen::{Screen, Shot};
pub use crate::meeting::{Meeting, Poll, Source};
pub use crate::settings::{ApiKey, Gateway, Startup, TranscriptionKey};

/// El set nativo de la app (`nsh.json` `"rust"`).
#[native_module("maka-tutor-nsh/native")]
fn native(registry: &mut Registry) {
    registry.module::<Screen>();
    registry.module::<ApiKey>();
    registry.module::<Startup>();
    registry.module::<TranscriptionKey>();
    registry.module::<Gateway>();
    registry.module::<Meeting>();
}

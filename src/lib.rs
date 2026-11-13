//! Lo que NSH no trae y Maka Tutor necesita, en Rust: capturar la pantalla
//! y sacar las ventanas de la app de cualquier captura. `App.tsx` lo importa
//! de `maka-tutor-nsh/native`; sus declaraciones TS se generan en
//! `.nsh/types/maka-tutor-nsh/native.d.ts`.

mod screen;

use nsh_core::prelude::*;

pub use crate::screen::{Screen, Shot};

/// El set nativo de la app (`nsh.json` `"rust"`).
#[native_module("maka-tutor-nsh/native")]
fn native(registry: &mut Registry) {
    registry.module::<Screen>();
}

//! Qualification-only observation of an existing anchored custody capability.
//! Never initializes, deletes, resets, or signals a runtime. A free result is
//! only this bounded acquisition/release observation, not durable exclusion.
use caws_native::service_journal::{Custody, ErrorKind};
use serde_json::json;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 1 {
        eprintln!("usage: service-custody-observer <existing absolute custody home>");
        std::process::exit(2);
    }
    let home = PathBuf::from(&args[0]);
    let (state, code, error) = if !home.is_absolute() {
        (
            "unavailable",
            2,
            Some("custody home must be absolute".to_owned()),
        )
    } else {
        match Custody::acquire(&home, Instant::now() + Duration::from_millis(25)) {
            Ok(custody) => {
                drop(custody);
                ("free", 0, None)
            }
            Err(error) if error.kind == ErrorKind::Busy => ("busy", 75, None),
            Err(error) => ("unavailable", 2, Some(error.to_string())),
        }
    };
    println!(
        "{}",
        json!({"schema":"caws.service.custody.observation.v1",
        "state":state,"home":home,"error":error})
    );
    std::process::exit(code);
}

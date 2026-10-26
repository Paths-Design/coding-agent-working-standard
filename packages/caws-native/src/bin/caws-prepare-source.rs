//! Finite foreground developer tool; no runtime bootstrap override flags.
use std::process::ExitCode;
fn main() -> ExitCode {
    if std::env::args_os().count() != 1 {
        return ExitCode::from(2);
    }
    // A closed output pipe must produce a finite failure, not terminate midway
    // through the library's bounded terminal-delivery observation.
    if unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) } == libc::SIG_ERR {
        return ExitCode::from(2);
    }
    match caws_native::preparation_parent::run_stdin() {
        Ok(completed) => {
            let code = completed.exit_code();
            if completed.deliver_stdout().is_err() {
                ExitCode::from(2)
            } else {
                ExitCode::from(code)
            }
        }
        Err(failed) => {
            // Actual Child handles stay retained in failed while this caller
            // remains alive. Finite exit after an unsettled deadline means
            // UNKNOWN parent-loss settlement, never absence or adoption.
            let _ = failed.deliver_stdout();
            ExitCode::from(2)
        }
    }
}

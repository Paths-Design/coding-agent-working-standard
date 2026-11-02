//! Darwin qualification fixture: observe a process instance, or record our own
//! identity before exec. It never detaches, waits for readiness, or signals.
#[cfg(target_os = "macos")]
mod darwin {
    use serde_json::{Value, json};
    use std::{
        env,
        fs::{self, OpenOptions},
        io::Write,
        os::unix::{fs::OpenOptionsExt, process::CommandExt},
        path::Path,
        process::Command,
    };

    fn observe(pid: u32) -> Value {
        if pid <= 1 || pid > i32::MAX as u32 {
            return json!({"state":"unavailable","reason":"invalid-pid"});
        }
        let mut buffer = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>();
        // SAFETY: the buffer is writable for the exact requested native structure.
        let count = unsafe {
            // A short result must not reuse an earlier ESRCH as absence evidence.
            *libc::__error() = 0;
            libc::proc_pidinfo(
                pid as i32,
                libc::PROC_PIDTBSDINFO,
                0,
                buffer.as_mut_ptr().cast(),
                size as i32,
            )
        };
        if count != size as i32 {
            let error = std::io::Error::last_os_error();
            return json!({
                "state": if error.raw_os_error() == Some(libc::ESRCH) {
                    "absent"
                } else {
                    "unavailable"
                },
                "errno": error.raw_os_error(),
                "reason": error.to_string()
            });
        }
        // SAFETY: the exact successful byte count initialized the whole structure.
        let info = unsafe { buffer.assume_init() };
        if info.pbi_pid != pid || info.pbi_start_tvsec == 0 || info.pbi_start_tvusec >= 1_000_000 {
            return json!({"state":"unavailable","reason":"invalid-native-identity"});
        }
        json!({
            "state":"observed",
            "process":{
                "pid":info.pbi_pid,
                "parent":info.pbi_ppid,
                "group":info.pbi_pgid,
                "startSeconds":info.pbi_start_tvsec.to_string(),
                "startMicros":info.pbi_start_tvusec.to_string(),
                "status":info.pbi_status,
                "flags":info.pbi_flags,
                // Darwin sys/proc.h defines SZOMB as 5.
                "zombie":info.pbi_status == 5
            }
        })
    }

    pub fn run() -> Result<(), String> {
        let args: Vec<_> = env::args_os().collect();
        if args.get(1).is_some_and(|arg| arg == "--observe") {
            if args.len() != 3 {
                return Err("usage: --observe PID".into());
            }
            let pid = args[2]
                .to_str()
                .ok_or("non-UTF8 PID")?
                .parse::<u32>()
                .map_err(|_| "invalid PID")?;
            println!("{}", observe(pid));
            return Ok(());
        }

        let python = env::var_os("CAWS_PROBE_REAL_PYTHON").ok_or("missing real interpreter")?;
        if !Path::new(&python).is_absolute() {
            return Err("interpreter must be absolute".into());
        }
        let daemon = env::var_os("CAWS_PROBE_DAEMON").ok_or("missing daemon path")?;
        let renderer = env::var_os("CAWS_PROBE_RENDERER").ok_or("missing renderer path")?;
        let witness = if args.get(1) == Some(&daemon) {
            Some("CAWS_PROBE_WITNESS")
        } else if args.get(1) == Some(&renderer) {
            Some("CAWS_PROBE_RENDER_WITNESS")
        } else {
            None
        };
        if let Some(variable) = witness {
            let directory = env::var_os(variable).ok_or("missing witness directory")?;
            let value = observe(std::process::id());
            if value["state"] != "observed" {
                return Err(format!("self observation unavailable: {value}"));
            }
            let p = &value["process"];
            let stem = format!(
                "{}-{}-{}",
                std::process::id(),
                p["startSeconds"].as_str().ok_or("missing seconds")?,
                p["startMicros"].as_str().ok_or("missing micros")?
            );
            let temporary = Path::new(&directory).join(format!("{stem}.pending"));
            let published = Path::new(&directory).join(format!("{stem}.json"));
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&temporary)
                .map_err(|e| e.to_string())?;
            serde_json::to_writer(&mut file, &value).map_err(|e| e.to_string())?;
            file.write_all(b"\n").map_err(|e| e.to_string())?;
            drop(file);
            fs::rename(temporary, published).map_err(|e| e.to_string())?;
        }

        // Exec retains this PID, birth identity and process group. No extra child.
        Err(format!(
            "interpreter exec failed: {}",
            Command::new(python).args(args.iter().skip(1)).exec()
        ))
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    if let Err(error) = darwin::run() {
        eprintln!("{error}");
        std::process::exit(3);
    }
    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("service-observer supports Darwin qualification only");
        std::process::exit(3);
    }
}

#[cfg(not(unix))]
compile_error!("caws-native currently requires POSIX process groups");

mod cancellation;
mod cli;
mod protocol;
mod runner;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Even malformed configuration must refuse a recognizable guarded event.
    let guarded = args
        .windows(2)
        .any(|v| v[0] == "--event" && v[1] == "pre_tool_use");
    let result = cancellation::install()
        .and_then(|()| cli::Config::parse(&args))
        .map_err(runner::Failure::configuration)
        .and_then(|config| {
            let deadline = std::time::Instant::now() + config.timeout;
            let (payload, input_json) =
                runner::read_payload(deadline).map_err(runner::Failure::configuration)?;
            let request = protocol::Request::new(&config, payload, input_json, deadline)
                .map_err(runner::Failure::configuration)?;
            let bytes = serde_json::to_vec(&request)
                .map_err(|e| runner::Failure::configuration(format!("request encoding: {e}")))?;
            let response = runner::invoke(&config, &bytes, deadline)?;
            protocol::validate_response(&response, &request).map_err(runner::Failure::execution)
        });
    let (code, stdout, stderr) = match result {
        Ok(value) => (value.exit_code, value.stdout, value.stderr),
        Err(error) => {
            let reason = format!(
                "CAWS native infrastructure failure ({}): {}. Checks did not complete; request was not retried.{}",
                if error.started {
                    "execution"
                } else {
                    "configuration"
                },
                error.message,
                if error.started {
                    " Execution outcome may be uncertain."
                } else {
                    ""
                }
            );
            let stdout = if guarded {
                format!(
                    "{}\n",
                    serde_json::json!({"decision":"block", "reason":reason})
                )
            } else {
                String::new()
            };
            (
                if guarded || error.started { 2 } else { 0 },
                stdout,
                format!("{reason}\n"),
            )
        }
    };
    // Bounded local writes are not an acknowledgment from the native consumer.
    if let Err(error) = runner::write_native(&stdout, &stderr) {
        runner::write_diagnostic(&format!(
            "{stderr}CAWS native output delivery failed: {error}. Output may be partial; consumer receipt is unconfirmed.\n"
        ));
        std::process::exit(2);
    }
    std::process::exit(code.into());
}

fn main() {
    println!("cargo:rerun-if-changed=src/process_comm_macos.c");
    println!("cargo:rerun-if-changed=examples/process-comm-vis-oracle.c");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/process_comm_macos.c")
            .std("c11")
            .warnings(true)
            .extra_warnings(true)
            .compile("caws_process_comm_macos");
        // Qualification-only symbols: referenced by the comparison example,
        // never by the production observer or metadata bridge.
        cc::Build::new()
            .file("examples/process-comm-vis-oracle.c")
            .std("c11")
            .warnings(true)
            .extra_warnings(true)
            .compile("caws_process_comm_vis_oracle");
    }
}

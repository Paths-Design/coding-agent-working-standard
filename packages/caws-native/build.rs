fn main() {
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_SQLITE_STORE");
    #[cfg(feature = "sqlite-store")]
    sqlite_prefix::verify();
    println!("cargo:rerun-if-changed=src/process_comm_macos.c");
    println!("cargo:rerun-if-changed=src/owned_group_macos.c");
    println!("cargo:rerun-if-changed=examples/process-comm-vis-oracle.c");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/owned_group_macos.c")
            .std("c11")
            .warnings(true)
            .extra_warnings(true)
            .compile("caws_owned_group_macos");
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

// This is a second check when the parent build script executes. Only the
// external coordinator's pre-Cargo check and fresh target prevent cache reuse.
#[cfg(feature = "sqlite-store")]
mod sqlite_prefix {
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use std::{
        env, fs,
        io::Read,
        os::unix::{fs::MetadataExt, fs::OpenOptionsExt},
        path::{Path, PathBuf},
    };

    fn required(name: &str) -> String {
        println!("cargo:rerun-if-env-changed={name}");
        env::var(name).unwrap_or_else(|_| {
            panic!("CAWS SQLite prefix: missing {name}; use the native SQLite build coordinator")
        })
    }
    fn text<'a>(value: &'a Value, key: &str) -> &'a str {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("CAWS SQLite prefix: missing string {key}"))
    }
    fn sha(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }
    fn read_regular(path: &Path, bound: u64) -> Vec<u8> {
        assert!(
            path.is_absolute(),
            "CAWS SQLite prefix: absolute paths required"
        );
        assert_eq!(
            fs::canonicalize(path).expect("CAWS SQLite prefix: canonical path"),
            path,
            "CAWS SQLite prefix: symlink or noncanonical path"
        );
        let before = fs::symlink_metadata(path).expect("CAWS SQLite prefix: metadata");
        assert!(
            before.is_file() && !before.file_type().is_symlink() && before.len() <= bound,
            "CAWS SQLite prefix: regular bounded file required"
        );
        let mut file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .expect("CAWS SQLite prefix: open");
        let opened = file
            .metadata()
            .expect("CAWS SQLite prefix: opened metadata");
        let same = |a: &fs::Metadata, b: &fs::Metadata| {
            a.is_file()
                && b.is_file()
                && a.dev() == b.dev()
                && a.ino() == b.ino()
                && a.len() == b.len()
                && a.mode() == b.mode()
                && a.mtime() == b.mtime()
                && a.mtime_nsec() == b.mtime_nsec()
                && a.ctime() == b.ctime()
                && a.ctime_nsec() == b.ctime_nsec()
        };
        assert!(same(&before, &opened), "CAWS SQLite prefix: replaced input");
        let mut bytes = Vec::new();
        (&mut file)
            .take(bound + 1)
            .read_to_end(&mut bytes)
            .expect("CAWS SQLite prefix: read");
        let after_handle = file
            .metadata()
            .expect("CAWS SQLite prefix: final handle metadata");
        let after_path = fs::symlink_metadata(path).expect("CAWS SQLite prefix: final metadata");
        assert!(
            !after_path.file_type().is_symlink()
                && bytes.len() as u64 == before.len()
                && same(&opened, &after_handle)
                && same(&opened, &after_path),
            "CAWS SQLite prefix: changed input"
        );
        bytes
    }
    fn pin(value: &Value, key: &str) -> PathBuf {
        let item = value.get(key).expect("CAWS SQLite prefix: missing pin");
        let path = PathBuf::from(text(item, "path"));
        let size = item
            .get("sizeBytes")
            .and_then(Value::as_u64)
            .expect("CAWS SQLite prefix: file size");
        assert!(
            size > 0 && size <= 32 * 1024 * 1024,
            "CAWS SQLite prefix: invalid file size"
        );
        let expected = text(item, "sha256");
        assert!(
            expected.len() == 64
                && expected
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "CAWS SQLite prefix: invalid digest"
        );
        let bytes = read_regular(&path, size);
        assert_eq!(
            bytes.len() as u64,
            size,
            "CAWS SQLite prefix: size mismatch"
        );
        assert_eq!(sha(&bytes), expected, "CAWS SQLite prefix: hash mismatch");
        println!("cargo:rerun-if-changed={}", path.display());
        path
    }
    pub fn verify() {
        assert_eq!(
            required("TARGET"),
            "aarch64-apple-darwin",
            "CAWS SQLite prefix: unsupported target"
        );
        let manifest = PathBuf::from(required("CAWS_SQLITE_PREFIX_MANIFEST"));
        let digest = required("CAWS_SQLITE_PREFIX_MANIFEST_SHA256");
        let bytes = read_regular(&manifest, 65536);
        assert_eq!(
            sha(&bytes),
            digest,
            "CAWS SQLite prefix: manifest hash mismatch"
        );
        let value: Value =
            serde_json::from_slice(&bytes).expect("CAWS SQLite prefix: manifest JSON");
        assert_eq!(text(&value, "schema"), "caws.sqlite_prefix.v1");
        assert_eq!(text(&value, "target"), "aarch64-apple-darwin");
        assert_eq!(
            text(&value, "sourceId"),
            "2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc"
        );
        let archive = pin(&value, "archive");
        let header = pin(&value, "header");
        let object = pin(&value, "object");
        let bindings = pin(&value, "bindings");
        assert_eq!(
            archive.file_name().and_then(|v| v.to_str()),
            Some("libsqlite3.a")
        );
        assert_eq!(
            header.file_name().and_then(|v| v.to_str()),
            Some("sqlite3.h")
        );
        assert_eq!(
            object.file_name().and_then(|v| v.to_str()),
            Some("sqlite3.o")
        );
        let prefix_root = manifest
            .parent()
            .expect("CAWS SQLite prefix: manifest parent");
        assert_eq!(archive.parent(), Some(prefix_root.join("lib").as_path()));
        assert_eq!(header.parent(), Some(prefix_root.join("include").as_path()));
        assert_eq!(object.parent(), Some(prefix_root.join("objects").as_path()));
        assert_eq!(
            text(value.get("header").expect("header pin"), "sha256"),
            "919e7f2e8ed1d8f56ac17b412b8971c76aa5d1a879752cc6058f75e7d5910e1d"
        );
        assert!(
            bindings.ends_with("libsqlite3-sys-0.38.2/bindgen-bindings/bindgen_3.34.1.rs"),
            "CAWS SQLite prefix: unexpected pregenerated bindings"
        );
        assert_eq!(
            Path::new(&required("SQLITE3_LIB_DIR")),
            archive.parent().expect("archive parent")
        );
        assert_eq!(
            Path::new(&required("SQLITE3_INCLUDE_DIR")),
            header.parent().expect("header parent")
        );
        assert_eq!(required("SQLITE3_STATIC"), "1");
        assert_eq!(required("SQLITE3_NO_PKG_CONFIG"), "1");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-env=CAWS_SQLITE_PREFIX_SHA256={digest}");
    }
}

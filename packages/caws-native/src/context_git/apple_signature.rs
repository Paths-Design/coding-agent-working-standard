//! Static Apple code authentication. This establishes provenance, not semantic
//! qualification, path protection, execution custody or project authority.
use std::path::Path;

#[cfg(target_os = "macos")]
pub(super) fn authenticate(path: &Path, requirement: &str) -> Result<(), String> {
    platform::authenticate(path, requirement)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn authenticate(_: &Path, _: &str) -> Result<(), String> {
    Err("maintained Git requires macOS Apple signing".into())
}

#[cfg(target_os = "macos")]
mod platform {
    use std::{ffi::c_void, os::unix::ffi::OsStrExt, path::Path};
    type Ref = *const c_void;
    const VALIDATION_FLAGS: u32 = (1 << 0) | (1 << 4) | (1 << 29);

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFURLCreateFromFileSystemRepresentation(
            allocator: Ref,
            bytes: *const u8,
            length: isize,
            directory: u8,
        ) -> Ref;
        fn CFStringCreateWithCString(
            allocator: Ref,
            text: *const libc::c_char,
            encoding: u32,
        ) -> Ref;
        fn CFRelease(value: Ref);
    }
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecStaticCodeCreateWithPath(path: Ref, flags: u32, code: *mut Ref) -> i32;
        fn SecRequirementCreateWithString(text: Ref, flags: u32, requirement: *mut Ref) -> i32;
        fn SecStaticCodeCheckValidity(code: Ref, flags: u32, requirement: Ref) -> i32;
    }
    struct Owned(Ref);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) }
            }
        }
    }
    pub(super) fn authenticate(path: &Path, requirement: &str) -> Result<(), String> {
        let bytes = path.as_os_str().as_bytes();
        let requirement = std::ffi::CString::new(requirement).map_err(|e| e.to_string())?;
        let url = Owned(unsafe {
            CFURLCreateFromFileSystemRepresentation(
                std::ptr::null(),
                bytes.as_ptr(),
                bytes.len() as isize,
                0,
            )
        });
        let text = Owned(unsafe {
            CFStringCreateWithCString(std::ptr::null(), requirement.as_ptr(), 0x08000100)
        });
        if url.0.is_null() || text.0.is_null() {
            return Err("Apple signature input allocation failed".into());
        }
        let mut code = Owned(std::ptr::null());
        let mut parsed = Owned(std::ptr::null());
        let a = unsafe { SecStaticCodeCreateWithPath(url.0, 0, &mut code.0) };
        let b = unsafe { SecRequirementCreateWithString(text.0, 0, &mut parsed.0) };
        if a != 0 || b != 0 {
            return Err(format!(
                "Apple signature object/requirement refused: {a}/{b}"
            ));
        }
        validate_signature_with(code.0, parsed.0, SecStaticCodeCheckValidity)
    }
    fn validate_signature_with(
        code: Ref,
        requirement: Ref,
        check: unsafe extern "C" fn(Ref, u32, Ref) -> i32,
    ) -> Result<(), String> {
        let status = unsafe { check(code, VALIDATION_FLAGS, requirement) };
        if status != 0 {
            return Err(format!("Apple signature requirement refused: {status}"));
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::{AtomicU32, Ordering};
        static OBSERVED_FLAGS: AtomicU32 = AtomicU32::new(0);
        unsafe extern "C" fn observe_flags(_: Ref, flags: u32, _: Ref) -> i32 {
            OBSERVED_FLAGS.store(flags, Ordering::SeqCst);
            0
        }
        #[test]
        fn signing_port_requires_no_network_strict_and_all_architectures() {
            validate_signature_with(std::ptr::null(), std::ptr::null(), observe_flags).unwrap();
            let flags = OBSERVED_FLAGS.load(Ordering::SeqCst);
            assert_ne!(flags & (1 << 29), 0);
            assert_ne!(flags & (1 << 4), 0);
            assert_ne!(flags & (1 << 0), 0);
        }
        #[test]
        fn signing_port_preserves_security_framework_refusal() {
            unsafe extern "C" fn refuse(_: Ref, _: u32, _: Ref) -> i32 {
                -2147409622
            }
            assert_eq!(
                validate_signature_with(std::ptr::null(), std::ptr::null(), refuse).unwrap_err(),
                "Apple signature requirement refused: -2147409622"
            );
        }
    }
}

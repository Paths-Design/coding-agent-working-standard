//! Darwin representation reader for the C-locale, piped `/bin/ps -o comm=`
//! representation. This observes mutable process text, not project authority or
//! logical-session ownership. The native observer brackets this lookup with
//! its parent/birth observations and retains its signal-time instance recheck.
//!
//! Algorithm reference: Apple's adv_cmds-237 ps/keyword.c:96 and print.c:108-392.
//! `comm` reads argv[0], not the saved executable path, and applies strvis with
//! VIS_TAB | VIS_NL | VIS_NOSLASH. Zombie and argument-read fallbacks are distinct.
//! The C bridge uses actual SDK kinfo_proc declarations, never copied offsets.
//!
//! Bounds: at most 1 MiB of kernel argument storage, 64 bytes for the bridge's
//! bounded SDK command field, and 4096 rendered bytes. An unsupported larger
//! KERN_ARGMAX is unavailable, not a truncation or executable-path substitution.
//! Deadlines are checked before/after each kernel call and bounded CPU work;
//! they cannot interrupt a stalled kernel syscall. No global locale is changed.
use std::time::Instant;

pub const COMM_LIMIT: usize = 4096;
pub const MAX_PROCARGS_BYTES: usize = 1_048_576;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fallback {
    ArgumentLimitLookup,
    ArgumentAllocation,
    ArgumentLookup,
    MalformedArguments,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Representation {
    Argv0,
    Zombie,
    KernelFallback(Fallback),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unavailable {
    UnsupportedPlatform,
    KernelSnapshot,
    ArgumentSizeLimit,
    RenderedSizeLimit,
    Allocation,
    EmbeddedNul,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadError {
    InvalidPid,
    Deadline,
    Unavailable(Unavailable),
}

// No Debug implementation: observation bytes must be reflected only deliberately
// by the controlled-fixture comparator, never through an error/log formatter.
pub struct Observation {
    comm: Vec<u8>,
    representation: Representation,
}
impl Observation {
    pub fn comm_bytes(&self) -> &[u8] {
        &self.comm
    }
    pub fn representation(&self) -> Representation {
        self.representation
    }
}

fn checkpoint(expires: Instant) -> Result<(), ReadError> {
    if Instant::now() >= expires {
        Err(ReadError::Deadline)
    } else {
        Ok(())
    }
}

/// Read representation only. The consuming observer must retain its existing
/// native parent/birth observations around this call and its signal-time recheck.
/// This API neither signals nor accepts an asserted process identity.
pub fn read(pid: u32, expires: Instant) -> Result<Observation, ReadError> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(ReadError::InvalidPid);
    }
    checkpoint(expires)?;
    #[cfg(target_os = "macos")]
    {
        platform::read(pid, expires)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(ReadError::Unavailable(Unavailable::UnsupportedPlatform))
    }
}

#[cfg(any(target_os = "macos", test))]
fn argv0(bytes: &[u8]) -> Option<&[u8]> {
    // Darwin c_int is four bytes. Read without alignment assumptions.
    let nargs = i32::from_ne_bytes(bytes.get(..4)?.try_into().ok()?);
    if nargs <= 0 {
        return None;
    }
    let strings = bytes.get(4..)?;
    let end_path = strings.iter().position(|b| *b == 0)?;
    // Match Apple's skip of saved exec_path and all following NUL padding. This
    // also preserves its treatment of an empty argv[0] followed by another arg.
    let tail = strings.get(end_path..)?;
    let start = tail.iter().position(|b| *b != 0)?;
    let first = tail.get(start..)?;
    let end = first.iter().position(|b| *b == 0)?;
    first.get(..end).filter(|s| !s.is_empty())
}

#[cfg(any(target_os = "macos", test))]
/// Format already-delimited, non-NUL process bytes exactly as C-locale strvis
/// with VIS_TAB | VIS_NL | VIS_NOSLASH, subject to the production byte limit.
/// The separate qualifier compares this implementation with actual System strvis;
/// expected-string unit tests alone do not establish formatter parity.
pub fn format_c_locale(raw: &[u8]) -> Result<Vec<u8>, ReadError> {
    if raw.contains(&0) {
        return Err(ReadError::Unavailable(Unavailable::EmbeddedNul));
    }
    if raw.len() > COMM_LIMIT {
        return Err(ReadError::Unavailable(Unavailable::RenderedSizeLimit));
    }
    let mut out = Vec::new();
    out.try_reserve_exact(COMM_LIMIT)
        .map_err(|_| ReadError::Unavailable(Unavailable::Allocation))?;
    for &byte in raw {
        let mut encoded = [0u8; 4];
        let piece: &[u8] = match byte {
            b' '..=b'~' => {
                encoded[0] = byte;
                &encoded[..1]
            }
            b'\t' => b"\\011",
            b'\n' => b"\\012",
            0xa0 => b"\\240", // High-bit space uses octal even with NOSLASH.
            _ => {
                let mut at = 0;
                let low = byte & 0x7f;
                if byte & 0x80 != 0 {
                    encoded[at] = b'M';
                    at += 1;
                }
                if low < 0x20 || low == 0x7f {
                    encoded[at] = b'^';
                    encoded[at + 1] = if low == 0x7f { b'?' } else { low + b'@' };
                } else {
                    encoded[at] = b'-';
                    encoded[at + 1] = low;
                }
                &encoded[..at + 2]
            }
        };
        if out.len() + piece.len() > COMM_LIMIT {
            return Err(ReadError::Unavailable(Unavailable::RenderedSizeLimit));
        }
        out.extend_from_slice(piece);
    }
    Ok(out)
}

#[cfg(any(target_os = "macos", test))]
fn fallback(comm: &[u8], reason: Fallback) -> Result<Observation, ReadError> {
    // The SDK bridge bounds this input. The same helper is used by hostile tests.
    if comm.len() > 64 || comm.contains(&0) {
        return Err(ReadError::Unavailable(Unavailable::KernelSnapshot));
    }
    let mut raw = Vec::with_capacity(comm.len() + 2);
    raw.push(b'(');
    raw.extend_from_slice(comm);
    raw.push(b')');
    Ok(Observation {
        comm: format_c_locale(&raw)?,
        representation: Representation::KernelFallback(reason),
    })
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::{mem, ptr};

    unsafe extern "C" {
        fn caws_native_kinfo_comm(
            pid: libc::pid_t,
            is_zombie: *mut libc::c_int,
            comm: *mut u8,
            capacity: libc::size_t,
            comm_length: *mut libc::size_t,
        ) -> libc::c_int;
    }

    enum Arguments {
        Bytes(Vec<u8>),
        Fallback(Fallback),
    }
    fn arguments(pid: u32, expires: Instant) -> Result<Arguments, ReadError> {
        checkpoint(expires)?;
        let mut argmax: libc::c_int = 0;
        let mut size = mem::size_of_val(&argmax);
        let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
        // SAFETY: real libc signature, writable c_int and its exact byte length.
        let status = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                2,
                (&mut argmax as *mut libc::c_int).cast(),
                &mut size,
                ptr::null_mut(),
                0,
            )
        };
        checkpoint(expires)?;
        if status != 0 || size != mem::size_of_val(&argmax) || argmax <= 4 {
            return Ok(Arguments::Fallback(Fallback::ArgumentLimitLookup));
        }
        let capacity = argmax as usize;
        if capacity > MAX_PROCARGS_BYTES {
            return Err(ReadError::Unavailable(Unavailable::ArgumentSizeLimit));
        }
        let mut bytes = Vec::new();
        if bytes.try_reserve_exact(capacity).is_err() {
            return Ok(Arguments::Fallback(Fallback::ArgumentAllocation));
        }
        bytes.resize(capacity, 0);
        let mut size = capacity;
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
        checkpoint(expires)?;
        // SAFETY: bytes owns exactly capacity writable bytes and size starts at
        // capacity. No kernel bytes are logged or retained by this module.
        let status = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                bytes.as_mut_ptr().cast(),
                &mut size,
                ptr::null_mut(),
                0,
            )
        };
        checkpoint(expires)?;
        if status != 0 {
            return Ok(Arguments::Fallback(Fallback::ArgumentLookup));
        }
        if size > capacity {
            return Err(ReadError::Unavailable(Unavailable::ArgumentSizeLimit));
        }
        bytes.truncate(size);
        Ok(Arguments::Bytes(bytes))
    }

    pub(super) fn read(pid: u32, expires: Instant) -> Result<Observation, ReadError> {
        let mut comm = [0u8; 64];
        let mut comm_length = 0;
        let mut is_zombie = -1;
        checkpoint(expires)?;
        // SAFETY: the SDK-compiled bridge receives initialized primitive outputs
        // and a live bounded byte buffer; it exports no kinfo_proc layout to Rust.
        let status = unsafe {
            caws_native_kinfo_comm(
                pid as libc::pid_t,
                &mut is_zombie,
                comm.as_mut_ptr(),
                comm.len(),
                &mut comm_length,
            )
        };
        checkpoint(expires)?;
        if status != 0 || comm_length > comm.len() || !matches!(is_zombie, 0 | 1) {
            return Err(ReadError::Unavailable(Unavailable::KernelSnapshot));
        }
        let comm = &comm[..comm_length];
        if comm.contains(&0) {
            return Err(ReadError::Unavailable(Unavailable::KernelSnapshot));
        }
        let observation = if is_zombie == 1 {
            Observation {
                comm: b"<defunct>".to_vec(),
                representation: Representation::Zombie,
            }
        } else {
            match arguments(pid, expires)? {
                Arguments::Fallback(reason) => fallback(comm, reason)?,
                Arguments::Bytes(bytes) => match argv0(&bytes) {
                    Some(raw) => Observation {
                        comm: format_c_locale(raw)?,
                        representation: Representation::Argv0,
                    },
                    None => fallback(comm, Fallback::MalformedArguments)?,
                },
            }
        };
        checkpoint(expires)?;
        Ok(observation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    fn args(count: i32, rest: &[u8]) -> Vec<u8> {
        let mut out = count.to_ne_bytes().to_vec();
        out.extend_from_slice(rest);
        out
    }
    #[test]
    fn argv_is_not_saved_exec_path_script_argument_or_environment() {
        let bytes = args(
            3,
            b"/saved/interpreter\0\0\0chosen argv0\0script.py\0x=y\0SECRET=hidden\0",
        );
        assert_eq!(argv0(&bytes), Some(b"chosen argv0".as_slice()));
    }
    #[test]
    fn padding_and_empty_argv0_follow_apple_skip_algorithm() {
        assert_eq!(
            argv0(&args(2, b"/path\0\0\0next-argument\0ENV=x\0")),
            Some(b"next-argument".as_slice())
        );
        assert_eq!(argv0(&args(1, b"\0name\0")), Some(b"name".as_slice()));
    }
    #[test]
    fn malformed_count_truncation_missing_path_and_missing_terminator_have_no_argv() {
        for bytes in [
            vec![],
            vec![1, 0, 0],
            args(0, b"/x\0name\0"),
            args(-1, b"/x\0name\0"),
            args(1, b"unterminated"),
            args(1, b"/x\0\0\0"),
            args(1, b"/x\0unterminated"),
        ] {
            assert_eq!(argv0(&bytes), None);
        }
    }
    #[test]
    fn c_locale_vis_has_exact_octal_control_high_bit_and_literal_rules() {
        assert_eq!(
            format_c_locale(b" /with spaces\\literal ^M () ").unwrap(),
            b" /with spaces\\literal ^M () "
        );
        assert_eq!(
            format_c_locale(b"\t\n\r\x01\x1b\x7f").unwrap(),
            b"\\011\\012^M^A^[^?"
        );
        assert_eq!(
            format_c_locale(b"\x80\x89\x8a\x9f\xa0\xa1\xc3\xa9\xfe\xff").unwrap(),
            b"M^@M^IM^JM^_\\240M-!M-CM-)M-~M^?"
        );
        assert_eq!(
            format_c_locale(&[0]),
            Err(ReadError::Unavailable(Unavailable::EmbeddedNul))
        );
    }
    #[test]
    fn all_ascii_graphics_and_space_remain_byte_identical() {
        let input: Vec<u8> = (32..=126).collect();
        assert_eq!(format_c_locale(&input).unwrap(), input);
        for byte in 1..=255 {
            let value = format_c_locale(&[byte]).unwrap();
            assert!(value.is_ascii());
            assert!(!value.contains(&0));
            assert!(!value.contains(&b'\n'));
        }
    }
    #[test]
    fn size_limit_applies_after_expansion_without_truncating() {
        assert_eq!(
            format_c_locale(&vec![b'x'; COMM_LIMIT]).unwrap(),
            vec![b'x'; COMM_LIMIT]
        );
        assert_eq!(
            format_c_locale(&vec![b'\t'; COMM_LIMIT / 4]).unwrap().len(),
            COMM_LIMIT
        );
        for input in [vec![b'x'; COMM_LIMIT + 1], vec![b'\t'; COMM_LIMIT / 4 + 1]] {
            assert_eq!(
                format_c_locale(&input),
                Err(ReadError::Unavailable(Unavailable::RenderedSizeLimit))
            );
        }
    }
    #[test]
    fn kernel_fallback_is_parenthesized_then_escaped_and_never_a_path_guess() {
        for reason in [
            Fallback::ArgumentLimitLookup,
            Fallback::ArgumentAllocation,
            Fallback::ArgumentLookup,
            Fallback::MalformedArguments,
        ] {
            let observation = fallback(b"worker\tname", reason).unwrap();
            assert_eq!(observation.comm_bytes(), b"(worker\\011name)");
            assert_eq!(
                observation.representation(),
                Representation::KernelFallback(reason)
            );
        }
        assert_eq!(
            fallback(b"", Fallback::ArgumentLookup)
                .unwrap()
                .comm_bytes(),
            b"()"
        );
        assert!(matches!(
            fallback(&[b'x'; 65], Fallback::ArgumentLookup),
            Err(ReadError::Unavailable(Unavailable::KernelSnapshot))
        ));
        assert!(matches!(
            fallback(b"x\0y", Fallback::ArgumentLookup),
            Err(ReadError::Unavailable(Unavailable::KernelSnapshot))
        ));
    }
    #[test]
    fn invalid_pid_and_expired_deadline_return_typed_errors() {
        let future = Instant::now() + Duration::from_secs(1);
        for pid in [0, i32::MAX as u32 + 1, u32::MAX] {
            assert!(matches!(read(pid, future), Err(ReadError::InvalidPid)));
        }
        assert!(matches!(read(1, Instant::now()), Err(ReadError::Deadline)));
    }
}

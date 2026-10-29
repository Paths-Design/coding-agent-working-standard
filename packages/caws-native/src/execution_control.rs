//! Single-threaded post-startup carrier liveness and cancellation.
//!
//! The caller establishes peer identity and consumes the entire startup frame
//! before handing this connected endpoint over. No buffered startup reader may
//! retain control bytes. This channel is a liveness signal, never authorization.
//! Construct before spawn; `poll` neither opens/closes descriptors nor reaps.
use std::{
    cell::Cell,
    io,
    os::{
        fd::{AsFd, AsRawFd, BorrowedFd},
        unix::net::UnixStream,
    },
};

/// The only valid post-startup byte. EOF is a separate sticky loss condition.
pub(crate) const CANCEL_BYTE: u8 = 0x01;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ControlFailure {
    Cancelled,
    PeerLost,
    Protocol,
    Unavailable,
}

/// Owns exactly the inherited endpoint. Cell intentionally prevents Sync; the
/// worker polls it in its own thread, with a quiescent descriptor table at spawn.
pub(crate) struct ExecutionControl {
    endpoint: UnixStream,
    failed: Cell<Option<ControlFailure>>,
}

impl ExecutionControl {
    /// Consumes a connected endpoint only after the private startup frame has
    /// been fully consumed and authenticated elsewhere. Setting nonblocking may
    /// affect any duplicate of this open file description, so the caller must
    /// transfer exclusive ownership of the endpoint and its I/O protocol.
    pub(crate) fn new(endpoint: UnixStream) -> io::Result<Self> {
        endpoint.set_nonblocking(true)?;
        Ok(Self {
            endpoint,
            failed: Cell::new(None),
        })
    }

    /// A borrowed descriptor for startup/hygiene integration, not a duplicate.
    pub(crate) fn as_fd(&self) -> BorrowedFd<'_> {
        self.endpoint.as_fd()
    }

    /// No data means the peer has not signaled cancellation; it does not prove
    /// identity, policy permission, or that a concurrent loss cannot race exec.
    pub(crate) fn poll(&self) -> Result<(), ControlFailure> {
        if let Some(reason) = self.failed.get() {
            return Err(reason);
        }
        let mut byte = 0u8;
        // SAFETY: byte is writable and the borrowed socket remains open during
        // this synchronous nonblocking call. No fd flags are changed here.
        let count = unsafe {
            libc::recv(
                self.endpoint.as_raw_fd(),
                (&mut byte as *mut u8).cast(),
                1,
                libc::MSG_DONTWAIT,
            )
        };
        let result = if count == 0 {
            Err(ControlFailure::PeerLost)
        } else if count == 1 {
            if byte == CANCEL_BYTE {
                Err(ControlFailure::Cancelled)
            } else {
                Err(ControlFailure::Protocol)
            }
        } else if count < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::WouldBlock {
                Ok(())
            } else {
                Err(ControlFailure::Unavailable)
            }
        } else {
            Err(ControlFailure::Unavailable)
        };
        if let Err(reason) = result {
            self.failed.set(Some(reason));
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::Shutdown;

    #[test]
    fn live_and_cancel_are_observed_and_cancel_stays_sticky_on_close() {
        let (read, mut write) = UnixStream::pair().unwrap();
        let control = ExecutionControl::new(read).unwrap();
        assert_eq!(control.poll(), Ok(()));
        write.write_all(&[CANCEL_BYTE]).unwrap();
        assert_eq!(control.poll(), Err(ControlFailure::Cancelled));
        drop(write);
        assert_eq!(control.poll(), Err(ControlFailure::Cancelled));
    }
    #[test]
    fn malformed_byte_is_sticky_even_if_cancel_follows() {
        let (read, mut write) = UnixStream::pair().unwrap();
        let control = ExecutionControl::new(read).unwrap();
        write.write_all(&[0xff, CANCEL_BYTE]).unwrap();
        assert_eq!(control.poll(), Err(ControlFailure::Protocol));
        assert_eq!(control.poll(), Err(ControlFailure::Protocol));
    }
    #[test]
    fn eof_is_sticky_and_queued_cancel_precedes_eof() {
        let (read, write) = UnixStream::pair().unwrap();
        let control = ExecutionControl::new(read).unwrap();
        write.shutdown(Shutdown::Write).unwrap();
        assert_eq!(control.poll(), Err(ControlFailure::PeerLost));
        assert_eq!(control.poll(), Err(ControlFailure::PeerLost));
        let (read, mut write) = UnixStream::pair().unwrap();
        let control = ExecutionControl::new(read).unwrap();
        write.write_all(&[CANCEL_BYTE]).unwrap();
        write.shutdown(Shutdown::Write).unwrap();
        assert_eq!(control.poll(), Err(ControlFailure::Cancelled));
        assert_eq!(control.poll(), Err(ControlFailure::Cancelled));
    }
    #[test]
    fn polling_leaves_other_descriptors_and_their_data_alone() {
        let (read, _write) = UnixStream::pair().unwrap();
        let (mut other, mut other_peer) = UnixStream::pair().unwrap();
        let flags = unsafe { libc::fcntl(other.as_raw_fd(), libc::F_GETFL) };
        assert!(flags >= 0);
        let control = ExecutionControl::new(read).unwrap();
        assert_eq!(control.as_fd().as_raw_fd(), control.endpoint.as_raw_fd());
        other_peer.write_all(b"untouched").unwrap();
        assert_eq!(control.poll(), Ok(()));
        assert_eq!(
            unsafe { libc::fcntl(other.as_raw_fd(), libc::F_GETFL) },
            flags
        );
        let mut bytes = [0; 9];
        other.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"untouched");
    }
}

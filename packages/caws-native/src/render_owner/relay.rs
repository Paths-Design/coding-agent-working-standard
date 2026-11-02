//! Seal-only owner relay and the shared heavy-operation frontier. SQL row
//! controls keep their separate narrow protocol; publication credit is independent.
use super::*;
use crate::{session_publication as publication, session_publication_wire as publication_wire};
use std::sync::atomic::AtomicBool;
pub(super) const REPLY_SCHEMA: &str = "caws.render.owner.session-relay-reply.v1";
pub(super) const REPLY_MAX: usize = publication_wire::MAX_RELAY_FRAME_BYTES;

#[derive(Debug)]
pub(super) struct OperationCapacity {
    used: AtomicUsize,
    maximum: usize,
}
impl OperationCapacity {
    pub(super) fn new(maximum: usize) -> Arc<Self> {
        assert!(
            (1..=256).contains(&maximum),
            "operation frontier must remain within 256"
        );
        Arc::new(Self {
            used: AtomicUsize::new(0),
            maximum,
        })
    }
    pub(super) fn acquire(self: &Arc<Self>) -> Result<OperationPermit> {
        self.used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                (used < self.maximum).then_some(used + 1)
            })
            .map_err(|_| "shared session operation capacity exhausted before effects".to_owned())?;
        Ok(OperationPermit(Arc::clone(self)))
    }
    pub(super) fn retained(&self) -> bool {
        self.used.load(Ordering::Acquire) != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn publication_write_uses_only_its_derived_outer_envelope() {
        let inner = publication_wire::MAX_FRAME_BYTES;
        let (owner, mut caller) = UnixStream::pair().unwrap();
        owner.set_nonblocking(true).unwrap();
        caller.set_nonblocking(true).unwrap();
        let (sender, replies) = mpsc::sync_channel(1);
        let join = thread::spawn(move || {
            let mut relay = Relay {
                stream: owner,
                replies,
                cancelled: Arc::new(AtomicBool::new(false)),
                sequence: 0,
                expires: Instant::now() + Duration::from_secs(10),
                limit: inner,
            };
            publication::Transport::write(
                &mut relay,
                &vec![b'x'; inner],
                Instant::now() + Duration::from_secs(10),
            )
            .unwrap();
            assert!(
                publication::Transport::write(
                    &mut relay,
                    &vec![b'x'; inner + 1],
                    Instant::now() + Duration::from_secs(10)
                )
                .unwrap_err()
                .contains("write bound")
            );
        });
        let bytes = frame(
            &mut caller,
            &mut Vec::new(),
            publication_wire::MAX_RELAY_FRAME_BYTES,
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();
        assert!(bytes.len() > inner);
        match decode_owner_frame(&bytes, inner).unwrap() {
            Frame::WriteEngineFrame { sequence, base64 } => {
                assert_eq!(sequence, 1);
                assert_eq!(STANDARD.decode(base64).unwrap(), vec![b'x'; inner]);
            }
            _ => panic!("wrong publication variant"),
        }
        sender
            .send(Reply {
                schema: REPLY_SCHEMA.into(),
                sequence: 1,
                result: Ok(Value::Written),
            })
            .unwrap();
        join.join().unwrap();
        let wrong = encoded(
            &Frame::<session::SessionCompletion>::Registered {
                id: "x".repeat(inner),
                runtime_digest: "a".repeat(64),
                registration: "b".repeat(64),
            },
            publication_wire::MAX_RELAY_FRAME_BYTES,
        )
        .unwrap();
        assert!(
            decode_owner_frame(&wrong, inner)
                .err()
                .unwrap()
                .contains("variant envelope bound")
        );
    }
    #[test]
    fn publication_credit_refuses_wrong_ack_sequence_and_read_ack() {
        for (sequence, value) in [
            (2, Value::Credited),
            (
                1,
                Value::Read {
                    base64: String::new(),
                },
            ),
        ] {
            let (owner, _caller) = UnixStream::pair().unwrap();
            owner.set_nonblocking(true).unwrap();
            let (sender, replies) = mpsc::sync_channel(1);
            sender
                .send(Reply {
                    schema: REPLY_SCHEMA.into(),
                    sequence,
                    result: Ok(value),
                })
                .unwrap();
            let mut relay = Relay {
                stream: owner,
                replies,
                cancelled: Arc::new(AtomicBool::new(false)),
                sequence: 0,
                expires: Instant::now() + Duration::from_secs(1),
                limit: 2_097_152,
            };
            let error = publication::Transport::credit(&mut relay, 73).unwrap_err();
            assert!(error.contains(if sequence == 2 {
                "acknowledgement mismatch"
            } else {
                "operation mismatch"
            }));
        }
    }
    #[test]
    fn store_and_session_share_256_live_permits_and_restore_only_released_slots() {
        let capacity = OperationCapacity::new(256);
        let store = Arc::clone(&capacity);
        let session = Arc::clone(&capacity);
        let mut permits = Vec::new();
        for index in 0..256 {
            permits.push(if index % 2 == 0 {
                store.acquire().unwrap()
            } else {
                session.acquire().unwrap()
            });
        }
        assert!(
            store
                .acquire()
                .unwrap_err()
                .contains("capacity exhausted before effects")
        );
        assert!(
            session
                .acquire()
                .unwrap_err()
                .contains("capacity exhausted before effects")
        );
        permits.pop();
        let replacement = session.acquire().unwrap();
        assert!(store.acquire().is_err());
        drop(replacement);
        drop(permits);
        assert!(!capacity.retained());
    }
}
#[derive(Debug)]
pub(super) struct OperationPermit(Arc<OperationCapacity>);
impl Drop for OperationPermit {
    fn drop(&mut self) {
        self.0.used.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Frame<T> {
    Registered {
        id: String,
        runtime_digest: String,
        registration: String,
    },
    ProjectBound {
        id: String,
        runtime_digest: String,
        registration: String,
    },
    WriteEngineFrame {
        sequence: u64,
        base64: String,
    },
    ReadEngineFrame {
        sequence: u64,
    },
    PublicationCredit {
        sequence: u64,
        bytes: usize,
    },
    Complete {
        completion: T,
    },
}
pub(super) fn decode_owner_frame(
    bytes: &[u8],
    generic_limit: usize,
) -> Result<Frame<session::SessionCompletion>> {
    if bytes.len() > generic_limit.max(publication_wire::MAX_RELAY_FRAME_BYTES) {
        return Err("session relay envelope bound".into());
    }
    let frame = serde_json::from_slice(bytes).map_err(err)?;
    let limit = if matches!(&frame, Frame::WriteEngineFrame { .. }) {
        publication_wire::MAX_RELAY_FRAME_BYTES
    } else {
        generic_limit
    };
    if bytes.len() > limit {
        return Err("session relay variant envelope bound".into());
    }
    Ok(frame)
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Reply {
    pub(super) schema: String,
    pub(super) sequence: u64,
    pub(super) result: Result<Value>,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Value {
    Written,
    Credited,
    Read { base64: String },
}
pub(super) struct Relay {
    pub(super) stream: UnixStream,
    pub(super) replies: mpsc::Receiver<Reply>,
    pub(super) cancelled: Arc<AtomicBool>,
    pub(super) sequence: u64,
    pub(super) expires: Instant,
    pub(super) limit: usize,
}
impl Relay {
    fn exchange(
        &mut self,
        command: Frame<session::SessionCompletion>,
        expected: &str,
    ) -> Result<Value> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err("session frontend disconnected".into());
        }
        let limit = if matches!(&command, Frame::WriteEngineFrame { .. }) {
            publication_wire::MAX_RELAY_FRAME_BYTES
        } else {
            self.limit
        };
        write_all(&self.stream, &encoded(&command, limit)?, self.expires)?;
        loop {
            check(self.expires)?;
            if self.cancelled.load(Ordering::Acquire) {
                return Err("session frontend disconnected".into());
            }
            match self.replies.recv_timeout(TICK) {
                Ok(reply) => {
                    if reply.schema != REPLY_SCHEMA || reply.sequence != self.sequence {
                        return Err("session relay acknowledgement mismatch".into());
                    }
                    let value = reply.result?;
                    if !matches!(
                        (&value, expected),
                        (Value::Written, "write")
                            | (Value::Read { .. }, "read")
                            | (Value::Credited, "credit")
                    ) {
                        return Err("session relay operation mismatch".into());
                    }
                    return Ok(value);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("session relay reader closed".into());
                }
            }
        }
    }
}
impl publication::Transport for Relay {
    fn credit(&mut self, bytes: usize) -> Result<()> {
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or("session relay sequence exhausted")?;
        self.exchange(
            Frame::PublicationCredit {
                sequence: self.sequence,
                bytes,
            },
            "credit",
        )
        .map(|_| ())
    }
    fn write(&mut self, bytes: &[u8], _: Instant) -> Result<()> {
        if bytes.len() > publication_wire::MAX_FRAME_BYTES {
            return Err("session relay write bound".into());
        }
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or("session relay sequence exhausted")?;
        self.exchange(
            Frame::WriteEngineFrame {
                sequence: self.sequence,
                base64: STANDARD.encode(bytes),
            },
            "write",
        )
        .map(|_| ())
    }
    fn read(&mut self, _: Instant) -> Result<Vec<u8>> {
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or("session relay sequence exhausted")?;
        match self.exchange(
            Frame::ReadEngineFrame {
                sequence: self.sequence,
            },
            "read",
        )? {
            Value::Read { base64 }
                if base64.len() <= publication_wire::MAX_FRAME_BYTES.div_ceil(3) * 4 =>
            {
                let bytes = STANDARD.decode(&base64).map_err(err)?;
                if bytes.len() > publication_wire::MAX_FRAME_BYTES
                    || STANDARD.encode(&bytes) != base64
                {
                    return Err("invalid session relay bytes".into());
                }
                Ok(bytes)
            }
            _ => Err("session relay read bound".into()),
        }
    }
}

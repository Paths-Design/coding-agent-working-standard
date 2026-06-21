# Danger-latch reset doctrine — design evaluation

**Spec:** CAWS-DANGER-LATCH-AGENT-RESETTABLE-DESIGN-001 (doc mode — analysis only)
**Status:** recommendation for maintainer decision. This memo changes no guard,
classifier, or reset script. Implementation of any remedy is a separate spec
gated on the decision recorded here.

---

## 1. The question

The danger latch (`block-dangerous.sh`) is a human-review boundary: when the
classifier returns a catastrophic `deny` (or a fail-closed `ask`), it writes a
per-session sentinel and every subsequent mutating Bash command blocks until a
**human** runs `reset-danger-latch.sh`. The canonical pack is emphatic at all
five block paths: *"you CANNOT clear this in-band: the reset is human-only by
design."*

A fork (language-corpus / Sterling) built an **agent-resettable** latch: the
agent clears its own latch in-band by writing a `--reason`. The question is
whether to upstream that, and if so, in what form.

The honest answer requires correcting the figure usually cited in its favor.

## 2. The "76% false alarms" figure is intention-based, not script-based

The canonical reset telemetry (`.claude/logs/danger-latch-resets.log`, 34
resets) is often summarized as "76% of latch arms were false alarms." That
framing is wrong in a way that inverts the conclusion.

**The reset log records the agent's stated *intent*, not the command's *shape*.**
Each entry pairs a `--reason` the agent wrote with the command that fired the
latch. When you read the two columns side by side, the "false alarm" rate is
really *"the rate at which the agent asserted its own command was benign."* That
is the agent grading its own homework — and the homework includes commands that
are catastrophic by shape:

| stated reason (agent intent) | command shape that fired | decision |
|---|---|---|
| "verification probe of new latch wording" | `mkfs.ext4 /dev/sdb1` | deny |
| "debug for this was strictly for testing" | `rm -rf /tmp/scopein-smoke …` | deny |
| "consumer_propagation: …classifier edit contained chmod-777 pattern" | `chmod 777 …` shape | deny |
| "git merge-tree --write-tree is read-only" | `git merge-tree --write-tree …` | ask |

Of the 8 `deny`-class resets, **two were `filesystem format` (mkfs) and one was
`chmod 777`** — genuinely destructive shapes the agent self-cleared with an
intent assertion. `mkfs.ext4 /dev/sdb1` happened to target a non-existent device
*this time*; the reason field ("verification probe") would have cleared it
regardless of the device argument.

The load-bearing fact: **the same command shape spans benign → catastrophic, and
the classifier can only see the shape.** `printf x | bash hook.sh` is a smoke
test or a payload exfil depending on what's piped; `node -e "$VAR"` is a read or
an RCE depending on `$VAR`; `mkfs.ext4 /dev/X` is a probe or a wipe depending on
`/dev/X`. The agent's `--reason` describes the *intended* branch. The latch
exists for the *unintended* branch — a hostile payload, an injected prompt, a
wrong or confused agent. On exactly that branch, an intent-based self-reset is
worthless, because the thing vouching for safety is the thing the latch is meant
to stop.

So the figure does **not** say "76% of latches were wrong." It says "76% of the
time the agent believed it was safe." Those are different claims, and a
filesystem-format command is inside the gap between them.

## 3. Three remedies, not two

The friction is real — humans were interrupted to clear latches that, in intent,
were benign. But the remedy must not be "let the agent assert intent," because
intent is exactly what cannot be trusted on the dangerous branch. There are
three candidate remedies; the first is the trap, the second and third are sound
and complementary.

### Remedy A — agent-resettable latch by stated reason (the fork's model)

The agent clears its own latch by writing a `--reason`. The fork closed the
obvious escape holes adversarially (`reset && <mutating>`, trailing-danger after
the reset token, embedded `$()` in the `--reason` argument), and that work is
real. But the model has a structural defect independent of any specific hole:

- **It authorizes by intent.** The reset is the agent vouching for itself. On a
  hostile payload or an injected prompt, the same mechanism that clears a benign
  smoke test clears the attack. "verification probe" cleared `mkfs.ext4` in the
  real log.
- **"The holes I found" ≠ "all holes."** Any in-band self-reset is an attack
  surface an adversarial prompt will probe. The boundary's value is that it
  *cannot* be cleared by the same context that tripped it.
- It removes the human from the loop on precisely the command class CAWS most
  wants a human to see.

**Verdict: do not upstream Remedy A as-is.** Intent-based self-attestation is the
gaming pattern the rest of CAWS doctrine refuses elsewhere (cf. the
"crafted-input-equals-sentinel is gaming, not a kill" rule in the test doctrine).

### Remedy B — fix the false positives at the source (already underway)

If a command shape is genuinely safe *by form*, the classifier should not latch
on it in the first place — no reset needed, agent or human. This is the path
`CAWS-DANGER-LATCH-CATASTROPHIC-ONLY-001` started (de-latching the ask-class) and
that this triage continued:

- `CAWS-CLASSIFY-PIPE-TO-LOCAL-SCRIPT-CARVEOUT-001` — `| bash named-file.sh` no
  longer latches (the #1 deny-class reset cause), while bare `| bash`, `-c`,
  `-s`, redirected forms, and `curl|sh` still do.
- `CAWS-HOOKPACK-ORACLE-JSYAML-DEGRADE-001` — a toolchain fault no longer
  ask-prompts on every mutation.
- `CAWS-GOD-OBJECT-CHECK-HYSTERESIS-001` — advisory noise reduced.

Each of these removes friction **without** weakening the boundary, because each
narrows the latch by *form the classifier can verify*, not by *intent the agent
asserts*. Every false positive fixed at the source is one fewer reason anyone —
agent or human — ever needs to reset.

**Verdict: continue Remedy B.** It is the principled half of the friction fix and
it is already shipping.

### Remedy C — give agents structural leeway, arranged ahead of time, verified by form

This is the "let agents set it up so it works how they work" need, expressed
**structurally instead of intentionally.** The leeway is real and worth giving —
but it must be exercised by *arranging the environment into a shape the
classifier can independently verify as safe*, never by asserting intent at reset
time.

Concrete forms this can take (each is a follow-up spec if the maintainer wants
it; none is implemented here):

1. **Form-based carve-outs the agent can rely on.** The pipe-to-local-script
   carve-out is the template: the agent writes its smoke-test payload into a
   *named, inspectable script file* and pipes into that, rather than into a bare
   interpreter. The safe shape is recognized by its form; the dangerous shape
   (`| bash`, `-c`, opaque `node -e "$VAR"`) still latches. The agent adapts its
   *workflow* to the safe form — that is leeway, and it composes with the
   classifier instead of overriding it. **This is the recommended primary
   leeway mechanism**, and the carve-out already shipped is proof it works.

2. **A first-class "test a hook" affordance** (`CAWS-HOOKS-TEST-AFFORDANCE-001`)
   so the safe way to drive a hook (`bash hook < payload.json`, a file redirect
   that never trips the deny) is documented and discoverable, not folklore. This
   removes the *occasion* for the foot-gun shape entirely.

3. **Pre-declared, form-checked allowlists** (env or config the agent sets at
   session start, e.g. the env-gated cross-repo prefix the fork prototyped) where
   the allowance is checked **structurally at fire time** (does the command match
   the declared safe form?) — not by an intent string written after the block.
   The declaration is made *before* and *out of band* of the command that would
   trip the latch, so an injected prompt mid-session cannot author it.

The throughline: **leeway is granted by what the command provably *is*, never by
what the agent *says it meant*.** An attacker can write any `--reason`; an
attacker cannot make `mkfs.ext4 /dev/sdb1` look like `bash run.sh` to a structural
matcher.

## 4. If agent-resettability is still wanted, the only defensible shape

Should the maintainer still want an in-band reset (e.g. for genuine multi-step
agentic flows where human round-trips are costly), it must be constrained so the
reset cannot authorize the dangerous branch:

- **Reset is form-scoped, not blanket.** A self-reset clears the latch *only for
  command shapes the classifier would already rank as recoverable/ask-class*
  (rebase, cherry-pick, npm-run) — never for the catastrophic `deny` set
  (`mkfs`, `rm -rf` outside safe prefixes, force-push, `chmod 777`, pipe-to-bare-
  shell, `git init`). A `deny`-class latch stays human-only. This directly closes
  the `mkfs`/`chmod 777` self-clear seen in the log.
- **The reason is audit, not authority.** The `--reason` is logged for the human
  to review after the fact; it is never the thing that decides the reset. The
  decision is the form check above.
- **One reset does not relax the session.** Each subsequent catastrophic command
  re-latches; the reset is not a session-wide "trust me" flag.

This is strictly weaker than the fork's model (which clears any latch the agent
asserts is safe) and strictly stronger than Remedy A's intent-attestation. It is
essentially Remedy B+C reframed as a reset policy: the agent gets in-band leeway
exactly where the *form* is already recoverable, and nowhere else.

## 5. Recommendation

1. **Do not upstream the fork's intent-based agent-resettable latch (Remedy A).**
   The "76% false alarm" figure that motivates it is intention-based; the same
   shapes it would let agents self-clear include `mkfs` and `chmod 777` in the
   real log. Intent-attestation cannot guard the branch the latch exists for.

2. **Continue Remedy B** (fix FPs at the source by form) — already shipping, and
   it is the principled friction fix.

3. **Give the requested leeway via Remedy C** (structural, pre-arranged,
   form-verified) — primarily the form-based carve-out pattern plus the
   hooks-test affordance. This is real leeway that lets agents "work how they
   work" without handing them the keys to the boundary.

4. **If in-band reset is still desired, adopt only the §4 form-scoped shape:**
   self-reset limited to already-recoverable (ask-class) shapes, catastrophic
   `deny` stays human-only, reason is audit not authority. File it as a separate
   implementation spec; it is not authorized by this memo.

The friction is worth removing. The way to remove it is to make the *safe shapes
provably safe to the classifier*, not to let the agent declare its own commands
safe after the fact. Leeway by form, never by intent.

## 6. Evidence index

- `.claude/logs/danger-latch-resets.log` — 34 resets; 8 deny-class (4
  pipe-to-shell, 2 filesystem-format, 1 chmod-777-class, 1 recursive-delete);
  reason-vs-shape table in §2.
- `block-dangerous.sh` (canonical) — human-only reset prose at the five block
  paths; the catastrophic `deny` set.
- `CAWS-DANGER-LATCH-CATASTROPHIC-ONLY-001` — prior de-latching of the ask-class
  (Remedy B precedent).
- `CAWS-CLASSIFY-PIPE-TO-LOCAL-SCRIPT-CARVEOUT-001` — the form-based carve-out
  template (Remedy C proof).
- The fork's reference implementation (language-corpus / Sterling) — agent-
  resettable latch with `reset && <mutating>` / trailing-danger / embedded-`$()`
  holes closed; the structural intent-attestation defect this memo identifies is
  independent of those holes.

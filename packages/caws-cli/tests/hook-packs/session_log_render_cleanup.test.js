/**
 * @fileoverview HOOK-SESSION-LOG-RENDER-CLEANUP-001 — the session-log renderer
 * emits ONLY substantive turn-NNN.json files.
 *
 * Two regressions this pins:
 *   1. Phantom command-turns. A hook-intercepted slash command (/copy-turn,
 *      /replay-last, /reorient) is delivered as a user-role transcript event in
 *      three shapes (a <command-message>/<command-name> wrapper, the skill body
 *      text, the "Operation stopped by hook:" block echo). None is agent work;
 *      before this fix they opened empty phantom turns that bloated the session
 *      log and made /copy-turn copy a blank turn.
 *   2. Write-only aggregates. session.json / handoff.json / session.txt
 *      duplicated the turn files and nothing read them; an unused session even
 *      left an empty session.json + session.txt behind.
 *
 * After the fix: a transcript renders only the turns where the agent actually
 * worked; a transcript-less (unused) session writes zero files.
 *
 * Drives the shipped renderer as a subprocess against synthetic transcripts.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { classifyTimeoutMs } = require('./lib/classify-timeout');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PACK = path.join(REPO_ROOT, 'packages', 'caws-cli', 'templates', 'hook-packs');

function renderer(pack) {
  return path.join(PACK, pack, 'session_log_renderer.py');
}

/** Write a JSONL transcript from an array of {type, message} entries. */
function writeTranscript(dir, entries) {
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}

function userMsg(text, ts) {
  return { type: 'user', timestamp: ts, message: { role: 'user', content: text } };
}
function assistantMsg(text, ts) {
  return {
    type: 'assistant',
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function render(pack, transcriptPath, outDir) {
  const r = spawnSync(
    'python3',
    [
      renderer(pack), outDir, '/tmp/proj', 'sess-x', '2026-01-01T00:00:00Z',
      'test', 'main', 'abc', '0', 'abc', transcriptPath || '/nonexistent.jsonl',
    ],
    { encoding: 'utf8', timeout: classifyTimeoutMs() }
  );
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`renderer failed: ${r.stderr}`);
  return fs.readdirSync(outDir);
}

const PHANTOM_USER_TEXTS = [
  '<command-message>copy-turn</command-message>\n<command-name>/copy-turn</command-name>',
  "This slash command's behavior is handled entirely by `~/.claude/hooks/user-prompt-submit-copy-turn.sh`.",
  'Operation stopped by hook: copy-turn: copied turn 5 from proj (1234 bytes).',
  '<command-name>/reorient</command-name>\n<command-message>reorient</command-message>',
];

describe.each(['claude-code', 'codex'])('HOOK-SESSION-LOG-RENDER-CLEANUP-001 [%s]', (pack) => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slr-cleanup-')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('emits only turn-NNN.json — no session.json / handoff.json / session.txt', () => {
    const t = writeTranscript(dir, [
      userMsg('do real work', '2026-01-01T00:00:01Z'),
      assistantMsg('here is my reasoning and a result', '2026-01-01T00:00:02Z'),
    ]);
    const out = render(pack, t, dir).filter((f) => f !== 'transcript.jsonl');
    expect(out).toContain('turn-001.json');
    expect(out).not.toContain('session.json');
    expect(out).not.toContain('handoff.json');
    expect(out).not.toContain('session.txt');
  });

  it('drops phantom command-turns (a /copy-turn invocation opens no turn)', () => {
    const entries = [
      userMsg('first real prompt', '2026-01-01T00:00:01Z'),
      assistantMsg('real agent work A', '2026-01-01T00:00:02Z'),
    ];
    // Interleave every phantom shape; none should produce a turn.
    let ts = 3;
    for (const phantom of PHANTOM_USER_TEXTS) {
      entries.push(userMsg(phantom, `2026-01-01T00:00:0${ts}Z`));
      ts += 1;
    }
    entries.push(userMsg('second real prompt', '2026-01-01T00:00:10Z'));
    entries.push(assistantMsg('real agent work B', '2026-01-01T00:00:11Z'));

    const t = writeTranscript(dir, entries);
    const turns = render(pack, t, dir).filter((f) => /^turn-\d+\.json$/.test(f));
    // Exactly two substantive turns; the four phantom command messages add none.
    expect(turns.length).toBe(2);
    for (const f of turns) {
      const payload = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      expect(JSON.stringify(payload)).not.toMatch(/Operation stopped by hook/);
      expect(payload.timeline.length).toBeGreaterThan(0);
    }
  });

  it('an unused (transcript-less) session writes zero files', () => {
    const out = render(pack, null, dir);
    expect(out).toEqual([]);
  });
});

// `caws handoff export | import` — the portable handoff brief surface
// (HANDOFF-EXPORT-IMPORT-001).
//
// export: builds the METADATA-ONLY brief for a session (self by default;
// --session <id> for a peer, consent-gated with the operator recorded as the
// exporting authority) and writes it under .caws/handoffs/ (Entry 33 scoping).
// Never reads file contents or turn transcripts (Entry 24 — secret-bearing
// paths are redacted to name-only by construction).
//
// import: reads + shape-validates a brief, surfaces its context, and appends
// exactly ONE manual_pickup event (the phase-1 taxonomy) binding
// source_session (from the brief) to receiving_session (the importer). Import
// never mutates claims, leases, scope, or lifecycle state — provenance, never
// authority.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { EventBody } from '../../kernel';
import { appendEvent, resolveRepoRoot } from '../../store';
import {
  buildHandoffBrief,
  HANDOFFS_DIRNAME,
  readHandoffBrief,
  writeHandoffBrief,
} from '../../store/handoff-brief';
import { renderDiagnostics } from '../render/diagnostic';
import { buildActor } from '../session/actor';
import { resolveSession } from '../session/resolve-session';

export interface HandoffExportOptions {
  /** Export a PEER session's brief (consent-gated: operator recorded as authority). */
  readonly session?: string;
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly showData?: boolean;
}

export interface HandoffImportOptions {
  /** Path to the brief file (.caws-relative or absolute). */
  readonly file: string;
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly showData?: boolean;
}

export function runHandoffExportCommand(opts: HandoffExportOptions): number {
  const cwd = opts.cwd ?? process.cwd();
  const nowFn = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;

  const rootRes = resolveRepoRoot(cwd);
  if (!rootRes.ok) {
    err('caws handoff export: failed to resolve repo root.');
    err(renderDiagnostics(rootRes.errors, { showData }));
    return 2;
  }
  const { repoRoot, cawsDir } = rootRes.value;

  const sessionResult = resolveSession({ cawsDir, worktreeRoot: cwd, env, now: nowFn, allowMint: true });
  if (!sessionResult.ok) {
    err('caws handoff export: failed to resolve session identity.');
    err(renderDiagnostics(sessionResult.errors, { showData }));
    return 2;
  }
  const selfId = sessionResult.value.identity.session_id;
  const sourceSessionId = opts.session ?? selfId;
  const exportedBy = sourceSessionId === selfId ? selfId : selfId;

  const brief = buildHandoffBrief({
    cawsDir,
    sessionId: sourceSessionId,
    exportedBy,
    now: nowFn().toISOString(),
  });
  if (brief === null) {
    err(`caws handoff export: could not build a brief for session "${sourceSessionId}".`);
    return 1;
  }

  const w = writeHandoffBrief(cawsDir, brief);
  if (!w.ok) {
    err(`caws handoff export: ${w.reason}`);
    return 1;
  }

  const rel = path.relative(repoRoot, w.path);
  out(`exported handoff brief for ${sourceSessionId}`);
  out(`  written to ${rel}`);
  out(`  work_state: ${brief.source_session.work_state ?? '(none)'}`);
  out(`  claimed_paths: ${brief.source_session.claimed_paths.length}`);
  out(`  prior handoffs: ${brief.prior_handoffs.length}`);
  if (sourceSessionId !== selfId) {
    out(`  exported by: ${exportedBy} (operator authority — peer export)`);
  }
  out(`  content_sha256: ${brief.content_sha256}`);
  return 0;
}

export function runHandoffImportCommand(opts: HandoffImportOptions): number {
  const cwd = opts.cwd ?? process.cwd();
  const nowFn = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;

  if (typeof opts.file !== 'string' || opts.file.length === 0) {
    err('caws handoff import: <file> is required.');
    return 1;
  }

  const rootRes = resolveRepoRoot(cwd);
  if (!rootRes.ok) {
    err('caws handoff import: failed to resolve repo root.');
    err(renderDiagnostics(rootRes.errors, { showData }));
    return 2;
  }
  const { repoRoot, cawsDir } = rootRes.value;

  // Resolve the brief path (absolute, or .caws/handoffs/<name> shorthand).
  const candidates = [
    path.resolve(cwd, opts.file),
    path.join(cawsDir, HANDOFFS_DIRNAME, opts.file),
  ];
  const briefPath = candidates.find((p) => fs.existsSync(p));
  if (briefPath === undefined) {
    err(`caws handoff import: no brief at ${opts.file} (tried ${candidates.join(', ')}).`);
    return 1;
  }

  const brief = readHandoffBrief(briefPath);
  if (brief === null) {
    err(`caws handoff import: brief not found at ${briefPath}.`);
    return 1;
  }
  if ('malformed' in brief) {
    err(`caws handoff import: malformed brief — ${brief.reason}. Nothing appended.`);
    return 1;
  }

  const sessionResult = resolveSession({ cawsDir, worktreeRoot: cwd, env, now: nowFn, allowMint: true });
  if (!sessionResult.ok) {
    err('caws handoff import: failed to resolve session identity.');
    err(renderDiagnostics(sessionResult.errors, { showData }));
    return 2;
  }
  const receivingSessionId = sessionResult.value.identity.session_id;
  const actor = buildActor({ session: sessionResult.value, kind: 'agent' });

  // Surface the brief's context (the snapshot the importer is picking up).
  out(`importing handoff brief for ${brief.source_session.session_id}`);
  out(`  exported_at: ${brief.exported_at}`);
  out(`  work_state: ${brief.source_session.work_state ?? '(none)'}`);
  out(`  claimed_paths: ${brief.source_session.claimed_paths.length}`);
  for (const p of brief.source_session.claimed_paths) out(`    ${p}`);
  out(`  prior handoffs: ${brief.prior_handoffs.length}`);

  // Exactly ONE manual_pickup event (phase-1 taxonomy). Provenance, never
  // authority — no claim/lease/scope mutation.
  const body = {
    event: 'manual_pickup',
    ts: nowFn().toISOString(),
    actor,
    data: {
      source_session: brief.source_session.session_id,
      receiving_session: receivingSessionId,
      paths: [...brief.source_session.claimed_paths],
      reason: `handoff brief import (${path.relative(repoRoot, briefPath)})`,
    },
  } as unknown as EventBody;
  const appended = appendEvent(cawsDir, body);
  if (!appended.ok) {
    err('caws handoff import: the manual_pickup event could not be appended.');
    err(renderDiagnostics(appended.errors, { showData }));
    return 1;
  }

  out(`recorded manual_pickup seq=${appended.value.seq} hash=${appended.value.event_hash}`);
  out(`  ${brief.source_session.session_id} -> ${receivingSessionId}`);
  return 0;
}

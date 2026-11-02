import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { ok } from '../kernel';
import { atomicMachineWrite } from '../init/machine-adapters';
import { withLifecycleLock } from '../store/lifecycle-lock';
import type { PendingDedup } from './composer';
import type { SelectedHandler } from './selection';
import { ensureOperationalDirectory, readOperationalFile } from './operational-files';

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** Advice cache only: every uncertain condition emits again; no decision is suppressed. */
export class AdvisoryDedup {
  private readonly directory: string;
  private readonly ledger: string;
  private readonly maximum: number;
  private readonly enabled: boolean;
  readonly diagnostics: string[] = [];
  constructor(
    private readonly home: string,
    canonical: string,
    sessionId: string | null,
    environment: Readonly<Record<string, string>>
  ) {
    this.directory = join(
      home,
      'state/projects',
      digest(canonical),
      'advisory-sessions',
      sessionId ? digest(sessionId) : 'unkeyed'
    );
    this.ledger = join(this.directory, 'seen.v1.json');
    const configured = environment.CAWS_HOOK_ADVISORY_DEDUP_MAX ?? '4096';
    this.maximum = /^\d{1,9}$/.test(configured) ? Number(configured) : 4096;
    this.enabled = Boolean(
      sessionId &&
        sessionId !== 'unknown' &&
        environment.CAWS_HOOK_ADVISORY_DEDUP !== '0' &&
        this.maximum <= 16384
    );
  }
  private load(): string[] {
    try {
      const rows: unknown = JSON.parse(
        readOperationalFile(this.home, this.ledger, 2 * 1024 * 1024).toString('utf8')
      );
      if (
        !Array.isArray(rows) ||
        rows.length > Math.max(1, this.maximum * 4) ||
        rows.some((row) => typeof row !== 'string' || row.length !== 64 || /[^a-f0-9]/.test(row))
      )
        throw new Error('Unreliable advisory ledger');
      return rows as string[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  private key(handler: string, text: string): string {
    return digest(JSON.stringify([handler, text]));
  }
  seen(handler: SelectedHandler, text: string): boolean {
    if (!this.enabled) return false;
    try {
      fs.accessSync(this.ledger, fs.constants.R_OK | fs.constants.W_OK);
      fs.accessSync(this.directory, fs.constants.W_OK);
      return this.load().includes(this.key(handler.name, text));
    } catch {
      return false;
    }
  }
  commit(pending: readonly PendingDedup[]): void {
    if (!this.enabled || !pending.length) return;
    try {
      ensureOperationalDirectory(this.home, this.directory);
      const committed = withLifecycleLock(
        this.directory,
        () => {
          const keys = new Set(this.load());
          for (const row of pending) keys.add(this.key(row.handler, row.text));
          const retained = this.maximum === 0 ? [] : [...keys].slice(-this.maximum);
          atomicMachineWrite(this.home, this.ledger, JSON.stringify(retained));
          return ok(undefined);
        },
        { maxAttempts: 1 }
      );
      if (!committed.ok) throw new Error('Advisory cache is busy; retry remains eligible');
    } catch (error) {
      this.diagnostics.push('[caws advisory dedup] not committed: ' + String(error) + '\n');
    }
  }
}

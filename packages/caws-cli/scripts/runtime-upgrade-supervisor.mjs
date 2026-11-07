// Adapter for the repo-built qualification custodian. No environment values are
// serialized: the selected environment crosses ordinary exec inheritance only.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function requireQualificationSupervisor(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file))
    throw new Error('CAWS_QUALIFICATION_SUPERVISOR must select the repo-built absolute executable');
  const physical = fs.realpathSync(file);
  const stat = fs.statSync(physical);
  if (!stat.isFile() || !(stat.mode & 0o111))
    throw new Error('Qualification supervisor must be an executable file');
  return physical;
}

function readPinnedOutput(file, pin, limit) {
  if (
    !pin ||
    !Number.isSafeInteger(pin.sizeBytes) ||
    pin.sizeBytes < 0 ||
    pin.sizeBytes > limit ||
    limit > 16 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(pin.sha256 ?? '') ||
    !/^[0-9]+$/.test(pin.device ?? '') ||
    !/^[0-9]+$/.test(pin.inode ?? '')
  )
    throw new Error('missing or invalid live output pin');
  const before = fs.lstatSync(file, { bigint: true });
  const matches = (stat) =>
    stat.isFile() &&
    stat.dev.toString() === pin.device &&
    stat.ino.toString() === pin.inode &&
    stat.size === BigInt(pin.sizeBytes);
  const same = (a, b) =>
    ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key]);
  if (!matches(before)) throw new Error('output identity differs from live custody receipt');
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!matches(opened) || !same(before, opened))
      throw new Error('output changed before bounded read');
    const bytes = Buffer.alloc(pin.sizeBytes);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, count);
      if (read === 0) throw new Error('output truncated during bounded read');
      count += read;
    }
    const extra = Buffer.alloc(1);
    if (fs.readSync(fd, extra, 0, 1, count) !== 0)
      throw new Error('output exceeds live byte count');
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    if (!matches(after) || !matches(named) || !same(opened, after) || !same(after, named))
      throw new Error('output changed during bounded read');
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== pin.sha256)
      throw new Error('output digest differs from live custody receipt');
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

export function supervisedSpawn(supervisor, command, args, options) {
  supervisor = requireQualificationSupervisor(supervisor);
  const parent = options.env?.CAWS_QUALIFICATION_ARTIFACT_DIR;
  // A blocked receipt path must not discard the command's actual outcome.
  // Keep the private custody exchange under its retained fixture instead.
  const base =
    parent && fs.existsSync(parent) && fs.statSync(parent).isDirectory()
      ? parent
      : (options.cwd ?? process.cwd());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, 'command-custody-')));
  const request = {
    command,
    args,
    cwd: path.resolve(options.cwd ?? process.cwd()),
    input: Buffer.from(options.input ?? '').toString('base64'),
    timeoutMs: options.timeout ?? 300000,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
    artifactDirectory: root,
  };
  const supervisorIdentity = {
    path: supervisor,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(supervisor)).digest('hex'),
  };
  // The frontend has its own deadline. Never apply spawnSync's timeout to the
  // process that retains target custody or signal a PID read from its report.
  const front = spawnSync(supervisor, [], {
    cwd: options.cwd,
    env: options.env,
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const frontend = {
    supervisor: supervisorIdentity,
    status: front.status,
    signal: front.signal,
    error: front.error?.message ?? null,
    stdout: front.stdout,
    stderr: front.stderr,
  };
  let persistenceError;
  try {
    fs.writeFileSync(path.join(root, 'frontend.json'), JSON.stringify(frontend, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    persistenceError = error.message;
  }
  let reply;
  try {
    reply = JSON.parse(front.stdout);
  } catch {
    /* retained refusal below */
  }
  const valid =
    front.status === 0 &&
    !front.error &&
    !front.signal &&
    reply?.complete === true &&
    reply.root === root &&
    reply.outcome?.custody?.directChildReaped === true;
  const outcome = valid ? reply.outcome : null;
  const readErrors = [];
  const read = (name) => {
    try {
      const bytes = readPinnedOutput(
        path.join(root, name),
        outcome?.[`${name}Pin`],
        request.maxBuffer
      );
      return options.encoding ? bytes.toString(options.encoding) : bytes;
    } catch (error) {
      readErrors.push(`${name}: ${error.message}`);
      return options.encoding ? '' : Buffer.alloc(0);
    }
  };
  const stdout = read('stdout');
  const stderr = read('stderr');
  const errorText =
    outcome?.error ??
    persistenceError ??
    (readErrors.length ? readErrors.join('; ') : null) ??
    (valid
      ? null
      : (reply?.reason ??
        front.error?.message ??
        `qualification frontend failed: ${front.stderr}`));
  const code = outcome?.errorCode ?? (errorText ? 'ECUSTODY' : null);
  const error = errorText ? Object.assign(new Error(`${code}: ${errorText}`), { code }) : undefined;
  const custody = outcome?.custody;
  return {
    pid: outcome?.pid ?? null,
    status: outcome?.status ?? null,
    signal:
      outcome?.signal == null
        ? null
        : (os.constants.signals &&
            Object.keys(os.constants.signals).find(
              (key) => os.constants.signals[key] === outcome.signal
            )) ||
          `SIGNAL_${outcome.signal}`,
    error,
    stdout,
    stderr,
    qualificationFrontend: frontend,
    qualificationTimeoutCleanup: outcome?.timeoutCleanup ?? null,
    qualificationCustody: {
      direct_child_timeout_only: false,
      descendant_settlement: custody?.descendantSettlement ?? 'unproven',
      group_settlement: custody?.groupSettlement ?? 'unproven',
      direct_child_reaped: custody?.directChildReaped ?? false,
      stdout_eof: custody?.stdoutEof ?? false,
      stderr_eof: custody?.stderrEof ?? false,
      uncertain: !valid || custody?.uncertain !== false || Boolean(error),
      retained_root: root,
      custodian_pid: reply?.custodianPid ?? null,
      supervisor: supervisorIdentity,
      output_verified: valid && readErrors.length === 0,
      output_errors: readErrors,
    },
  };
}

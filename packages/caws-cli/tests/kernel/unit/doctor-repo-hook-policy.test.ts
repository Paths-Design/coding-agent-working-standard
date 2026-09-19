/**
 * CAWS-HOOKS-POLICY-DOCTOR-RULES-01 — the four repo-local hook-policy rules,
 * classified purely from snapshot rows.
 *
 * The invariant under test is the split: the store measures (reads templates,
 * hashes bodies, compares compiled chains) and the kernel only decides
 * severity and prose. So every case here is expressed as plain data, and a
 * kernel that needed I/O could not satisfy these arms at all.
 *
 * The severity contract is evidence-led and is what these arms pin:
 *   - a fork whose upstream MOVED is a warning (an outstanding retrofit);
 *   - a fork whose upstream did NOT move is silent (a discharged decision);
 *   - a fork whose upstream could not be measured is silent (unobserved);
 *   - an invalid policy is an ERROR, never "no policy";
 *   - an absent policy produces nothing at all.
 *
 * DIAGNOSE ONLY: pure kernel function over the snapshot — no I/O, no mutation.
 */

import { inspectProjectState } from '../../../src/kernel/doctor/inspect';
import { DOCTOR_RULES } from '../../../src/kernel/doctor/rules';
import type {
  DoctorInput,
  RepoHookPolicyObservation,
  RepoPolicyForkRow,
} from '../../../src/kernel/doctor/types';

const NOW = new Date('2026-09-18T12:00:00.000Z');

type FsObs = NonNullable<DoctorInput['filesystem']>;
function fsObs(partial: Record<string, unknown>): FsObs {
  return partial as unknown as FsObs;
}

function input(fs: FsObs): DoctorInput {
  return { now: NOW, specs: [], filesystem: fs };
}

function rules(report: ReturnType<typeof inspectProjectState>): string[] {
  return report.findings.map((f) => f.rule);
}

function findingFor(report: ReturnType<typeof inspectProjectState>, rule: string) {
  return report.findings.find((f) => f.rule === rule);
}

function fork(overrides: Partial<RepoPolicyForkRow> = {}): RepoPolicyForkRow {
  return {
    surface: 'default',
    handler: 'scope-guard.sh',
    recordedPack: 'shared',
    recordedPackVersion: 67,
    shippingPackVersion: 83,
    reason: 'this repo keeps its Rust core in native/, which the shipped table does not know',
    upstreamChange: true,
    ...overrides,
  };
}

function valid(
  overrides: Partial<Extract<RepoHookPolicyObservation, { kind: 'valid' }>> = {}
): RepoHookPolicyObservation {
  return { kind: 'valid', forks: [], staleChains: [], ...overrides };
}

describe('A1/A2: doctor.hooks.repo_policy_fork_lag severity follows the evidence', () => {
  test('rule ids are the stable strings the spec and remediation text name', () => {
    expect(DOCTOR_RULES.HOOKS_REPO_POLICY_FORK_LAG).toBe('doctor.hooks.repo_policy_fork_lag');
    expect(DOCTOR_RULES.HOOKS_REPO_POLICY_CHAIN_STALE).toBe('doctor.hooks.repo_policy_chain_stale');
    expect(DOCTOR_RULES.HOOKS_REPO_POLICY_INVALID).toBe('doctor.hooks.repo_policy_invalid');
    expect(DOCTOR_RULES.HOOKS_LEGACY_ADAPTER_POLICY).toBe('doctor.hooks.legacy_adapter_policy');
  });

  test('A1: a fork behind the shipping pack with a moved upstream warns, naming versions and distance in DATA not only prose', () => {
    const report = inspectProjectState(
      input(fsObs({ repoHookPolicy: valid({ forks: [fork()] }) }))
    );
    const found = findingFor(report, DOCTOR_RULES.HOOKS_REPO_POLICY_FORK_LAG);
    expect(found).toBeDefined();
    expect(found?.severity).toBe('warning');
    // Prose must carry the numbers a reader needs without opening --json.
    expect(found?.message).toContain('scope-guard.sh');
    expect(found?.message).toContain('shared@67');
    expect(found?.message).toContain('shipping 83');
    expect(found?.message).toContain('16 behind');
    // …and the payload must carry them as FIELDS, so a consumer never parses prose.
    expect(found?.data).toMatchObject({
      fork_count: 1,
      forks: [
        {
          surface: 'default',
          handler: 'scope-guard.sh',
          recorded_pack: 'shared',
          recorded_pack_version: 67,
          shipping_pack_version: 83,
          distance: 16,
        },
      ],
    });
  });

  test('A1: the recorded justification travels into the finding, so review sees WHY the fork exists', () => {
    const report = inspectProjectState(
      input(fsObs({ repoHookPolicy: valid({ forks: [fork({ reason: 'native/ has no src/' })] }) }))
    );
    const data = findingFor(report, DOCTOR_RULES.HOOKS_REPO_POLICY_FORK_LAG)?.data as {
      forks: { reason: string }[];
    };
    expect(data.forks[0]?.reason).toBe('native/ has no src/');
  });

  test('A2: a fork at the CURRENT pack whose upstream body is unchanged is NOT a warning', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          repoHookPolicy: valid({
            forks: [fork({ recordedPackVersion: 83, upstreamChange: false })],
          }),
        })
      )
    );
    expect(rules(report)).not.toContain(DOCTOR_RULES.HOOKS_REPO_POLICY_FORK_LAG);
  });

  test('A2: the discriminator is the MOVED BODY, not the version distance — a stale version with an unmoved body stays silent', () => {
    // 16 versions behind, but this particular handler never changed. Warning
    // here would fire on nearly every fork in a long-lived repo, which is how
    // the signal becomes unreadable.
    const report = inspectProjectState(
      input(
        fsObs({
          repoHookPolicy: valid({
            forks: [fork({ recordedPackVersion: 67, upstreamChange: false })],
          }),
        })
      )
    );
    expect(rules(report)).not.toContain(DOCTOR_RULES.HOOKS_REPO_POLICY_FORK_LAG);
  });

  test('a fork whose shipped counterpart could not be measured is UNOBSERVED, never reported as current or stale', () => {
    const unmeasured = fork();
    delete (unmeasured as { upstreamChange?: boolean }).upstreamChange;
    const report = inspectProjectState(
      input(fsObs({ repoHookPolicy: valid({ forks: [unmeasured] }) }))
    );
    expect(rules(report)).not.toContain(DOCTOR_RULES.HOOKS_REPO_POLICY_FORK_LAG);
  });

  test('mixed forks: only the moved ones are named, so the count is not inflated by discharged decisions', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          repoHookPolicy: valid({
            forks: [
              fork({ handler: 'scope-guard.sh', upstreamChange: true }),
              fork({ handler: 'god-object-check.sh', upstreamChange: false }),
              fork({ handler: 'loc-delta-check.sh', upstreamChange: true }),
            ],
          }),
        })
      )
    );
    const data = findingFor(report, DOCTOR_RULES.HOOKS_REPO_POLICY_FORK_LAG)?.data as {
      fork_count: number;
      forks: { handler: string }[];
    };
    expect(data.fork_count).toBe(2);
    expect(data.forks.map((f) => f.handler)).toEqual(['scope-guard.sh', 'loc-delta-check.sh']);
  });

  test('the remediation prescribes a PORT, never a wholesale refresh that would discard the fork', () => {
    const report = inspectProjectState(
      input(fsObs({ repoHookPolicy: valid({ forks: [fork()] }) }))
    );
    const repair = findingFor(report, DOCTOR_RULES.HOOKS_REPO_POLICY_FORK_LAG)?.narrowRepair ?? '';
    expect(repair).toContain('caws hooks replace');
    expect(repair).not.toContain('--overwrite');
  });
});

describe('A3: doctor.hooks.repo_policy_chain_stale', () => {
  test('a stale sidecar warns, naming each event and the comparator reason verbatim', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          repoHookPolicy: valid({
            staleChains: [
              { event: 'pre_tool_use', reason: 'compiled against pack 81, shipping 83' },
              { event: 'session_start', reason: 'no compiled chain on disk' },
            ],
          }),
        })
      )
    );
    const found = findingFor(report, DOCTOR_RULES.HOOKS_REPO_POLICY_CHAIN_STALE);
    expect(found?.severity).toBe('warning');
    expect(found?.message).toContain('pre_tool_use (compiled against pack 81, shipping 83)');
    expect(found?.message).toContain('session_start (no compiled chain on disk)');
    expect(found?.narrowRepair).toContain('caws hooks compile');
    expect(found?.data).toMatchObject({
      stale_count: 2,
      stale_events: [
        { event: 'pre_tool_use', reason: 'compiled against pack 81, shipping 83' },
        { event: 'session_start', reason: 'no compiled chain on disk' },
      ],
    });
  });

  test('the message names the surfaces that actually read the sidecar, because the reader cannot observe them from Claude Code', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          repoHookPolicy: valid({ staleChains: [{ event: 'stop', reason: 'body differs' }] }),
        })
      )
    );
    const message = findingFor(report, DOCTOR_RULES.HOOKS_REPO_POLICY_CHAIN_STALE)?.message ?? '';
    for (const surface of ['qwen-code', 'kimi-code', 'opencode', 'zcode', 'dsh']) {
      expect(message).toContain(surface);
    }
  });

  test('a valid policy whose chains are all current produces no chain finding', () => {
    const report = inspectProjectState(input(fsObs({ repoHookPolicy: valid() })));
    expect(rules(report)).not.toContain(DOCTOR_RULES.HOOKS_REPO_POLICY_CHAIN_STALE);
  });
});

describe('A4: doctor.hooks.repo_policy_invalid', () => {
  test('an invalid document is an ERROR carrying the validator message', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          repoHookPolicy: {
            kind: 'invalid',
            error: 'surfaces.default.disabled.pre_tool_use: protected-paths.sh is on the floor',
          },
        })
      )
    );
    const found = findingFor(report, DOCTOR_RULES.HOOKS_REPO_POLICY_INVALID);
    expect(found?.severity).toBe('error');
    expect(found?.message).toContain('protected-paths.sh is on the floor');
    expect(found?.data).toMatchObject({
      error: 'surfaces.default.disabled.pre_tool_use: protected-paths.sh is on the floor',
    });
    expect(found?.narrowRepair).toContain('caws hooks validate');
  });

  test('an invalid document does NOT also report the repo as policy-free: no fork or chain finding rides along', () => {
    const report = inspectProjectState(
      input(fsObs({ repoHookPolicy: { kind: 'invalid', error: 'unexpected token } at line 4' } }))
    );
    const fired = rules(report);
    expect(fired).toContain(DOCTOR_RULES.HOOKS_REPO_POLICY_INVALID);
    expect(fired).not.toContain(DOCTOR_RULES.HOOKS_REPO_POLICY_FORK_LAG);
    expect(fired).not.toContain(DOCTOR_RULES.HOOKS_REPO_POLICY_CHAIN_STALE);
  });

  test('the message states the fail-closed consequence, so the reader knows this is an outage and not a nit', () => {
    const report = inspectProjectState(
      input(fsObs({ repoHookPolicy: { kind: 'invalid', error: 'bad key' } }))
    );
    expect(findingFor(report, DOCTOR_RULES.HOOKS_REPO_POLICY_INVALID)?.message).toContain(
      'fail-CLOSED'
    );
  });
});

describe('A5: doctor.hooks.legacy_adapter_policy', () => {
  test('the superseded file is named at info with the migration path', () => {
    const report = inspectProjectState(input(fsObs({ legacyAdapterPolicyPresent: true })));
    const found = findingFor(report, DOCTOR_RULES.HOOKS_LEGACY_ADAPTER_POLICY);
    expect(found?.severity).toBe('info');
    expect(found?.message).toContain('.caws/hooks/adapter-policy.json');
    expect(found?.message).toContain('hook-policy.json');
    expect(found?.narrowRepair).toContain('caws hooks import --from-machine');
  });

  test('it fires independently of hook-policy.json — the legacy file matters MOST where no replacement exists', () => {
    const report = inspectProjectState(input(fsObs({ legacyAdapterPolicyPresent: true })));
    expect(rules(report)).toContain(DOCTOR_RULES.HOOKS_LEGACY_ADAPTER_POLICY);
    expect(rules(report)).not.toContain(DOCTOR_RULES.HOOKS_REPO_POLICY_INVALID);
  });

  test('a repo without the file produces no such finding', () => {
    expect(
      rules(inspectProjectState(input(fsObs({ legacyAdapterPolicyPresent: false }))))
    ).not.toContain(DOCTOR_RULES.HOOKS_LEGACY_ADAPTER_POLICY);
    expect(rules(inspectProjectState(input(fsObs({}))))).not.toContain(
      DOCTOR_RULES.HOOKS_LEGACY_ADAPTER_POLICY
    );
  });
});

describe('A6: a repo with no hook-policy.json is byte-identical to before this slice', () => {
  test('none of the four rules fire when the observation is undefined', () => {
    const fired = rules(inspectProjectState(input(fsObs({}))));
    for (const rule of [
      DOCTOR_RULES.HOOKS_REPO_POLICY_FORK_LAG,
      DOCTOR_RULES.HOOKS_REPO_POLICY_CHAIN_STALE,
      DOCTOR_RULES.HOOKS_REPO_POLICY_INVALID,
      DOCTOR_RULES.HOOKS_LEGACY_ADAPTER_POLICY,
    ]) {
      expect(fired).not.toContain(rule);
    }
  });

  test('the findings are IDENTICAL with the key absent and with it explicitly undefined', () => {
    const absent = inspectProjectState(input(fsObs({ installedSharedPackVersion: 83 })));
    const explicit = inspectProjectState(
      input(
        fsObs({
          installedSharedPackVersion: 83,
          repoHookPolicy: undefined,
          legacyAdapterPolicyPresent: undefined,
        })
      )
    );
    expect(JSON.stringify(explicit.findings)).toBe(JSON.stringify(absent.findings));
  });

  test('an EMPTY valid policy is also silent — opting in is not itself a finding', () => {
    const fired = rules(inspectProjectState(input(fsObs({ repoHookPolicy: valid() }))));
    expect(fired).not.toContain(DOCTOR_RULES.HOOKS_REPO_POLICY_FORK_LAG);
    expect(fired).not.toContain(DOCTOR_RULES.HOOKS_REPO_POLICY_CHAIN_STALE);
    expect(fired).not.toContain(DOCTOR_RULES.HOOKS_REPO_POLICY_INVALID);
  });
});

describe('the classifier is pure: it reads the snapshot and mutates nothing', () => {
  test('a deep-frozen observation survives inspection', () => {
    const observation = valid({
      forks: [fork()],
      staleChains: [{ event: 'pre_tool_use', reason: 'no compiled chain on disk' }],
    });
    const frozen = fsObs({
      repoHookPolicy: Object.freeze({
        ...observation,
        forks: Object.freeze([Object.freeze(fork())]),
        staleChains: Object.freeze([
          Object.freeze({ event: 'pre_tool_use', reason: 'no compiled chain on disk' }),
        ]),
      }),
      legacyAdapterPolicyPresent: true,
    });
    const report = inspectProjectState(Object.freeze(input(frozen)));
    expect(rules(report)).toEqual(
      expect.arrayContaining([
        DOCTOR_RULES.HOOKS_REPO_POLICY_FORK_LAG,
        DOCTOR_RULES.HOOKS_REPO_POLICY_CHAIN_STALE,
        DOCTOR_RULES.HOOKS_LEGACY_ADAPTER_POLICY,
      ])
    );
  });
});

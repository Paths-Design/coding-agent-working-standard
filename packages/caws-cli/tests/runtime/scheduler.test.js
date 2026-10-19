const { FairWorkScheduler } = require('../../dist/runtime/scheduler');
const { AbortController } = globalThis;

function clock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(value, deliver = true) {
      now += value;
      if (deliver) {
        for (const [id, timer] of [...timers]) {
          if (timer.at <= now && timers.delete(id)) timer.callback();
        }
      }
    },
    pending: () => timers.size,
  };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const options = (time, extra = {}) => ({
  maxActive: 4,
  maxQueued: 32,
  maxActivePerProject: 2,
  maxRenderingActive: 1,
  clock: time,
  ...extra,
});
function controlled(scheduler) {
  const started = [];
  const jobs = [];
  const inFlight = new Set();
  const peakPerProject = new Map();
  const overlaps = [];
  let peakActive = 0;
  const add = (project, session, extra = {}) => {
    let finish;
    let fail;
    const work = new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const stateDomain =
      extra.stateDomain ?? (extra.lane === 'render' ? 'session-render' : 'session-enforcement');
    const job = { project, session, stateDomain, finish, fail, signal: null, admission: null };
    job.admission = scheduler.submit({
      project,
      session,
      ...extra,
      execute(signal) {
        job.signal = signal;
        // Worker-owned observations are independent of the scheduler's reported counters.
        if (
          [...inFlight].some(
            (other) =>
              other.project === project &&
              other.session === session &&
              other.stateDomain === stateDomain
          )
        ) {
          overlaps.push([project, session, stateDomain]);
        }
        inFlight.add(job);
        peakActive = Math.max(peakActive, inFlight.size);
        const projectActive = [...inFlight].filter((other) => other.project === project).length;
        peakPerProject.set(project, Math.max(peakPerProject.get(project) ?? 0, projectActive));
        started.push(job);
        return work.then(
          (value) => {
            inFlight.delete(job);
            return value;
          },
          (error) => {
            inFlight.delete(job);
            throw error;
          }
        );
      },
    });
    jobs.push(job);
    return job;
  };
  const completeAll = async () => {
    for (let round = 0; round <= jobs.length; round++) {
      for (const job of started) job.finish(`${job.project}/${job.session}`);
      await flush();
      if (scheduler.snapshot().idleEligible) break;
    }
  };
  return {
    add,
    jobs,
    started,
    completeAll,
    inFlight,
    peakPerProject,
    overlaps,
    get peakActive() {
      return peakActive;
    },
  };
}

describe('fair bounded scheduler admission', () => {
  test('runs thirteen controlled sessions across four projects within machine and project limits', async () => {
    const scheduler = new FairWorkScheduler(options(clock()));
    const workers = controlled(scheduler);
    const results = [];
    for (let index = 0; index < 13; index++) {
      const job = workers.add(`project-${index % 4}`, `session-${index}`);
      expect(job.admission.status).toBe('admitted');
      results.push(job.admission.result);
    }
    expect(workers.started).toHaveLength(4);
    expect(scheduler.snapshot().queued).toBe(9);
    for (let round = 0; round < 13 && !scheduler.snapshot().idleEligible; round++) {
      const snapshot = scheduler.snapshot();
      expect(snapshot.active).toBeLessThanOrEqual(4);
      for (const project of snapshot.projects) expect(project.active).toBeLessThanOrEqual(2);
      for (const job of [...workers.started]) job.finish(`${job.project}/${job.session}`);
      await flush();
    }
    expect(scheduler.snapshot().idleEligible).toBe(true);
    expect(workers.started).toHaveLength(13);
    expect(workers.peakActive).toBe(4);
    expect(workers.inFlight.size).toBe(0);
    expect(workers.overlaps).toEqual([]);
    for (const peak of workers.peakPerProject.values()) expect(peak).toBeLessThanOrEqual(2);
    expect(await Promise.all(results)).toEqual(
      workers.jobs.map((job) => ({ status: 'completed', value: `${job.project}/${job.session}` }))
    );
    expect(scheduler.snapshot().projects).toEqual([]);
  });

  test('a hot project cannot occupy foreign capacity even when its backlog fills the queue', async () => {
    const scheduler = new FairWorkScheduler(options(clock(), { maxQueued: 4 }));
    const workers = controlled(scheduler);
    workers.add('hot', 'a');
    workers.add('hot', 'b');
    workers.add('hot', 'c');
    workers.add('hot', 'd');
    expect(workers.add('hot', 'overflow').admission).toEqual({
      status: 'queue_full',
      reason: 'project',
    });
    const foreign = workers.add('foreign', 'new');
    expect(foreign.admission.status).toBe('admitted');
    expect(workers.started.map((job) => job.project)).toEqual(['hot', 'hot', 'foreign']);
    expect(workers.inFlight.size).toBe(3);
    expect(workers.peakPerProject.get('hot')).toBe(2);
    expect(scheduler.snapshot()).toMatchObject({ active: 3, queued: 2 });
    await workers.completeAll();
    expect(scheduler.snapshot().idleEligible).toBe(true);
    expect(workers.peakPerProject.get('hot')).toBe(2);
    expect(workers.overlaps).toEqual([]);
    expect(workers.inFlight.size).toBe(0);
  });

  test('project rotation serves a waiting foreign project before a second hot-project turn', async () => {
    const scheduler = new FairWorkScheduler(options(clock(), { maxActive: 3 }));
    const workers = controlled(scheduler);
    const a = workers.add('A', 'a');
    const b = workers.add('B', 'b');
    const c = workers.add('C', 'c');
    workers.add('A', 'a2');
    workers.add('A', 'a3');
    workers.add('B', 'b2');
    workers.add('D', 'd');
    a.finish();
    await flush();
    expect(workers.started.at(-1).session).toBe('a2');
    b.finish();
    await flush();
    expect(workers.started.at(-1).session).toBe('b2');
    c.finish();
    await flush();
    expect(workers.started.at(-1).project).toBe('D');
    expect(workers.started.some((job) => job.session === 'a3')).toBe(false);
    await workers.completeAll();
  });

  test('session rotation prevents one session with many independent domains from taking successive turns', async () => {
    const scheduler = new FairWorkScheduler(options(clock(), { maxActive: 3 }));
    const workers = controlled(scheduler);
    const first = workers.add('A', 'hot', { stateDomain: 'one' });
    const second = workers.add('A', 'hot', { stateDomain: 'two' });
    workers.add('A', 'hot', { stateDomain: 'three' });
    workers.add('A', 'hot', { stateDomain: 'four' });
    workers.add('A', 'other');
    first.finish();
    await flush();
    expect(workers.started.at(-1).session).toBe('hot');
    second.finish();
    await flush();
    expect(workers.started.at(-1).session).toBe('other');
    expect(workers.started).toHaveLength(4);
    await workers.completeAll();
  });

  test('owner tuples isolate repeated session ids and delimiter-looking identifiers', async () => {
    const scheduler = new FairWorkScheduler(options(clock()));
    const workers = controlled(scheduler);
    workers.add('project/a', 'b');
    workers.add('project', 'a/b');
    workers.add('one', 'reused');
    workers.add('two', 'reused');
    expect(workers.started).toHaveLength(4);
    expect(scheduler.snapshot().active).toBe(4);
    await workers.completeAll();
    expect(scheduler.snapshot().projects).toEqual([]);
  });

  test('FIFO per state domain serializes actual execution and preserves queued order', async () => {
    const scheduler = new FairWorkScheduler(options(clock()));
    const calls = [];
    const controls = [];
    const results = [];
    for (const index of [0, 1, 2]) {
      let finish;
      const work = new Promise((resolve) => {
        finish = resolve;
      });
      controls.push(finish);
      const admission = scheduler.submit({
        project: 'P',
        session: 'S',
        execute: () => {
          calls.push(index);
          return work;
        },
      });
      expect(admission.status).toBe('admitted');
      results.push(admission.result);
    }
    expect(calls).toEqual([0]);
    controls[0]('zero');
    await flush();
    expect(calls).toEqual([0, 1]);
    controls[1]('one');
    await flush();
    expect(calls).toEqual([0, 1, 2]);
    controls[2]('two');
    await flush();
    expect(await Promise.all(results)).toEqual([
      { status: 'completed', value: 'zero' },
      { status: 'completed', value: 'one' },
      { status: 'completed', value: 'two' },
    ]);
  });

  test('zero queued capacity admits only work that can start within the existing bounds', async () => {
    const scheduler = new FairWorkScheduler(options(clock(), { maxQueued: 0 }));
    const workers = controlled(scheduler);
    expect(workers.add('P', 'S').admission.status).toBe('admitted');
    expect(workers.add('P', 'S').admission).toEqual({ status: 'queue_full', reason: 'machine' });
    expect(workers.add('Q', 'S').admission.status).toBe('admitted');
    expect(scheduler.snapshot().queued).toBe(0);
    await workers.completeAll();
  });

  test('session and project queue quotas leave admission room for their peers', async () => {
    const scheduler = new FairWorkScheduler(
      options(clock(), { maxQueued: 8, maxQueuedPerProject: 4, maxQueuedPerSession: 2 })
    );
    const workers = controlled(scheduler);
    workers.add('hot', 'hot-session');
    workers.add('hot', 'active-peer');
    workers.add('busy', 'one');
    workers.add('busy', 'two');
    workers.add('hot', 'hot-session');
    workers.add('hot', 'hot-session');
    expect(workers.add('hot', 'hot-session', { stateDomain: 'new-domain' }).admission).toEqual({
      status: 'queue_full',
      reason: 'session',
    });
    expect(workers.add('hot', 'peer-session').admission.status).toBe('admitted');
    expect(workers.add('hot', 'another-peer').admission.status).toBe('admitted');
    expect(workers.add('hot', 'overflow').admission).toEqual({
      status: 'queue_full',
      reason: 'project',
    });
    expect(workers.add('foreign', 'new-session').admission.status).toBe('admitted');
    expect(scheduler.snapshot()).toMatchObject({ active: 4, queued: 5 });
    expect(scheduler.snapshot().projects.find((project) => project.project === 'hot').queued).toBe(
      4
    );
    await workers.completeAll();
    expect(scheduler.snapshot().projects).toEqual([]);
  });

  test('the machine queue remains bounded after distinct projects reach their own limits', async () => {
    const scheduler = new FairWorkScheduler(
      options(clock(), { maxQueued: 6, maxQueuedPerProject: 3, maxQueuedPerSession: 2 })
    );
    const workers = controlled(scheduler);
    workers.add('active-A', 'one');
    workers.add('active-A', 'two');
    workers.add('active-B', 'one');
    workers.add('active-B', 'two');
    for (let index = 0; index < 6; index++) {
      expect(
        workers.add(index < 3 ? 'queued-A' : 'queued-B', `session-${index}`).admission.status
      ).toBe('admitted');
      expect(scheduler.snapshot().queued).toBe(index + 1);
    }
    expect(workers.add('foreign', 'overflow').admission).toEqual({
      status: 'queue_full',
      reason: 'machine',
    });
    expect(scheduler.snapshot().queued).toBe(6);
    await workers.completeAll();
    expect(scheduler.snapshot().idleEligible).toBe(true);
  });
});

describe('scheduler cancellation, deadlines and drain', () => {
  test.each(['cancelled', 'expired'])(
    'detached %s caller retains active capacity until uncooperative work actually settles',
    async (status) => {
      const time = clock();
      const scheduler = new FairWorkScheduler(options(time));
      const workers = controlled(scheduler);
      const abort = new AbortController();
      const first = workers.add('P', 'S', { signal: abort.signal, deadline: 10 });
      const second = workers.add('P', 'S');
      if (status === 'cancelled') abort.abort();
      else time.advance(10);
      expect(await first.admission.result).toEqual({ status });
      expect(first.signal.aborted).toBe(true);
      expect(workers.inFlight.has(first)).toBe(true);
      expect(workers.inFlight.has(second)).toBe(false);
      expect(second.signal).toBeNull();
      expect(scheduler.snapshot()).toMatchObject({ active: 1, queued: 1, idleEligible: false });
      const foreign = workers.add('Q', 'S');
      expect(foreign.signal).not.toBeNull();
      first.finish('late');
      await flush();
      expect(second.signal).not.toBeNull();
      expect(await first.admission.result).toEqual({ status });
      await workers.completeAll();
      expect(scheduler.snapshot().idleEligible).toBe(true);
      expect(workers.overlaps).toEqual([]);
      expect(workers.inFlight.size).toBe(0);
      expect(time.pending()).toBe(0);
    }
  );

  test.each(['cancelled', 'expired'])(
    'queued %s request is removed before execution',
    async (status) => {
      const time = clock();
      const scheduler = new FairWorkScheduler(options(time));
      const workers = controlled(scheduler);
      const first = workers.add('P', 'S');
      const abort = new AbortController();
      const queued = workers.add('P', 'S', { signal: abort.signal, deadline: 5 });
      if (status === 'cancelled') abort.abort();
      else time.advance(5);
      expect(await queued.admission.result).toEqual({ status });
      expect(scheduler.snapshot().queued).toBe(0);
      first.finish();
      await flush();
      expect(queued.signal).toBeNull();
      expect(scheduler.snapshot().idleEligible).toBe(true);
      expect(time.pending()).toBe(0);
    }
  );

  test('deadline is checked at dispatch even when timer delivery is delayed', async () => {
    const time = clock();
    const scheduler = new FairWorkScheduler(options(time));
    const workers = controlled(scheduler);
    const first = workers.add('P', 'S');
    const queued = workers.add('P', 'S', { deadline: 5 });
    time.advance(10, false);
    first.finish();
    await flush();
    expect(await queued.admission.result).toEqual({ status: 'expired' });
    expect(queued.signal).toBeNull();
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0, idleEligible: true });
  });

  test('late running completion observes deadline even before the timer callback runs', async () => {
    const time = clock();
    const scheduler = new FairWorkScheduler(options(time));
    const workers = controlled(scheduler);
    const first = workers.add('P', 'S', { deadline: 5 });
    time.advance(10, false);
    first.finish('late');
    await flush();
    expect(await first.admission.result).toEqual({ status: 'expired' });
    expect(first.signal.aborted).toBe(true);
    expect(scheduler.snapshot().idleEligible).toBe(true);
  });

  test('deadlines beyond the timer delay limit rearm instead of expiring early', async () => {
    const time = clock();
    const scheduler = new FairWorkScheduler(options(time));
    const workers = controlled(scheduler);
    const first = workers.add('P', 'S', { deadline: 2147483653 });
    let terminal = false;
    first.admission.result.then(() => {
      terminal = true;
    });
    time.advance(2147483647);
    await flush();
    expect(terminal).toBe(false);
    expect(first.signal.aborted).toBe(false);
    expect(time.pending()).toBe(1);
    time.advance(6);
    expect(await first.admission.result).toEqual({ status: 'expired' });
    expect(scheduler.snapshot().active).toBe(1);
    first.finish();
    await flush();
    expect(scheduler.snapshot().idleEligible).toBe(true);
  });

  test('drain rejects new work but preserves admitted queue and waits through detached running work', async () => {
    const scheduler = new FairWorkScheduler(options(clock()));
    const workers = controlled(scheduler);
    const abort = new AbortController();
    const first = workers.add('P', 'S', { signal: abort.signal });
    const second = workers.add('P', 'S');
    let drained = false;
    const draining = scheduler.drain().then(() => {
      drained = true;
    });
    expect(workers.add('Q', 'new').admission).toEqual({ status: 'draining' });
    abort.abort();
    await flush();
    expect(drained).toBe(false);
    expect(await first.admission.result).toEqual({ status: 'cancelled' });
    first.finish();
    await flush();
    expect(second.signal).not.toBeNull();
    expect(drained).toBe(false);
    second.finish();
    await draining;
    expect(drained).toBe(true);
    expect(scheduler.snapshot()).toMatchObject({ draining: true, idleEligible: true });
  });

  test('pre-aborted and expired requests consume no admission or executor capacity', () => {
    const time = clock();
    const scheduler = new FairWorkScheduler(options(time));
    const abort = new AbortController();
    abort.abort();
    const execute = jest.fn();
    expect(scheduler.submit({ project: 'P', session: 'S', signal: abort.signal, execute })).toEqual(
      { status: 'cancelled' }
    );
    expect(scheduler.submit({ project: 'P', session: 'S', deadline: 0, execute })).toEqual({
      status: 'expired',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(scheduler.snapshot().projects).toEqual([]);
  });

  test('synchronous throws and asynchronous rejection release actual execution ownership', async () => {
    const scheduler = new FairWorkScheduler(options(clock()));
    const error = new Error('worker failure');
    const failed = scheduler.submit({
      project: 'P',
      session: 'S',
      execute: () => {
        throw error;
      },
    });
    expect(await failed.result).toEqual({ status: 'failed', error });
    const rejected = scheduler.submit({
      project: 'P',
      session: 'S',
      execute: () => Promise.reject(error),
    });
    expect(await rejected.result).toEqual({ status: 'failed', error });
    const completed = scheduler.submit({ project: 'P', session: 'S', execute: () => 'recovered' });
    expect(await completed.result).toEqual({ status: 'completed', value: 'recovered' });
    expect(scheduler.snapshot().idleEligible).toBe(true);
  });
});

describe('scheduler rendering reservations', () => {
  test('slow rendering does not block same-session independent enforcement or foreign projects', async () => {
    const scheduler = new FairWorkScheduler(options(clock(), { maxRenderingActive: 2 }));
    const workers = controlled(scheduler);
    const render = workers.add('P', 'S', { lane: 'render' });
    const renderTwo = workers.add('P', 'S', { lane: 'render', stateDomain: 'other-render' });
    const required = workers.add('P', 'S');
    const foreign = workers.add('Q', 'S');
    expect(render.signal).not.toBeNull();
    expect(renderTwo.signal).toBeNull();
    expect(required.signal).not.toBeNull();
    expect(foreign.signal).not.toBeNull();
    expect(workers.inFlight.has(render)).toBe(true);
    expect(workers.inFlight.has(required)).toBe(true);
    expect(workers.overlaps).toEqual([]);
    expect(workers.peakPerProject.get('P')).toBe(2);
    expect(scheduler.snapshot()).toMatchObject({ active: 3, renderingActive: 1, queued: 1 });
    await workers.completeAll();
    expect(scheduler.snapshot().idleEligible).toBe(true);
  });

  test('optional rendering cannot consume machine slots reserved for required work', async () => {
    const scheduler = new FairWorkScheduler(options(clock(), { maxRenderingActive: 2 }));
    const workers = controlled(scheduler);
    for (const project of ['A', 'B', 'C', 'D']) workers.add(project, 'render', { lane: 'render' });
    expect(scheduler.snapshot()).toMatchObject({ active: 2, queued: 2, renderingActive: 2 });
    workers.add('C', 'required');
    workers.add('D', 'required');
    expect(scheduler.snapshot()).toMatchObject({ active: 4, queued: 2, renderingActive: 2 });
    expect(
      workers.started.filter((job) => job.session === 'required').map((job) => job.project)
    ).toEqual(['C', 'D']);
    await workers.completeAll();
  });

  test('rendering queue limits preserve both machine and same-session required admission', async () => {
    const scheduler = new FairWorkScheduler(
      options(clock(), {
        maxQueued: 8,
        maxQueuedPerProject: 4,
        maxQueuedPerSession: 2,
        maxRenderingQueued: 2,
      })
    );
    const workers = controlled(scheduler);
    workers.add('A', 'active', { lane: 'render' });
    workers.add('B', 'active');
    workers.add('C', 'active');
    workers.add('D', 'active');
    expect(workers.add('A', 'shared-session', { lane: 'render' }).admission.status).toBe(
      'admitted'
    );
    expect(
      workers.add('A', 'shared-session', { lane: 'render', stateDomain: 'extra-render' }).admission
    ).toEqual({ status: 'queue_full', reason: 'render_session' });
    expect(workers.add('A', 'shared-session').admission.status).toBe('admitted');
    expect(workers.add('B', 'render', { lane: 'render' }).admission.status).toBe('admitted');
    expect(workers.add('C', 'render', { lane: 'render' }).admission).toEqual({
      status: 'queue_full',
      reason: 'render_machine',
    });
    expect(workers.add('C', 'required').admission.status).toBe('admitted');
    expect(scheduler.snapshot()).toMatchObject({ queued: 4, renderingQueued: 2 });
    await workers.completeAll();
    expect(scheduler.snapshot()).toMatchObject({
      queued: 0,
      renderingQueued: 0,
      idleEligible: true,
    });
  });

  test('expired optional queue entries return class admission capacity', async () => {
    const time = clock();
    const scheduler = new FairWorkScheduler(options(time, { maxRenderingQueued: 1 }));
    const workers = controlled(scheduler);
    workers.add('A', 'active', { lane: 'render' });
    const expired = workers.add('B', 'queued', { lane: 'render', deadline: 5 });
    expect(scheduler.snapshot().renderingQueued).toBe(1);
    time.advance(5);
    expect(await expired.admission.result).toEqual({ status: 'expired' });
    expect(expired.signal).toBeNull();
    expect(scheduler.snapshot().renderingQueued).toBe(0);
    expect(workers.add('C', 'replacement', { lane: 'render' }).admission.status).toBe('admitted');
    await workers.completeAll();
    expect(scheduler.snapshot().renderingQueued).toBe(0);
  });

  test('an explicit overlapping state domain serializes render and required work until actual settlement', async () => {
    const scheduler = new FairWorkScheduler(options(clock()));
    const workers = controlled(scheduler);
    const abort = new AbortController();
    const render = workers.add('P', 'S', {
      lane: 'render',
      stateDomain: 'shared',
      signal: abort.signal,
    });
    const required = workers.add('P', 'S', { stateDomain: 'shared' });
    abort.abort();
    expect(await render.admission.result).toEqual({ status: 'cancelled' });
    expect(required.signal).toBeNull();
    expect(scheduler.snapshot().active).toBe(1);
    expect(workers.inFlight.has(render)).toBe(true);
    expect(workers.inFlight.has(required)).toBe(false);
    render.finish();
    await flush();
    expect(required.signal).not.toBeNull();
    await workers.completeAll();
    expect(workers.overlaps).toEqual([]);
    expect(workers.inFlight.size).toBe(0);
  });

  test('disabled rendering is refused instead of remaining queued forever', () => {
    const scheduler = new FairWorkScheduler(
      options(clock(), { maxActive: 2, maxActivePerProject: 1, maxRenderingActive: 0 })
    );
    expect(
      scheduler.submit({ project: 'P', session: 'S', lane: 'render', execute: () => 1 })
    ).toEqual({ status: 'lane_disabled' });
    expect(scheduler.snapshot().idleEligible).toBe(true);
  });

  test.each([
    { maxActive: 1 },
    { maxQueued: -1 },
    { maxActivePerProject: 4 },
    { maxRenderingActive: 4 },
    { maxActivePerProject: 1 },
    { maxRenderingPerProject: 2 },
    { maxRenderingPerProject: 0 },
    { maxQueued: 1 },
    { maxQueued: 2 },
    { maxQueuedPerProject: 32 },
    { maxQueuedPerSession: 16 },
    { maxRenderingQueued: 32 },
  ])('rejects impossible capacity reservations %#', (overrides) => {
    expect(() => new FairWorkScheduler(options(clock(), overrides))).toThrow(RangeError);
  });
});

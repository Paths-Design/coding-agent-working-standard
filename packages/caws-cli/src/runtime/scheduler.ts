import { performance } from 'node:perf_hooks';

export type WorkLane = 'required' | 'render';
export interface SchedulerClock {
  /** Monotonic milliseconds; deadlines use this same clock's origin. */
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}
export interface SchedulerOptions {
  maxActive: number;
  maxQueued: number;
  maxQueuedPerProject?: number;
  maxQueuedPerSession?: number;
  maxRenderingQueued?: number;
  maxActivePerProject: number;
  maxRenderingActive: number;
  maxRenderingPerProject?: number;
  clock?: SchedulerClock;
}
export type WorkResult<T> =
  | { status: 'completed'; value: T }
  | { status: 'failed'; error: unknown }
  | { status: 'cancelled' | 'expired' };
export type WorkAdmission<T> =
  | { status: 'admitted'; result: Promise<WorkResult<T>> }
  | {
      status: 'queue_full';
      reason:
        | 'machine'
        | 'project'
        | 'session'
        | 'render_machine'
        | 'render_project'
        | 'render_session';
    }
  | { status: 'draining' | 'cancelled' | 'expired' | 'lane_disabled' };
export interface WorkRequest<T> {
  project: string;
  session: string;
  lane?: WorkLane;
  /** State domains serialize only work that can touch the same state. */
  stateDomain?: string;
  deadline?: number;
  signal?: AbortSignal;
  execute(signal: AbortSignal): PromiseLike<T> | T;
}
export interface SchedulerSnapshot {
  active: number;
  queued: number;
  renderingActive: number;
  renderingQueued: number;
  draining: boolean;
  idleEligible: boolean;
  projects: readonly {
    project: string;
    active: number;
    queued: number;
    renderingActive: number;
    renderingQueued: number;
  }[];
}

interface Project {
  key: string;
  active: number;
  renderingActive: number;
  renderingQueued: number;
  queued: number;
  sessions: Map<string, Session>;
  rotation: Session[];
}
interface Session {
  key: string;
  queued: number;
  renderingQueued: number;
  project: Project;
  domains: Map<string, Owner>;
  rotation: Owner[];
}
interface Owner {
  key: string;
  session: Session;
  running: boolean;
  queue: Task[];
}
interface Task {
  owner: Owner;
  lane: WorkLane;
  deadline: number | undefined;
  state: 'queued' | 'running' | 'settled';
  clientFinished: boolean;
  controller: AbortController;
  externalSignal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
  timer: unknown;
  timerArmed: boolean;
  execute(signal: AbortSignal): unknown;
  resolve(result: WorkResult<unknown>): void;
}

const systemClock: SchedulerClock = {
  now: () => performance.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One machine's admission controller. It grants execution capacity, never project authority.
 * Executors must settle to release capacity: aborting a caller only signals running work.
 * There is no persistence, recovery, daemon startup or native IPC in this component.
 */
export class FairWorkScheduler {
  private readonly clock: SchedulerClock;
  private readonly maxActive: number;
  private readonly maxQueued: number;
  private readonly maxQueuedPerProject: number;
  private readonly maxQueuedPerSession: number;
  private readonly maxRenderingQueued: number;
  private readonly maxRenderingQueuedPerProject: number;
  private readonly maxRenderingQueuedPerSession: number;
  private readonly maxActivePerProject: number;
  private readonly maxRenderingActive: number;
  private readonly maxRenderingPerProject: number;
  private readonly projects = new Map<string, Project>();
  private readonly rotation: Project[] = [];
  private idlePromise: Promise<void> | undefined;
  private resolveIdle: (() => void) | undefined;
  private active = 0;
  private queued = 0;
  private renderingActive = 0;
  private renderingQueued = 0;
  private draining = false;
  private pumping = false;

  constructor(options: SchedulerOptions) {
    const integer = (value: number, minimum: number): boolean =>
      Number.isSafeInteger(value) && value >= minimum;
    if (
      !integer(options.maxActive, 2) ||
      !integer(options.maxQueued, 0) ||
      !integer(options.maxActivePerProject, 1) ||
      options.maxActivePerProject >= options.maxActive ||
      !integer(options.maxRenderingActive, 0) ||
      options.maxRenderingActive >= options.maxActive
    ) {
      throw new RangeError(
        'scheduler limits must reserve capacity for another project and required work'
      );
    }
    const renderProject =
      options.maxRenderingPerProject ??
      Math.min(options.maxRenderingActive, options.maxActivePerProject - 1);
    if (
      !integer(renderProject, 0) ||
      renderProject >= options.maxActivePerProject ||
      renderProject > options.maxRenderingActive ||
      (options.maxRenderingActive > 0 && (options.maxActivePerProject < 2 || renderProject < 1)) ||
      (options.maxRenderingActive === 0 && renderProject !== 0)
    ) {
      throw new RangeError('rendering limits must leave required capacity within every project');
    }
    const projectQueue =
      options.maxQueuedPerProject ??
      (options.maxQueued === 0 ? 0 : Math.max(2, Math.floor(options.maxQueued / 2)));
    const sessionQueue =
      options.maxQueuedPerSession ??
      (projectQueue === 0 ? 0 : Math.max(1, Math.floor(projectQueue / 2)));
    const renderingQueue =
      options.maxRenderingQueued ??
      (options.maxRenderingActive === 0 ? 0 : Math.floor(options.maxQueued / 4));
    if (
      !integer(projectQueue, 0) ||
      !integer(sessionQueue, 0) ||
      !integer(renderingQueue, 0) ||
      (options.maxQueued === 0 &&
        (projectQueue !== 0 || sessionQueue !== 0 || renderingQueue !== 0)) ||
      (options.maxQueued > 0 &&
        (options.maxQueued < 3 ||
          projectQueue < 2 ||
          projectQueue >= options.maxQueued ||
          sessionQueue < 1 ||
          sessionQueue >= projectQueue ||
          renderingQueue >= options.maxQueued)) ||
      (options.maxRenderingActive === 0 && renderingQueue !== 0)
    ) {
      throw new RangeError(
        'queue limits must reserve space for another project, session and required work'
      );
    }
    this.clock = options.clock ?? systemClock;
    this.maxActive = options.maxActive;
    this.maxQueued = options.maxQueued;
    this.maxQueuedPerProject = projectQueue;
    this.maxQueuedPerSession = sessionQueue;
    this.maxRenderingQueued = renderingQueue;
    this.maxRenderingQueuedPerProject = Math.min(renderingQueue, Math.max(0, projectQueue - 1));
    this.maxRenderingQueuedPerSession = Math.min(renderingQueue, Math.max(0, sessionQueue - 1));
    this.maxActivePerProject = options.maxActivePerProject;
    this.maxRenderingActive = options.maxRenderingActive;
    this.maxRenderingPerProject = renderProject;
  }

  submit<T>(request: WorkRequest<T>): WorkAdmission<T> {
    const lane = request.lane ?? 'required';
    const domain =
      request.stateDomain ?? (lane === 'render' ? 'session-render' : 'session-enforcement');
    if (!request.project || !request.session || !domain || !['required', 'render'].includes(lane))
      throw new TypeError('work requires project, session, state domain and a supported lane');
    if (request.deadline !== undefined && !Number.isFinite(request.deadline))
      throw new RangeError('deadline must use finite monotonic milliseconds');
    if (this.draining) return { status: 'draining' };
    if (request.signal?.aborted) return { status: 'cancelled' };
    if (request.deadline !== undefined && request.deadline <= this.clock.now())
      return { status: 'expired' };
    if (lane === 'render' && this.maxRenderingActive === 0) return { status: 'lane_disabled' };
    this.pump();
    const existing = this.projects
      .get(request.project)
      ?.sessions.get(request.session)
      ?.domains.get(domain);
    const project = this.projects.get(request.project);
    const immediate =
      !this.pumping &&
      !existing?.running &&
      !existing?.queue.length &&
      this.hasCapacity(project, lane);
    if (!immediate) {
      const reason = this.queueLimit(project, project?.sessions.get(request.session), lane);
      if (reason !== null) return { status: 'queue_full', reason };
    }
    const owner = existing ?? this.createOwner(request.project, request.session, domain);
    let resolve!: (value: WorkResult<T>) => void;
    const result = new Promise<WorkResult<T>>((done) => {
      resolve = done;
    });
    const task: Task = {
      owner,
      lane,
      deadline: request.deadline,
      state: immediate ? 'running' : 'queued',
      clientFinished: false,
      controller: new AbortController(),
      externalSignal: request.signal,
      abortListener: undefined,
      timer: undefined,
      timerArmed: false,
      execute: request.execute,
      resolve: (value) => resolve(value as WorkResult<T>),
    };
    if (immediate) {
      this.rotate(owner);
      this.start(task);
    } else {
      owner.queue.push(task);
      this.queued++;
      owner.session.project.queued++;
      owner.session.queued++;
      if (lane === 'render') {
        this.renderingQueued++;
        owner.session.project.renderingQueued++;
        owner.session.renderingQueued++;
      }
      this.arm(task);
      this.pump();
    }
    return { status: 'admitted', result };
  }

  snapshot(): SchedulerSnapshot {
    return {
      active: this.active,
      queued: this.queued,
      renderingActive: this.renderingActive,
      renderingQueued: this.renderingQueued,
      draining: this.draining,
      idleEligible: this.active === 0 && this.queued === 0,
      projects: [...this.projects.values()].map((project) => ({
        project: project.key,
        active: project.active,
        queued: project.queued,
        renderingActive: project.renderingActive,
        renderingQueued: project.renderingQueued,
      })),
    };
  }

  /** Already admitted work survives drain; idle requires actual executor settlement. */
  drain(): Promise<void> {
    this.draining = true;
    this.pump();
    return this.whenIdle();
  }

  whenIdle(): Promise<void> {
    if (this.active === 0 && this.queued === 0) return Promise.resolve();
    this.idlePromise ??= new Promise((resolve) => {
      this.resolveIdle = resolve;
    });
    return this.idlePromise;
  }

  private createOwner(projectKey: string, sessionKey: string, domain: string): Owner {
    let project = this.projects.get(projectKey);
    if (!project) {
      project = {
        key: projectKey,
        active: 0,
        renderingActive: 0,
        queued: 0,
        renderingQueued: 0,
        sessions: new Map(),
        rotation: [],
      };
      this.projects.set(projectKey, project);
      this.rotation.push(project);
    }
    let session = project.sessions.get(sessionKey);
    if (!session) {
      session = {
        key: sessionKey,
        project,
        queued: 0,
        renderingQueued: 0,
        domains: new Map(),
        rotation: [],
      };
      project.sessions.set(sessionKey, session);
      project.rotation.push(session);
    }
    const owner: Owner = { key: domain, session, running: false, queue: [] };
    session.domains.set(domain, owner);
    session.rotation.push(owner);
    return owner;
  }

  private hasCapacity(project: Project | undefined, lane: WorkLane): boolean {
    if (this.active >= this.maxActive || (project?.active ?? 0) >= this.maxActivePerProject)
      return false;
    return (
      lane !== 'render' ||
      (this.renderingActive < this.maxRenderingActive &&
        (project?.renderingActive ?? 0) < this.maxRenderingPerProject)
    );
  }

  private queueLimit(
    project: Project | undefined,
    session: Session | undefined,
    lane: WorkLane
  ): Extract<WorkAdmission<never>, { status: 'queue_full' }>['reason'] | null {
    if (this.queued >= this.maxQueued) return 'machine';
    if ((project?.queued ?? 0) >= this.maxQueuedPerProject) return 'project';
    if ((session?.queued ?? 0) >= this.maxQueuedPerSession) return 'session';
    if (lane === 'render') {
      if (this.renderingQueued >= this.maxRenderingQueued) return 'render_machine';
      if ((project?.renderingQueued ?? 0) >= this.maxRenderingQueuedPerProject)
        return 'render_project';
      if ((session?.renderingQueued ?? 0) >= this.maxRenderingQueuedPerSession)
        return 'render_session';
    }
    return null;
  }

  private removeQueuedCounters(task: Task): void {
    this.queued--;
    task.owner.session.project.queued--;
    task.owner.session.queued--;
    if (task.lane === 'render') {
      this.renderingQueued--;
      task.owner.session.project.renderingQueued--;
      task.owner.session.renderingQueued--;
    }
  }

  private rotate(owner: Owner): void {
    const move = <T>(array: T[], value: T): void => {
      const index = array.indexOf(value);
      if (index >= 0) {
        array.splice(index, 1);
        array.push(value);
      }
    };
    move(this.rotation, owner.session.project);
    move(owner.session.project.rotation, owner.session);
    move(owner.session.rotation, owner);
  }

  private select(): Task | null {
    for (const project of [...this.rotation]) {
      for (const session of [...project.rotation]) {
        for (const owner of [...session.rotation]) {
          if (owner.running) continue;
          while (owner.queue.length) {
            const task = owner.queue[0];
            if (!task) break;
            if (task.deadline !== undefined && task.deadline <= this.clock.now()) {
              this.detach(task, 'expired');
              continue;
            }
            if (!this.hasCapacity(project, task.lane)) break;
            owner.queue.shift();
            this.removeQueuedCounters(task);
            this.rotate(owner);
            return task;
          }
        }
      }
    }
    return null;
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.active < this.maxActive) {
        const task = this.select();
        if (task === null) break;
        this.start(task);
      }
    } finally {
      this.pumping = false;
    }
    this.notifyIdle();
  }

  private arm(task: Task): void {
    if (task.externalSignal) {
      task.abortListener = () => this.detach(task, 'cancelled');
      task.externalSignal.addEventListener('abort', task.abortListener, { once: true });
      if (task.externalSignal.aborted) {
        this.detach(task, 'cancelled');
        return;
      }
    }
    if (task.deadline !== undefined) {
      this.armDeadline(task);
    }
  }

  private armDeadline(task: Task): void {
    if (task.deadline === undefined || task.clientFinished) return;
    const delay = task.deadline - this.clock.now();
    if (delay <= 0) {
      this.detach(task, 'expired');
      return;
    }
    task.timerArmed = true;
    task.timer = this.clock.setTimer(
      () => {
        task.timerArmed = false;
        // Timers may fire early, and Node clamps delays exceeding its signed 32-bit limit.
        this.armDeadline(task);
      },
      Math.min(delay, 2147483647)
    );
  }

  private start(task: Task): void {
    task.state = 'running';
    task.owner.running = true;
    this.active++;
    task.owner.session.project.active++;
    if (task.lane === 'render') {
      this.renderingActive++;
      task.owner.session.project.renderingActive++;
    }
    if (!task.abortListener && !task.timerArmed) this.arm(task);
    // A signal observed while arming prevents execution; no worker has started yet.
    if (task.clientFinished) {
      this.settled(task, { status: 'cancelled' });
      return;
    }
    let execution: unknown;
    try {
      execution = task.execute(task.controller.signal);
    } catch (error) {
      this.settled(task, { status: 'failed', error });
      return;
    }
    Promise.resolve(execution).then(
      (value) => this.settled(task, { status: 'completed', value }),
      (error: unknown) => this.settled(task, { status: 'failed', error })
    );
  }

  private clientResult(task: Task, result: WorkResult<unknown>): void {
    if (task.clientFinished) return;
    task.clientFinished = true;
    if (task.abortListener && task.externalSignal)
      task.externalSignal.removeEventListener('abort', task.abortListener);
    task.abortListener = undefined;
    if (task.timerArmed) this.clock.clearTimer(task.timer);
    task.timerArmed = false;
    task.resolve(result);
  }

  private detach(task: Task, status: 'cancelled' | 'expired'): void {
    if (task.state === 'settled' || task.clientFinished) return;
    this.clientResult(task, { status });
    task.controller.abort();
    if (task.state === 'queued') {
      const index = task.owner.queue.indexOf(task);
      if (index >= 0) {
        task.owner.queue.splice(index, 1);
        this.removeQueuedCounters(task);
      }
      task.state = 'settled';
      this.cleanup(task.owner);
      this.pump();
    }
  }

  private settled(task: Task, result: WorkResult<unknown>): void {
    if (task.state !== 'running') return;
    if (!task.clientFinished && task.deadline !== undefined && task.deadline <= this.clock.now())
      this.detach(task, 'expired');
    this.clientResult(task, result);
    task.state = 'settled';
    task.owner.running = false;
    this.active--;
    task.owner.session.project.active--;
    if (task.lane === 'render') {
      this.renderingActive--;
      task.owner.session.project.renderingActive--;
    }
    this.cleanup(task.owner);
    this.pump();
  }

  private cleanup(owner: Owner): void {
    if (owner.running || owner.queue.length) return;
    const session = owner.session;
    const project = session.project;
    session.domains.delete(owner.key);
    session.rotation.splice(session.rotation.indexOf(owner), 1);
    if (session.domains.size) return;
    project.sessions.delete(session.key);
    project.rotation.splice(project.rotation.indexOf(session), 1);
    if (project.sessions.size || project.active > 0 || project.queued > 0) return;
    this.projects.delete(project.key);
    this.rotation.splice(this.rotation.indexOf(project), 1);
  }

  private notifyIdle(): void {
    if (this.active !== 0 || this.queued !== 0) return;
    const resolve = this.resolveIdle;
    this.resolveIdle = undefined;
    this.idlePromise = undefined;
    resolve?.();
  }
}

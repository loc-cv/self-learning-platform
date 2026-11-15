// The process runtime (docs/ARCHITECTURE.md §3.4, §3.5): programs are synchronous generators that
// yield syscalls; the runtime executes each one and resumes the generator with the result. A
// syscall that cannot complete leaves the process blocked, recorded as data in its `wait` field.
// The runtime resumes a process only while handling a `host.proc.run` event for it, so the
// interleaving of processes is a pure function of the world.
//
// Coroutine frames are not world data. They are kept here, per world object, and a kernel created
// over a fork or a restored snapshot has none: `attachProcesses` then ends every program that is
// not at a restart point, as if by SIGKILL.

import { put, remove, type Ctx, type Json, type World } from '@simlab/kernel';
import { getMachine, hostSlice, type Machine } from '../machine.ts';
import { FsError, UnsupportedError } from '../vfs/errno.ts';
import { readInode, writeInode } from '../vfs/fs.ts';
import { createOpenFile, getStream, release, retain, storeStream, streamTopic } from './descriptors.ts';
import { simNotice, styleNotice } from './notice.ts';
import { PROGRAM, type ProcApi, type ProgramSpec, type SpawnRequest, type Syscall } from './program.ts';
import { createProcApi } from './api.ts';
import { SIGKILL, SIGPIPE } from './signals.ts';
import type { ExitStatus, Fd, Proc } from './types.ts';
import { ttyRead, ttyWrite } from '../tty/discipline.ts';
import { editorTopic, openEditorSession, takeEditorResult } from './editor.ts';

/**
 * Syscalls a process may execute in one run slice before it is preempted and resumed 1 ms later
 * (§2.5, §3.4). Large enough that ordinary programs finish a burst of output in one slice, small
 * enough that `yes > /dev/null` burns virtual time and can be interrupted. Decided in phase 02.
 */
export const SLICE_BUDGET = 1000;
/** Virtual time charged to a process that used up its slice. */
export const PREEMPT_DELAY = 1;

/** The first pid handed out on a machine; lower numbers belong to boot-time processes (phase 25a). */
export const FIRST_PID = 1000;

export const RUN = 'host.proc.run';
export const exitTopic = (machine: string, pid: string): string => `host.proc.exit:${machine}:${pid}`;

/** Thrown inside a program to end it with a status (`exit`, `unsupported`). */
export class ProgramExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.name = 'ProgramExit';
    this.code = code;
  }
}

/** Thrown inside a program to replace its image, as execve(2) does: same pid, descriptors and group. */
export class ExecImage extends Error {
  readonly program: string;
  readonly argv: string[];
  readonly env: Record<string, string>;
  readonly data: Json | undefined;
  constructor(program: string, argv: string[], env: Record<string, string>, data?: Json) {
    super(`exec ${program}`);
    this.name = 'ExecImage';
    this.program = program;
    this.argv = argv;
    this.env = env;
    this.data = data;
  }
}

/** Thrown into a program whose blocked syscall was interrupted by a signal it traps. */
export class Interrupted extends Error {
  readonly signal: number;
  constructor(signal: number) {
    super(`interrupted by signal ${signal}`);
    this.name = 'Interrupted';
    this.signal = signal;
  }
}

interface Frame {
  gen: Generator<Syscall, number, unknown>;
  /** The syscall the process is blocked in, retried when it is woken. Mutable progress lives on it. */
  pending?: PendingSyscall;
  /** What to resume the generator with next. */
  next: Outcome;
}

type PendingSyscall = Syscall & { deadline?: number; written?: number; session?: string };

type Outcome = { value: unknown } | { error: unknown };

type Step = { done: true; outcome: Outcome } | { done: false; topic?: string; timer?: number } | { signal: number };

const framesByWorld = new WeakMap<World, Map<string, Frame>>();

function frames(ctx: Ctx): Map<string, Frame> {
  let m = framesByWorld.get(ctx.world);
  if (!m) framesByWorld.set(ctx.world, (m = new Map()));
  return m;
}

const key = (machine: string, pid: string): string => `${machine}/${pid}`;

export function getProc(machine: Machine, pid: string): Proc {
  const p = machine.procs[pid];
  if (!p) throw new Error(`machine ${machine.id}: no process ${pid}`);
  return p;
}

function storeProc(machine: Machine, p: Proc): Proc {
  return put(machine.procs, p.pid, p);
}

/** Process ids on a machine, in numeric order (the defined iteration order of hard rule 4). */
export function pidsOf(machine: Machine): string[] {
  return Object.keys(machine.procs).sort((a, b) => Number(a) - Number(b));
}

function program(ctx: Ctx, name: string): ProgramSpec | undefined {
  return ctx.registry.get<ProgramSpec>(PROGRAM, name);
}

/** Runs a program that the machine has an executable for but the simulator does not implement. */
function* unsimulated(p: ProcApi): Generator<Syscall, number, unknown> {
  return yield* p.unsupported({ kind: 'command', what: 'this program' });
}

/**
 * Creates a process. With `parent`, the child inherits its credentials, working directory,
 * environment, umask, terminal and process group unless the request says otherwise, and its
 * descriptors as `req.fds` maps them (all of them by default). Without `parent` (a terminal's
 * session leader, a test), the request must give everything. The child runs from its next slice.
 */
export function spawnProcess(ctx: Ctx, machineId: string, parent: Proc | undefined, req: SpawnRequest): string {
  const machine = getMachine(ctx, machineId);
  const pid = String(ctx.nextId(`host.pid:${machineId}`) + FIRST_PID - 1);
  const fds: Record<string, Fd> = {};
  if (req.fds) {
    for (const [child, from] of Object.entries(req.fds)) {
      const fd = typeof from === 'number' ? parent?.fds[String(from)] : from;
      if (fd) fds[child] = fd;
    }
  } else if (parent) {
    Object.assign(fds, parent.fds);
  }
  for (const n of Object.keys(fds).sort((a, b) => Number(a) - Number(b))) retain(ctx, machineId, fds[n] as Fd);
  const pgid = req.pgid === 'new' ? pid : (req.pgid ?? parent?.pgid ?? pid);
  const proc: Proc = {
    pid,
    ppid: parent?.pid ?? '0',
    pgid,
    sid: req.sid === 'new' ? pid : (parent?.sid ?? pid),
    uid: req.cred?.uid ?? parent?.uid ?? 0,
    gid: req.cred?.gid ?? parent?.gid ?? 0,
    groups: [...(req.cred?.groups ?? parent?.groups ?? [0])],
    argv: [...req.argv],
    image: req.program,
    cwd: req.cwd ?? parent?.cwd ?? '/',
    env: { ...(req.env ?? parent?.env ?? {}) },
    umask: req.umask ?? parent?.umask ?? 0o022,
    startedAt: ctx.now,
    state: 'running',
    fds,
  };
  const tty = req.tty ?? parent?.tty;
  if (tty !== undefined) proc.tty = tty;
  if (req.data !== undefined) proc.spawnData = req.data;
  storeProc(machine, proc);
  const api = createProcApi(ctx, machineId, pid);
  const spec = program(ctx, req.program);
  frames(ctx).set(key(machineId, pid), { gen: spec ? spec.main(api) : unsimulated(api), next: { value: undefined } });
  ctx.schedule(0, RUN, { machine: machineId, pid });
  return pid;
}

/** Signals a process. Delivered between syscalls: a blocked process is woken to act on it. */
export function signalProcess(ctx: Ctx, machineId: string, pid: string, sig: number): void {
  const machine = getMachine(ctx, machineId);
  const p = machine.procs[pid];
  if (!p || p.state !== 'running') return;
  const disposition = p.traps?.[String(sig)];
  if (disposition === 'ignore' && sig !== SIGKILL) return;
  storeProc(machine, { ...p, signal: p.signal === SIGKILL ? SIGKILL : sig });
  if (p.wait) {
    clearWait(ctx, machine, pid);
    ctx.schedule(0, RUN, { machine: machineId, pid });
  }
}

/** Signals every process in a process group, in pid order. */
export function signalGroup(ctx: Ctx, machineId: string, pgid: string, sig: number): void {
  const machine = getMachine(ctx, machineId);
  for (const pid of pidsOf(machine)) {
    if (machine.procs[pid]?.pgid === pgid) signalProcess(ctx, machineId, pid, sig);
  }
}

function clearWait(ctx: Ctx, machine: Machine, pid: string): void {
  const p = getProc(machine, pid);
  if (!p.wait) return;
  if (p.wait.topic !== undefined && p.wait.waiter !== undefined) ctx.unsubscribe(p.wait.topic, p.wait.waiter);
  if (p.wait.timer !== undefined) ctx.cancel(p.wait.timer);
  const { wait: _, ...rest } = p;
  storeProc(machine, rest);
}

/** Ends a process: closes its descriptors, records the status and wakes whoever waits for it. */
function exitProcess(ctx: Ctx, machine: Machine, pid: string, status: ExitStatus): void {
  clearWait(ctx, machine, pid);
  frames(ctx).delete(key(machine.id, pid));
  const p = getProc(machine, pid);
  for (const n of Object.keys(p.fds).sort((a, b) => Number(a) - Number(b))) release(ctx, machine.id, p.fds[n] as Fd);
  const { resume: _r, signal: _s, spawnData: _d, ...rest } = p;
  storeProc(machine, { ...rest, fds: {}, state: 'zombie', exit: status });
  // Children: zombies are reaped by init, live ones are adopted by it.
  for (const c of pidsOf(machine)) {
    const child = machine.procs[c] as Proc;
    if (child.ppid !== pid) continue;
    if (child.state === 'zombie') remove(machine.procs, c);
    else storeProc(machine, { ...child, ppid: '1' });
  }
  if (p.ppid === '1') remove(machine.procs, pid);
  ctx.publish(exitTopic(machine.id, pid));
}

/** Removes a zombie and returns its status (wait(2)). */
export function reap(machine: Machine, pid: string): ExitStatus | undefined {
  const p = machine.procs[pid];
  if (!p || p.state !== 'zombie' || !p.exit) return undefined;
  remove(machine.procs, pid);
  return p.exit;
}

/** Terminates on a signal: the generator's `finally` blocks run, except for SIGKILL. */
function terminate(ctx: Ctx, machine: Machine, pid: string, sig: number): void {
  const frame = frames(ctx).get(key(machine.id, pid));
  if (frame && sig !== SIGKILL) {
    try {
      // `finally` blocks must not perform syscalls; a yield there ends the cleanup.
      frame.gen.return(0);
    } catch {
      // A cleanup that throws cannot keep the process alive.
    }
  }
  exitProcess(ctx, machine, pid, { signal: sig });
}

export function runProcess(ctx: Ctx, machineId: string, pid: string): void {
  const machine = getMachine(ctx, machineId);
  const p = machine.procs[pid];
  if (!p || p.state !== 'running') return;
  clearWait(ctx, machine, pid);
  let frame = frames(ctx).get(key(machineId, pid));
  if (!frame) {
    const spec = program(ctx, p.image);
    if (p.resume === undefined || !spec?.restart) {
      terminate(ctx, machine, pid, SIGKILL);
      return;
    }
    frame = { gen: spec.restart(createProcApi(ctx, machineId, pid), p.resume), next: { value: undefined } };
    frames(ctx).set(key(machineId, pid), frame);
  }

  for (let budget = SLICE_BUDGET; ; ) {
    const cur = getProc(machine, pid);
    if (cur.signal !== undefined) {
      const sig = cur.signal;
      const { signal: _, ...rest } = cur;
      storeProc(machine, rest);
      if (cur.traps?.[String(sig)] === 'interrupt' && sig !== SIGKILL) {
        delete frame.pending;
        frame.next = { error: new Interrupted(sig) };
      } else {
        terminate(ctx, machine, pid, sig);
        return;
      }
    }

    if (frame.pending) {
      const step = execute(ctx, machine, pid, frame.pending);
      if ('signal' in step) {
        signalProcess(ctx, machineId, pid, step.signal);
        continue;
      }
      if (!step.done) {
        block(ctx, machine, pid, step);
        return;
      }
      delete frame.pending;
      frame.next = step.outcome;
    }

    if (budget-- <= 0) {
      ctx.schedule(PREEMPT_DELAY, RUN, { machine: machineId, pid });
      return;
    }

    let res: IteratorResult<Syscall, number>;
    try {
      res = 'error' in frame.next ? frame.gen.throw(frame.next.error) : frame.gen.next(frame.next.value);
    } catch (e) {
      if (e instanceof ExecImage) {
        frame = execImage(ctx, machine, pid, e);
        continue;
      }
      crashed(ctx, machine, pid, e);
      return;
    }
    if (res.done) {
      exitProcess(ctx, machine, pid, { code: res.value & 0xff });
      return;
    }
    frame.pending = { ...res.value };
    frame.next = { value: undefined };
  }
}

/** Replaces the program a process runs (execve(2)): caught signals reset, ignored ones stay ignored. */
function execImage(ctx: Ctx, machine: Machine, pid: string, e: ExecImage): Frame {
  const p = getProc(machine, pid);
  const { spawnData: _d, resume: _r, traps, ...rest } = p;
  const kept: Record<string, 'ignore' | 'interrupt'> = {};
  for (const k of Object.keys(traps ?? {})) if (traps?.[k] === 'ignore') kept[k] = 'ignore';
  const next: Proc = { ...rest, image: e.program, argv: [...e.argv], env: { ...e.env } };
  if (Object.keys(kept).length > 0) next.traps = kept;
  if (e.data !== undefined) next.spawnData = e.data;
  storeProc(machine, next);
  const api = createProcApi(ctx, machine.id, pid);
  const spec = program(ctx, e.program);
  const frame: Frame = { gen: spec ? spec.main(api) : unsimulated(api), next: { value: undefined } };
  frames(ctx).set(key(machine.id, pid), frame);
  return frame;
}

/** An exception escaped the program: an exit request, something unsupported, or a simulator bug. */
function crashed(ctx: Ctx, machine: Machine, pid: string, e: unknown): void {
  const p = getProc(machine, pid);
  const name = (p.argv[0]?.split('/').pop() ?? p.image).replace(/^-/, '');
  if (e instanceof ProgramExit) {
    exitProcess(ctx, machine, pid, { code: e.code & 0xff });
    return;
  }
  let text: string;
  if (e instanceof UnsupportedError) {
    text = simNotice(name, e.what);
    ctx.gap({ kind: 'behavior', program: name, what: e.what, commandLine: p.argv.join(' '), machine: machine.id });
  } else {
    const id = ctx.nextId('host.gap').toString(16).padStart(8, '0');
    const err = e instanceof Error ? e : new Error(String(e));
    text = `[sim] ${name}: internal simulator error (gap ${id})\n`;
    ctx.gap({
      kind: 'internal',
      program: name,
      what: `internal simulator error (gap ${id})`,
      key: `internal:${name}:${err.message}`,
      commandLine: p.argv.join(' '),
      machine: machine.id,
      error: err.stack === undefined ? { message: err.message } : { message: err.message, stack: err.stack },
    });
  }
  // Best effort, without blocking: the notice goes to a terminal or a file directly; a pipe gets
  // what fits.
  const fd = p.fds['2'];
  if (fd) writeNow(ctx, machine, fd, text);
  exitProcess(ctx, machine, pid, { code: 250 });
}

function writeNow(ctx: Ctx, machine: Machine, fd: Fd, text: string): void {
  try {
    if (fd.kind === 'tty') ttyWrite(ctx, fd.tty, styleNotice(text));
    else if (fd.kind === 'file') fileWrite(ctx, machine, fd.file, text);
    else {
      const s = getStream(ctx, fd.stream);
      if (s.readers > 0) {
        storeStream(ctx, { ...s, data: s.data + text.slice(0, Math.max(0, s.capacity - s.data.length)) });
        ctx.publish(streamTopic(s.id));
      }
    }
  } catch {
    // Nothing more can be done for the notice.
  }
}

function block(ctx: Ctx, machine: Machine, pid: string, step: { topic?: string; timer?: number }): void {
  const wait: NonNullable<Proc['wait']> = {};
  const payload = { machine: machine.id, pid };
  if (step.topic !== undefined) {
    wait.topic = step.topic;
    wait.waiter = ctx.subscribe(step.topic, RUN, payload);
  }
  if (step.timer !== undefined) wait.timer = ctx.schedule(Math.max(0, step.timer - ctx.now), RUN, payload);
  storeProc(machine, { ...getProc(machine, pid), wait });
}

function fdOf(machine: Machine, pid: string, n: number): Fd {
  const fd = getProc(machine, pid).fds[String(n)];
  if (!fd) throw new FsError('EBADF', 'fd', String(n));
  return fd;
}

const fail = (e: unknown): Step => ({ done: true, outcome: { error: e } });
const ok = (value: unknown): Step => ({ done: true, outcome: { value } });

function execute(ctx: Ctx, machine: Machine, pid: string, sc: PendingSyscall): Step {
  switch (sc.op) {
    case 'read': {
      let fd: Fd;
      try {
        fd = fdOf(machine, pid, sc.fd);
      } catch (e) {
        return fail(e);
      }
      return readFd(ctx, machine, pid, fd, sc);
    }
    case 'write': {
      let fd: Fd;
      try {
        fd = fdOf(machine, pid, sc.fd);
      } catch (e) {
        return fail(e);
      }
      return writeFd(ctx, machine, fd, sc);
    }
    case 'sleep': {
      sc.deadline ??= ctx.now + sc.ms;
      return ctx.now >= sc.deadline ? ok(undefined) : { done: false, timer: sc.deadline };
    }
    case 'wait': {
      if (sc.deadline === undefined) {
        sc.deadline = sc.timeout === undefined ? -1 : ctx.now + sc.timeout;
        return sc.deadline === -1 ? { done: false, topic: sc.topic } : { done: false, topic: sc.topic, timer: sc.deadline };
      }
      return ok(sc.deadline !== -1 && ctx.now >= sc.deadline ? 'timeout' : 'published');
    }
    case 'edit': {
      if (sc.session === undefined) {
        sc.session = openEditorSession(ctx, machine.id, pid, sc.request);
        return { done: false, topic: editorTopic(sc.session) };
      }
      const r = takeEditorResult(ctx, sc.session);
      return r ? ok(r) : { done: false, topic: editorTopic(sc.session) };
    }
    case 'waitpid': {
      const child = machine.procs[sc.pid];
      if (!child) return fail(new Error(`waitpid: no child ${sc.pid}`));
      if (child.state === 'zombie') return ok(reap(machine, sc.pid));
      return { done: false, topic: exitTopic(machine.id, sc.pid) };
    }
  }
}

function readFd(ctx: Ctx, machine: Machine, pid: string, fd: Fd, sc: PendingSyscall & { op: 'read' }): Step {
  const max = sc.max;
  const line = sc.line ?? false;
  switch (fd.kind) {
    case 'stream': {
      if (fd.end !== 'read') return fail(new FsError('EBADF', 'read', ''));
      const s = getStream(ctx, fd.stream);
      if (s.data === '') return s.writers > 0 ? { done: false, topic: streamTopic(s.id) } : ok(null);
      let n = s.data.length;
      if (line) {
        const nl = s.data.indexOf('\n');
        if (nl >= 0) n = nl + 1;
        else if (s.writers > 0 && s.data.length < s.capacity) return { done: false, topic: streamTopic(s.id) };
      }
      if (max !== undefined) n = Math.min(n, max);
      const out = s.data.slice(0, n);
      storeStream(ctx, { ...s, data: s.data.slice(n) });
      ctx.publish(streamTopic(s.id));
      return ok(out);
    }
    case 'tty': {
      const r = ttyRead(ctx, fd.tty, pid, max, sc.edit);
      return 'block' in r ? { done: false, topic: r.block } : ok(r.value);
    }
    case 'file': {
      const f = machine.files[fd.file];
      if (!f) return fail(new FsError('EBADF', 'read', ''));
      if (!f.read) return fail(new FsError('EBADF', 'read', ''));
      let data: string;
      try {
        data = readInode(ctx, machine, f.inode);
      } catch (e) {
        return fail(e);
      }
      if (f.offset >= data.length) return ok(null);
      let end = data.length;
      if (line) {
        const nl = data.indexOf('\n', f.offset);
        if (nl >= 0) end = nl + 1;
      }
      if (max !== undefined) end = Math.min(end, f.offset + max);
      put(machine.files, f.id, { ...f, offset: end });
      return ok(data.slice(f.offset, end));
    }
  }
}

function writeFd(ctx: Ctx, machine: Machine, fd: Fd, sc: PendingSyscall & { op: 'write' }): Step {
  switch (fd.kind) {
    case 'stream': {
      if (fd.end !== 'write') return fail(new FsError('EBADF', 'write', ''));
      const s = getStream(ctx, fd.stream);
      if (s.readers <= 0) return { signal: SIGPIPE };
      const done = sc.written ?? 0;
      const room = s.capacity - s.data.length;
      if (room <= 0) return { done: false, topic: streamTopic(s.id) };
      const chunk = sc.data.slice(done, done + room);
      storeStream(ctx, { ...s, data: s.data + chunk });
      ctx.publish(streamTopic(s.id));
      sc.written = done + chunk.length;
      return sc.written >= sc.data.length ? ok(undefined) : { done: false, topic: streamTopic(s.id) };
    }
    case 'tty':
      ttyWrite(ctx, fd.tty, sc.data);
      return ok(undefined);
    case 'file':
      try {
        fileWrite(ctx, machine, fd.file, sc.data);
      } catch (e) {
        return fail(e);
      }
      return ok(undefined);
  }
}

function fileWrite(ctx: Ctx, machine: Machine, fileId: string, data: string): void {
  const f = machine.files[fileId];
  if (!f || !f.write) throw new FsError('EBADF', 'write', '');
  const offset = writeInode(ctx, machine, f.inode, data, f.append ? 'append' : f.offset);
  put(machine.files, f.id, { ...f, offset: f.append ? f.offset : offset });
}

// ---- descriptors from programs ---------------------------------------------------------------

/** Opens an inode the VFS has checked and returns a new open file description's descriptor value. */
export function openFileFd(ctx: Ctx, machine: Machine, inode: string, flags: { read: boolean; write: boolean; append: boolean }): Fd {
  const f = createOpenFile(ctx, machine, { inode, offset: 0, ...flags });
  return { kind: 'file', file: f.id };
}

/** Installs `fd` as descriptor `n` of the process, closing what `n` held. */
export function installFd(ctx: Ctx, machineId: string, pid: string, n: number, fd: Fd | undefined): void {
  const machine = getMachine(ctx, machineId);
  const p = getProc(machine, pid);
  const old = p.fds[String(n)];
  if (fd) retain(ctx, machineId, fd);
  const fds = { ...p.fds };
  if (fd) fds[String(n)] = fd;
  else delete fds[String(n)];
  storeProc(machine, { ...p, fds });
  if (old) release(ctx, machineId, old);
}

export function updateProc(ctx: Ctx, machineId: string, pid: string, change: (p: Proc) => Proc): void {
  const machine = getMachine(ctx, machineId);
  storeProc(machine, change(getProc(machine, pid)));
}

// ---- fork and restore ---------------------------------------------------------------------------

/**
 * Called when a kernel is created over a world (SliceSpec.attach). Programs whose frames this
 * runtime does not hold are ended as if by SIGKILL, in machine and pid order, unless they are at a
 * restart point (`resume` set and the program can restart), which recreates them lazily (§3.4).
 */
export function attachProcesses(ctx: Ctx): void {
  const slice = hostSlice(ctx);
  const have = frames(ctx);
  for (const id of Object.keys(slice.machines).sort()) {
    const machine = slice.machines[id] as Machine;
    for (const pid of pidsOf(machine)) {
      const p = machine.procs[pid];
      if (!p || p.state !== 'running' || have.has(key(id, pid))) continue;
      if (p.resume !== undefined && program(ctx, p.image)?.restart) continue;
      exitProcess(ctx, machine, pid, { signal: SIGKILL });
    }
  }
}

export function runHandler(ctx: Ctx, payload: Json): void {
  const { machine, pid } = payload as { machine: string; pid: string };
  runProcess(ctx, machine, pid);
}

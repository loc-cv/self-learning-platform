// The `ProcApi` a program receives: a view of its own process record plus the syscall helpers.
// It holds the kernel context and ids only; every read goes to the world, so it never caches state.

import type { Ctx } from '@simlab/kernel';
import { getMachine, hostSlice } from '../machine.ts';
import { FsError } from '../vfs/errno.ts';
import { createFs } from '../vfs/fs.ts';
import { simNotice, SIM_STATUS } from './notice.ts';
import type { OpenRequest, ProcApi, Syscall } from './program.ts';
import {
  ExecImage,
  getProc,
  installFd,
  openFileFd,
  ProgramExit,
  setForeground,
  signalGroup,
  signalProcess,
  spawnProcess,
  updateProc,
} from './runtime.ts';
import { createFilledStream, createStream } from './descriptors.ts';
import type { ExitStatus, Fd } from './types.ts';

export function createProcApi(ctx: Ctx, machineId: string, pid: string): ProcApi {
  const proc = () => getProc(getMachine(ctx, machineId), pid);
  const lowestFree = (from = 0): number => {
    const fds = proc().fds;
    let n = from;
    while (fds[String(n)] !== undefined) n++;
    return n;
  };
  const openFd = (path: string, flags: OpenRequest): Fd => {
    const fs = api.fs();
    const ino = fs.open(path, flags);
    return openFileFd(ctx, fs.machine, ino, {
      read: flags.read ?? false,
      write: flags.write ?? false,
      append: flags.append ?? false,
    });
  };

  const api: ProcApi = {
    pid,
    machine: machineId,
    ctx,
    get argv() {
      return proc().argv;
    },
    get name() {
      const a0 = proc().argv[0] ?? proc().image;
      return a0.slice(a0.lastIndexOf('/') + 1).replace(/^-/, '');
    },
    get env() {
      return proc().env;
    },
    get cwd() {
      return proc().cwd;
    },
    get now() {
      return ctx.now;
    },
    get proc() {
      return proc();
    },
    get spawnData() {
      return proc().spawnData;
    },
    get cred() {
      const p = proc();
      return { uid: p.uid, gid: p.gid, groups: p.groups };
    },
    fs() {
      const p = proc();
      return createFs(ctx, machineId, { cred: api.cred, cwd: p.cwd, umask: p.umask });
    },
    random: (stream) => ctx.random(stream),
    trace(record) {
      ctx.trace(record);
    },

    *read(fd, opts = {}) {
      const sc: Syscall = { op: 'read', fd };
      if (opts.max !== undefined) sc.max = opts.max;
      if (opts.line) sc.line = true;
      return (yield sc) as string | null;
    },
    *write(fd, data) {
      if (data === '') return;
      yield { op: 'write', fd, data };
    },
    *sleep(ms) {
      yield { op: 'sleep', ms };
    },
    *wait(topic, timeout) {
      const sc: Syscall = timeout === undefined ? { op: 'wait', topic } : { op: 'wait', topic, timeout };
      return (yield sc) as 'published' | 'timeout';
    },
    *waitpid(child) {
      return (yield { op: 'waitpid', pid: child }) as ExitStatus;
    },
    *unsupported(gap) {
      const program = gap.program ?? api.name;
      ctx.gap({ kind: gap.kind, program, what: gap.what, commandLine: proc().argv.join(' '), machine: machineId });
      if (api.fd(2)) yield* api.write(2, simNotice(program, gap.what, gap.hints ?? []));
      throw new ProgramExit(SIM_STATUS);
    },

    spawn: (req) => spawnProcess(ctx, machineId, proc(), req),
    open(path, flags) {
      const fd = openFd(path, flags);
      const n = lowestFree();
      installFd(ctx, machineId, pid, n, fd);
      return n;
    },
    openAt(n, path, flags) {
      installFd(ctx, machineId, pid, n, openFd(path, flags));
    },
    close(n) {
      installFd(ctx, machineId, pid, n, undefined);
    },
    openData(n, data) {
      const s = createFilledStream(ctx, machineId, data);
      installFd(ctx, machineId, pid, n, { kind: 'stream', stream: s.id, end: 'read' });
    },
    dup2(from, to) {
      const fd = proc().fds[String(from)];
      if (!fd) throw new FsError('EBADF', 'dup2', String(from));
      if (from !== to) installFd(ctx, machineId, pid, to, fd);
    },
    pipe() {
      const s = createStream(ctx, machineId);
      const r = lowestFree();
      installFd(ctx, machineId, pid, r, { kind: 'stream', stream: s.id, end: 'read' });
      const w = lowestFree();
      installFd(ctx, machineId, pid, w, { kind: 'stream', stream: s.id, end: 'write' });
      return [r, w];
    },
    fd: (n) => proc().fds[String(n)],
    isatty: (n) => proc().fds[String(n)]?.kind === 'tty',
    winsize() {
      const t = proc().tty;
      const tty = t === undefined ? undefined : hostSlice(ctx).ttys[t];
      return tty ? { cols: tty.cols, rows: tty.rows } : undefined;
    },
    setForeground(pgid) {
      const t = proc().tty;
      if (t !== undefined) setForeground(ctx, t, pgid);
    },
    kill: (target, sig) => signalProcess(ctx, machineId, target, sig),
    killGroup: (pgid, sig) => signalGroup(ctx, machineId, pgid, sig),
    setCwd(path) {
      updateProc(ctx, machineId, pid, (p) => ({ ...p, cwd: path }));
    },
    setEnv(env) {
      updateProc(ctx, machineId, pid, (p) => ({ ...p, env: { ...env } }));
    },
    setUmask(mask) {
      updateProc(ctx, machineId, pid, (p) => ({ ...p, umask: mask & 0o777 }));
    },
    setResume(data) {
      updateProc(ctx, machineId, pid, (p) => {
        if (data !== undefined) return { ...p, resume: data };
        const { resume: _, ...rest } = p;
        return rest;
      });
    },
    trap(sig, disposition) {
      updateProc(ctx, machineId, pid, (p) => {
        const traps = { ...(p.traps ?? {}) };
        if (disposition === 'default') delete traps[String(sig)];
        else traps[String(sig)] = disposition;
        const { traps: _, ...rest } = p;
        return Object.keys(traps).length > 0 ? { ...rest, traps } : rest;
      });
    },
    exit(code) {
      throw new ProgramExit(code);
    },
    exec(req) {
      throw new ExecImage(req.program, req.argv, req.env, req.data);
    },
  };
  return api;
}

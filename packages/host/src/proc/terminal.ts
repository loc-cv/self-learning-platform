// Opening a terminal: a tty plus a login shell as its session leader, with descriptors 0, 1 and 2
// on the terminal. The `tty.open` input and test sessions both come here.

import { put, type Ctx } from '@simlab/kernel';
import { getMachine, hostSlice } from '../machine.ts';
import { credFor, userByName } from '../users.ts';
import { loginEnvironment } from './environment.ts';
import { spawnProcess } from './runtime.ts';
import type { Tty, TtyMode } from './types.ts';

export interface TerminalOptions {
  /** Terminal id; default `tty<n>` from a world counter. */
  id?: string;
  machine: string;
  user: string;
  cols?: number;
  rows?: number;
  /** Program of the session leader and its argv; default an interactive login bash (`-bash`). */
  program?: string;
  argv?: string[];
  /** Working directory; default the user's home. */
  cwd?: string;
  /** Terminal settings other than `stty sane`'s (a transcript session turns echo off). */
  mode?: Partial<TtyMode>;
}

export interface Terminal {
  tty: string;
  /** Pid of the session leader. */
  pid: string;
}

export function openTerminal(ctx: Ctx, opts: TerminalOptions): Terminal {
  const machine = getMachine(ctx, opts.machine);
  const user = userByName(ctx, machine.id, opts.user);
  if (!user) throw new Error(`machine ${machine.id}: no user ${opts.user}`);
  const id = opts.id ?? `tty${ctx.nextId('host.tty')}`;
  if (hostSlice(ctx).ttys[id]) throw new Error(`tty ${id} already exists`);
  const tty: Tty = {
    id,
    machine: machine.id,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    session: '',
    foreground: '',
    mode: { icanon: true, echo: true, isig: true, ...opts.mode },
    input: '',
    eof: [],
    line: '',
    typeahead: '',
    readline: { kill: '', lastSearch: '' },
  };
  put(hostSlice(ctx).ttys, id, tty);
  const fd = { kind: 'tty' as const, tty: id };
  const pid = spawnProcess(ctx, machine.id, undefined, {
    program: opts.program ?? 'bash',
    // login(1) and sshd start the shell with a leading dash in argv[0], which makes it a login shell.
    argv: opts.argv ?? ['-bash'],
    env: loginEnvironment(ctx, machine.id, user, { TERM: 'xterm-256color' }),
    cwd: opts.cwd ?? user.home,
    fds: { '0': fd, '1': fd, '2': fd },
    pgid: 'new',
    sid: 'new',
    cred: credFor(ctx, machine.id, user.name),
    // login.defs UMASK 022 applies to logins; pam_umask is not configured on a stock server.
    umask: 0o022,
    tty: id,
  });
  put(hostSlice(ctx).ttys, id, { ...tty, session: pid, foreground: pid });
  return { tty: id, pid };
}

// A terminal session driven headlessly: type a command line, let virtual time run until the shell
// is back at its prompt, collect what the terminal received. Transcripts, tests and the script
// mode of phase 03 use it. Time advances only as far as the command itself waits.

import { HOUR, type Kernel, type OutputRecord, type Ports, type World } from '@simlab/kernel';
import type { HostSlice } from '../machine.ts';
import { ttyTopic } from '../proc/descriptors.ts';
import { openTerminal } from '../proc/terminal.ts';

/** Collects terminal output per tty from the kernel's output port. */
export interface OutputCapture {
  readonly ports: Ports;
  /** Output received for `tty` since the last call, with CR LF turned back into LF. */
  take(tty: string): string;
}

export function captureOutput(): OutputCapture {
  const buffers = new Map<string, string>();
  return {
    ports: {
      output(r: OutputRecord) {
        buffers.set(r.tty, (buffers.get(r.tty) ?? '') + r.data);
      },
    },
    take(tty) {
      const s = buffers.get(tty) ?? '';
      buffers.set(tty, '');
      return s.replace(/\r\n/g, '\n');
    },
  };
}

export interface RunResult {
  output: string;
  status: number;
  /** False when the shell did not get back to its prompt within the timeout. */
  finished: boolean;
  /** True when the shell itself exited. */
  exited: boolean;
}

export interface Session {
  readonly kernel: Kernel;
  readonly machine: string;
  readonly tty: string;
  /** Pid of the shell. */
  readonly pid: string;
  /** Types `command` and a newline, then runs until the prompt returns (or `timeout` of virtual time). */
  run(command: string, opts?: { timeout?: number }): RunResult;
  /** Delivers raw bytes to the terminal (Ctrl-C is `\x03`), without waiting. */
  type(data: string): void;
  /** Output received since the last `run` or `take`. */
  take(): string;
}

export interface SessionOptions {
  machine: string;
  user: string;
  cols?: number;
  rows?: number;
  cwd?: string;
}

/** Opens a terminal with a login shell on `machine` and waits for its first prompt. */
export function openSession(kernel: Kernel, capture: OutputCapture, opts: SessionOptions): Session {
  const term = kernel.act('session.open', (ctx) =>
    openTerminal(ctx, {
      machine: opts.machine,
      user: opts.user,
      ...(opts.cols !== undefined ? { cols: opts.cols } : {}),
      ...(opts.rows !== undefined ? { rows: opts.rows } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    }),
  );
  const host = (w: World): HostSlice => w.slices['host'] as HostSlice;
  const proc = (w: World) => host(w).machines[opts.machine]?.procs[term.pid];
  const atPrompt = (w: World): boolean => {
    const p = proc(w);
    if (!p || p.state !== 'running') return true;
    return p.wait?.topic === ttyTopic(term.tty) && host(w).ttys[term.tty]?.input === '' && p.resume !== undefined;
  };
  const settle = (timeout: number): boolean => kernel.settle({ timeout, until: atPrompt }) === 'until' || atPrompt(kernel.world);
  settle(HOUR);
  capture.take(term.tty);

  return {
    kernel,
    machine: opts.machine,
    tty: term.tty,
    pid: term.pid,
    run(command, runOpts = {}) {
      kernel.input({ kind: 'tty.bytes', tty: term.tty, data: `${command}\n` });
      const finished = settle(runOpts.timeout ?? 24 * HOUR);
      const p = proc(kernel.world);
      const exited = !p || p.state !== 'running';
      let status = 0;
      if (p?.exit) status = 'code' in p.exit ? p.exit.code : 128 + p.exit.signal;
      else if (p?.resume && typeof p.resume === 'object' && !Array.isArray(p.resume)) status = Number((p.resume as { status?: number }).status ?? 0);
      return { output: capture.take(term.tty), status, finished, exited };
    },
    type(data) {
      kernel.input({ kind: 'tty.bytes', tty: term.tty, data });
    },
    take: () => capture.take(term.tty),
  };
}

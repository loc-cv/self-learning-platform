// A terminal session driven headlessly: type a command line, let virtual time run until the shell
// is back at its prompt, collect what the terminal received. Time advances only as far as the
// command itself waits.
//
// Two kinds. A plain session (transcripts, most tests) is set up the way the transcript capture
// sets up real bash (docs/TRANSCRIPTS.md): `--noediting`, echo off, empty PS1 and PS2, so the
// output is exactly what commands print. A terminal session is what a learner gets: the line
// editor, echo and the real prompt; script mode (`npm run sim`) and key-level tests use it.

import { HOUR, type Kernel, type OutputRecord, type Ports, type World } from '@simlab/kernel';
import type { HostSlice } from '../machine.ts';
import { ttyTopic } from '../proc/descriptors.ts';
import { openTerminal } from '../proc/terminal.ts';
import type { EditorRequest } from '../proc/editor.ts';

/** An editor request seen on the output port and not answered yet. */
export interface PendingEditor {
  session: string;
  tty?: string;
  request: EditorRequest;
}

/** Collects terminal output per tty, and editor requests, from the kernel's output port. */
export interface OutputCapture {
  readonly ports: Ports;
  /** Output received for `tty` since the last call, with CR LF turned back into LF. */
  take(tty: string): string;
  /** Output received for `tty` since the last call, as the terminal received it. */
  takeRaw(tty: string): string;
  /** Editor requests not answered yet, oldest first; the caller removes what it answers. */
  readonly editors: PendingEditor[];
  /** Messages about saves (`editor.status`) that failed. */
  readonly editorErrors: string[];
}

export function captureOutput(): OutputCapture {
  const buffers = new Map<string, string>();
  const editors: PendingEditor[] = [];
  const editorErrors: string[] = [];
  const takeRaw = (tty: string): string => {
    const s = buffers.get(tty) ?? '';
    buffers.set(tty, '');
    return s;
  };
  return {
    ports: {
      output(r: OutputRecord) {
        if (r.kind === 'tty') buffers.set(r.tty, (buffers.get(r.tty) ?? '') + r.data);
        else if (r.kind === 'editor.open') {
          const e: PendingEditor = { session: r.session, request: r.request as unknown as EditorRequest };
          if (r.tty !== undefined) e.tty = r.tty;
          editors.push(e);
        } else if (!r.ok) editorErrors.push(r.message ?? 'save failed');
      },
    },
    take: (tty) => takeRaw(tty).replace(/\r\n/g, '\n'),
    takeRaw,
    editors,
    editorErrors,
  };
}

/**
 * Answers an editor request headlessly: the new content to save, or undefined to close without
 * saving (as `:q!` would).
 */
export type EditorAnswer = (req: EditorRequest) => string | undefined;

export interface RunResult {
  output: string;
  status: number;
  /** False when the shell did not get back to its prompt within the timeout. */
  finished: boolean;
  /** True when the shell itself exited. */
  exited: boolean;
  /** The shell waits for the rest of a command (an open quote, a here-document): PS2, not PS1. */
  continuation: boolean;
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
  /** Output received since the last `run` or `take` (CR LF as LF). */
  take(): string;
  /** Output received since the last call, exactly as the terminal received it. */
  takeRaw(): string;
  /** Runs virtual time until the shell is back at its prompt, at most `timeout`. Returns whether it is. */
  wait(timeout: number): boolean;
  /** How editor requests are answered; by default they close without saving. */
  onEditor(answer: EditorAnswer): void;
}

export interface SessionOptions {
  machine: string;
  user: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  /** A learner's terminal (line editing, echo, prompt) instead of a plain transcript session. */
  terminal?: boolean;
  /** Terminal id; default from the world counter. */
  tty?: string;
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
      ...(opts.tty !== undefined ? { id: opts.tty } : {}),
      ...(opts.terminal ? {} : { argv: ['-bash', '--noediting'], mode: { echo: false } }),
    }),
  );
  const host = (w: World): HostSlice => w.slices['host'] as HostSlice;
  const proc = (w: World) => host(w).machines[opts.machine]?.procs[term.pid];
  const atPrompt = (w: World): boolean => {
    const p = proc(w);
    if (!p || p.state !== 'running') return true;
    const t = host(w).ttys[term.tty];
    // The shell itself waits for terminal input: at its prompt, or at PS2 inside a command.
    if (!t || p.wait?.topic !== ttyTopic(term.tty)) return false;
    if (t.input !== '' || t.typeahead !== '' || t.line !== '') return false;
    if (opts.terminal) return t.editor !== undefined && t.editor.pid === term.pid && !t.editor.done && t.editor.keys === '';
    return true;
  };
  let answer: EditorAnswer = () => undefined;
  const mine = (e: PendingEditor): boolean => e.tty === term.tty;
  /** Runs until the prompt returns; an editor request on this terminal is answered on the way. */
  const settle = (timeout: number): boolean => {
    const end = kernel.now + timeout;
    for (;;) {
      const r = kernel.settle({ timeout: Math.max(0, end - kernel.now), until: (w) => atPrompt(w) || capture.editors.some(mine) });
      const i = capture.editors.findIndex(mine);
      if (i >= 0) {
        const e = capture.editors.splice(i, 1)[0] as PendingEditor;
        const content = answer(e.request);
        if (content !== undefined) kernel.input({ kind: 'editor.save', session: e.session, content });
        kernel.input({ kind: 'editor.close', session: e.session });
        continue;
      }
      return r === 'until' || atPrompt(kernel.world);
    }
  };
  settle(HOUR);
  if (!opts.terminal) {
    // The transcript capture's setup line (tools/src/transcript/pty_capture.py), less what the
    // terminal settings above already did.
    kernel.input({ kind: 'tty.bytes', tty: term.tty, data: 'PS1=; PS2=\n' });
    settle(HOUR);
    capture.take(term.tty);
  }
  // Transcripts show notices as text; the terminal style is tested where it is made (notice.ts).
  const take = (): string => {
    const out = capture.take(term.tty);
    return opts.terminal ? out : unstyleNotices(out);
  };

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
      const continuation = !exited && finished && p?.resume === undefined;
      return { output: take(), status, finished, exited, continuation };
    },
    type(data) {
      kernel.input({ kind: 'tty.bytes', tty: term.tty, data });
    },
    take,
    takeRaw: () => capture.takeRaw(term.tty),
    wait: settle,
    onEditor(a) {
      answer = a;
    },
  };
}

/** Removes the terminal style of `[sim]` notice lines (proc/notice.ts styleNotice). */
export function unstyleNotices(text: string): string {
  // eslint-disable-next-line no-control-regex -- the escape sequences are exactly what is removed
  return text.replace(/\x1b\[33m(\[sim\] [^\n]*?)\x1b\[0m/g, '$1');
}

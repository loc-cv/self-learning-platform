// The shells that scenario steps and checks type into (docs/SCENARIO_FORMAT.md §6.2, §7.1). A
// step list keeps one login per machine and user, so `cd`, variables and files persist from step
// to step; the logins end with the list. Each is a plain session (no line editor, no echo, empty
// prompts), so what a command prints is exactly its output. Setup shells are separate logins
// from the learner's terminal, which opens after setup: nothing typed here reaches the learner's
// history.

import { HOUR, type Kernel, type StepSession } from '@simlab/kernel';
import type { EditorRequest } from '../proc/editor.ts';
import { userByName } from '../users.ts';
import { captureOutput, openSession, type RunResult, type Session } from '../transcript/session.ts';

/** How long one command line may run before the step gives up. */
export const STEP_COMMAND_TIMEOUT = HOUR;

/** One editor operation (§6.3): `replace` the first occurrence of `from`, or `write` the whole buffer. */
export type EditorOp = { replace: { from: string; to: string } } | { write: string };

/** Where a step or check without `on`/`as` acts: the entry user on the entry machine, root elsewhere. */
export function stepTarget(session: StepSession, on: string | undefined, as: string | undefined): { machine: string; user: string } {
  const machine = on ?? session.entry.machine;
  const user = as ?? (machine === session.entry.machine ? session.entry.user : 'root');
  return { machine, user };
}

interface Login {
  session: Session;
  /** Answers the next editor request; set for the duration of one command. */
  editor: ((req: EditorRequest) => string | undefined) | undefined;
}

/**
 * The shell of `user` on `machine` for this step list, opened on first use. `pool` separates
 * logins that must not share state (the `apply` step's shell is not a `run` step's).
 */
export function stepShell(kernel: Kernel, session: StepSession, machine: string, user: string, pool = 'host.run'): Login {
  const logins = session.local(`host.shells:${pool}`, () => {
    const map = new Map<string, Login>();
    session.onEnd(() => {
      for (const login of map.values()) logout(kernel, login.session);
      map.clear();
    });
    return map;
  });
  const key = `${machine}\u0000${user}`;
  let login = logins.get(key);
  if (login) return login;
  const host = kernel.world.slices['host'] as { machines: Record<string, unknown> };
  if (!(machine in host.machines)) throw new Error(`there is no machine ${machine}`);
  if (kernel.act('step.user', (ctx) => userByName(ctx, machine, user)) === undefined) throw new Error(`machine ${machine} has no user ${user}`);
  const capture = captureOutput();
  session.listen(capture.ports);
  const opened = openSession(kernel, capture, { machine, user });
  const created: Login = { session: opened, editor: undefined };
  // Outside runLine nothing answers, and the editor closes without saving.
  opened.onEditor((req) => created.editor?.(req));
  logins.set(key, created);
  login = created;
  return login;
}

/** Ends a login: `exit`, then the terminal goes away, as when a person closes the window. */
function logout(kernel: Kernel, s: Session): void {
  s.run('exit', { timeout: 10_000 });
  kernel.input({ kind: 'tty.close', tty: s.tty });
  kernel.runUntil(kernel.now);
}

/** Applies editor operations to the content the editor opened with (§6.3). */
export function applyEditorOps(content: string, ops: readonly EditorOp[]): string {
  let out = content;
  for (const op of ops) {
    if ('write' in op) out = op.write;
    else {
      const i = out.indexOf(op.replace.from);
      if (i < 0) throw new Error(`editor: ${JSON.stringify(op.replace.from)} is not in the buffer`);
      out = out.slice(0, i) + op.replace.to + out.slice(i + op.replace.from.length);
    }
  }
  return out;
}

/**
 * Types one command line into the login and waits for it. With `editor`, the first editor the
 * command opens gets the operations; a second one (kubectl edit reopening after an error) fails.
 * Without it, any editor fails the command.
 */
export function runLine(login: Login, line: string, editor?: readonly EditorOp[]): RunResult {
  let opened = 0;
  let failure: Error | undefined;
  login.editor = (req) => {
    opened++;
    if (!editor) failure = new Error(`${req.name}: the command opened an editor and the step has no \`editor\` answer`);
    else if (opened > 1) failure = new Error(`${req.name}: the editor opened again after the edit (the command rejected it)`);
    else {
      try {
        return applyEditorOps(req.content, editor);
      } catch (e) {
        failure = e as Error;
      }
    }
    return undefined;
  };
  try {
    const r = login.session.run(line, { timeout: STEP_COMMAND_TIMEOUT });
    if (failure) throw failure;
    if (editor && opened === 0) throw new Error('the step has an `editor` answer but the command opened no editor');
    if (!r.finished) throw new Error(`still running after ${STEP_COMMAND_TIMEOUT / HOUR} h of virtual time`);
    if (r.exited) throw new Error('the shell exited');
    return r;
  } finally {
    login.editor = undefined;
  }
}

/** The last lines of a command's output, for an error message. */
export function tail(output: string, lines = 12): string {
  const all = output.replace(/\n$/, '').split('\n');
  const shown = all.slice(-lines).join('\n');
  return all.length > lines ? `…\n${shown}` : shown;
}

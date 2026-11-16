// `kubectl __complete` / `__completeNoDesc`, cobra's hidden completion command, run as a process
// (the bash script calls it on every Tab) or answered directly for the completer.
//   upstream: vendor/github.com/spf13/cobra/completions.go initCompleteCmd (MinimumNArgs(1),
//             DisableFlagParsing: the words after it are the command line to complete)

import type { Op, ProcApi } from '@simlab/host';
import { klogLine } from '../client/session.ts';
import { newClient, type ClientEnv } from './client.ts';
import { completeOutput, getCompletions } from './cobra.ts';
import { kubectlRegistrations } from './functions.ts';

/** `kubectl __complete <args…>` as the process described by `e` runs it: its stdout and stderr. */
export function runComplete(e: ClientEnv, args: readonly string[], noDesc: boolean): { stdout: string; stderr: string } {
  const reg = kubectlRegistrations((values) => newClient(e, values));
  return completeOutput(getCompletions(args, reg), noDesc, e.env);
}

/** The hidden command itself. */
export function* completeCommand(p: ProcApi, args: readonly string[], noDesc: boolean): Op<number> {
  if (args.length === 0) {
    // upstream: cobra args.go MinimumNArgs; kubectl's CheckErr
    yield* p.write(2, 'error: requires at least 1 arg(s), only received 0\n');
    return 1;
  }
  let klog = '';
  const out = runComplete({ ctx: p.ctx, machine: p.machine, fs: p.fs(), env: p.env, klog: (file, text) => (klog += klogLine(p, 'E', file, text)) }, args, noDesc);
  yield* p.write(1, out.stdout);
  yield* p.write(2, klog + out.stderr);
  return 0;
}

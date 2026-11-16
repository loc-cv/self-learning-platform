// The kubectl program (docs/ARCHITECTURE.md §4, `PLAN.md` §7 Programs): the command framework
// (cli/command.ts) with the simulated verbs. A verb is one module under cmd/.

import type { ProcApi, ProgramSpec, Syscall } from '@simlab/host';
import { dispatch, type Dispatch, type Verb } from './cli/command.ts';
import { getVerb } from './cmd/get.ts';
import { helpCommands, helpOutput } from './cmd/help.ts';

/** The verbs the simulator implements; every other command of the manifest prints a notice. */
export const VERBS: readonly Verb[] = [getVerb];

/**
 * Global flags the simulator honors, and those on the no-effect list (docs/FIDELITY.md §4.1) with
 * the reason each has no observable effect here.
 */
const GLOBALS: Dispatch['globals'] = {
  kubeconfig: {},
  context: {},
  cluster: {},
  user: {},
  namespace: {},
  server: {},
  'request-timeout': { reason: 'requests are answered in the same instant of virtual time, so no timeout can expire' },
  'cache-dir': { reason: 'the discovery cache is not modeled; discovery is answered from the server each time with the same result' },
  'log-flush-frequency': { reason: 'kubectl writes its logs unbuffered here; the output is the same' },
};

const DISPATCH: Dispatch = {
  verbs: VERBS,
  globals: GLOBALS,
  help: (p, path) => helpOutput(p, path),
  helpCommands: (p, path, args) => helpCommands(p, path, args),
  *unsupported(p, kind, what) {
    return yield* p.unsupported({ kind, what });
  },
  *fail(p, text) {
    yield* p.write(2, text.endsWith('\n') ? text : `${text}\n`);
    return 1;
  },
};

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  return yield* dispatch(p, DISPATCH);
}

export const kubectlProgram: ProgramSpec = { name: 'kubectl', main };

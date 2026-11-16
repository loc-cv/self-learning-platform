// kubectl's tab completion (phase 08): what cobra's `kubectl __complete` answers (cobra.ts over
// the manifest, kubectl's completion functions in functions.ts, lookups in client.ts), and what
// the bash script that `kubectl completion bash` prints makes of it on each Tab (bash.ts).
// The shell runs the completer as the documented setup would (source <(kubectl completion bash),
// complete -o default -F __start_kubectl k for `alias k=kubectl`): see shell/complete.ts.

import type { ProvenanceSpec } from '@simlab/kernel';
import { createFs, hostSlice, type CompletionResult, type ProgramCompletion } from '@simlab/host';
import type { Verb } from '../cli/command.ts';
import { bashComplete } from './bash.ts';
import type { ClientEnv } from './client.ts';
import { runComplete } from './run.ts';
import { completionVerb, COMPLETION_SCRIPT_PROVENANCE } from './script.ts';

export { completeCommand, runComplete } from './run.ts';

/** `kubectl completion` (for the lead to add to VERBS). */
export const COMPLETION_VERBS: readonly Verb[] = [completionVerb];

/** The completer of the kubectl program: bash running kubectl's completion script. */
export function completeKubectl(c: ProgramCompletion): CompletionResult | undefined {
  const proc = hostSlice(c.ctx).machines[c.machine]?.procs[c.pid];
  if (!proc) return undefined;
  const env = { ...(c.env ?? proc.env) };
  const fs = createFs(c.ctx, c.machine, { cred: { uid: proc.uid, gid: proc.gid, groups: proc.groups }, cwd: proc.cwd, umask: proc.umask });
  const e: ClientEnv = { ctx: c.ctx, machine: c.machine, fs, env };
  return bashComplete({ c, fs, home: env['HOME'], run: (args) => runComplete(e, args, false).stdout });
}

const G = 'fixtures/golden/v1.37.2/completion';
const COBRA = 'vendor/github.com/spf13/cobra';

export const COMPLETION_PROVENANCE: ProvenanceSpec[] = [
  {
    name: 'kubectl.complete.candidates',
    tag: 'golden-verified',
    sources: [
      `${G}/complete.yaml`,
      `${G}/commands.yaml`,
      `${G}/flags.yaml`,
      `${COBRA}/completions.go getCompletions, initCompleteCmd`,
      'staging/src/k8s.io/kubectl/pkg/util/completion/completion.go',
    ],
    note: '`kubectl __complete`: commands with their Short, flag names with their usage, resource types, names, flag values, then `:<directive>`',
  },
  {
    name: 'kubectl.complete.debug',
    tag: 'golden-verified',
    sources: [`${G}/complete.yaml`, `${COBRA}/completions.go initCompleteCmd, CompErrorln, ShellCompDirective.string`, 'staging/src/k8s.io/kubectl/pkg/cmd/plugin/plugin_completion.go SetupPluginCompletion'],
    note: 'standard error of __complete: `[Debug] …` lines and `Completion ended with directive: …`',
  },
  {
    name: 'kubectl.complete.bash',
    tag: 'source-derived',
    sources: [
      `${COBRA}/bash_completionsV2.go`,
      'bash-completion 2.11 _filedir, _get_comp_words_by_ref (/usr/share/bash-completion/bash_completion)',
      'bash 5.2.21 printf %q, programmable completion (-o default)',
      'fixtures/reference/bash/kubectl-completion.json',
    ],
    note: 'what Tab inserts and lists: descriptions padded and cut to COLUMNS, a single match escaped, -f filtered to json/yaml/yml and directories, file names otherwise',
  },
  ...COMPLETION_SCRIPT_PROVENANCE,
];

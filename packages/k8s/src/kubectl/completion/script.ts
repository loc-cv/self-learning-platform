// `kubectl completion SHELL`: the shell completion script. bash's is kubectl's boilerplate and
// cobra's bash completion V2 script with descriptions; the other shells print a notice.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/completion/completion.go RunCompletion (the
//             usage errors), runCompletionBash (defaultBoilerPlate, then GenBashCompletionV2(out,
//             true)), completionShells
//   upstream: vendor/github.com/spf13/cobra/bash_completionsV2.go genBashComp (the template, in
//             template.ts; compCmd is ShellCompRequestCmd `__complete` with descriptions)
//   upstream: vendor/github.com/spf13/cobra/completions.go ShellCompDirective values;
//             active_help.go activeHelpMarker "_activeHelp_ "

import type { ProvenanceSpec } from '@simlab/kernel';
import type { Invocation, Op, Verb } from '../cli/command.ts';
import { fail } from '../client/session.ts';
import { goQuote } from '../cli/flagset.ts';
import { usageError } from '../cmd/helpers.ts';
import { DIRECTIVE } from './cobra.ts';
import { BASH_COMPLETION_V2_TEMPLATE } from './template.ts';

const DEFAULT_BOILERPLATE = `
# Copyright 2016 The Kubernetes Authors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
`;

/** Go's fmt.Sprintf over the template's verbs: %[n]s, %[n]d, %-36[1]s and %%. */
function sprintf(template: string, args: readonly (string | number)[]): string {
  return template.replace(/%(-?\d*)\[(\d+)\]([sd])|%%/g, (m, width: string | undefined, n: string | undefined) => {
    if (m === '%%') return '%';
    const v = String(args[Number(n) - 1]);
    const w = Number(width ?? '');
    if (!width || Number.isNaN(w)) return v;
    return w < 0 ? v.padEnd(-w) : v.padStart(w);
  });
}

/** genBashComp(buf, "kubectl", includeDesc=true) */
export function bashCompletionScript(name = 'kubectl'): string {
  return sprintf(BASH_COMPLETION_V2_TEMPLATE, [
    name,
    '__complete',
    DIRECTIVE.error,
    DIRECTIVE.noSpace,
    DIRECTIVE.noFileComp,
    DIRECTIVE.filterFileExt,
    DIRECTIVE.filterDirs,
    DIRECTIVE.keepOrder,
    '_activeHelp_ ',
  ]);
}

const SHELLS = ['bash', 'zsh', 'fish', 'powershell'];

function* run(inv: Invocation): Op<number> {
  const { p, args } = inv;
  if (args.length === 0) return yield* fail(p, usageError('completion', 'Shell not specified.'));
  if (args.length > 1) return yield* fail(p, usageError('completion', 'Too many arguments. Expected only the shell type.'));
  const shell = args[0] as string;
  if (!SHELLS.includes(shell)) return yield* fail(p, usageError('completion', `Unsupported shell type ${goQuote(shell)}.`));
  if (shell !== 'bash') return yield* p.unsupported({ kind: 'subcommand', what: `the completion script for ${shell}` });
  yield* p.write(1, DEFAULT_BOILERPLATE + bashCompletionScript());
  return 0;
}

export const completionVerb: Verb = { path: 'completion', flags: [], run };

export const COMPLETION_SCRIPT_PROVENANCE: ProvenanceSpec[] = [
  {
    name: 'kubectl.completion.script',
    tag: 'golden-verified',
    sources: [
      'fixtures/golden/v1.37.2/completion/script.yaml',
      'staging/src/k8s.io/kubectl/pkg/cmd/completion/completion.go runCompletionBash, RunCompletion',
      'vendor/github.com/spf13/cobra/bash_completionsV2.go genBashComp',
    ],
    note: 'the bash script and the usage errors; zsh, fish and powershell print a notice',
  },
];

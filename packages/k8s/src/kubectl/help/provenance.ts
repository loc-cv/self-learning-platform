// Provenance of kubectl's help output (docs/FIDELITY.md §3).

import type { ProvenanceSpec } from '@simlab/kernel';

const MANIFEST = 'fixtures/golden/v1.37.2/kubectl-commands.json (npm run golden:kubectl-manifest -- --check renders every command against the binary, piped and at 79/80/100/120 columns)';

export const HELP_PROVENANCE: ProvenanceSpec[] = [
  {
    name: 'kubectl.help.text',
    tag: 'golden-verified',
    sources: [
      'fixtures/golden/v1.37.2/client/help.yaml',
      'fixtures/golden/v1.37.2/client/help-more.yaml',
      MANIFEST,
      'staging/src/k8s.io/kubectl/pkg/util/templates/templates.go MainHelpTemplate, MainUsageTemplate',
      'staging/src/k8s.io/kubectl/pkg/util/templates/templater.go, help_flags_printer.go',
    ],
    note: 'Every command\'s help: description, aliases, examples, command list, options, usage line, hints.',
  },
  {
    name: 'kubectl.help.wrap',
    tag: 'golden-verified',
    sources: [
      'fixtures/golden/v1.37.2/client/help.yaml',
      'fixtures/golden/v1.37.2/client/help-more.yaml',
      'staging/src/k8s.io/kubectl/pkg/util/term/term_writer.go getTerminalLimitWidth, wordWrapWriter',
      'vendor/github.com/mitchellh/go-wordwrap/wordwrap.go WrapString',
    ],
    note: 'Wrapping at 80, 100 or 120 columns on a terminal, per template write; flag usages at the limit of standard output minus 10.',
  },
  {
    name: 'kubectl.options',
    tag: 'golden-verified',
    sources: ['fixtures/golden/v1.37.2/client/help.yaml', 'fixtures/golden/v1.37.2/client/help-more.yaml', 'staging/src/k8s.io/kubectl/pkg/util/templates/templates.go OptionsUsageTemplate', 'staging/src/k8s.io/kubectl/pkg/cmd/options/options.go'],
  },
  {
    name: 'kubectl.help.topic',
    tag: 'golden-verified',
    sources: ['fixtures/golden/v1.37.2/client/help-more.yaml', 'vendor/github.com/spf13/cobra/command.go InitDefaultHelpCmd, Find'],
    note: '`kubectl help <words>` and its "Unknown help topic" with kubectl\'s usage on standard error.',
  },
  {
    name: 'kubectl.help.group-run',
    tag: 'golden-verified',
    sources: ['fixtures/golden/v1.37.2/client/help-more.yaml', 'staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go DefaultSubCommandRun, RequireNoArguments, UsageErrorf'],
    note: 'A command group run without a subcommand: its help on standard error (or standard output for rollout, certificate and kubectl itself) and the exit status; extra words are "unknown command".',
  },
];

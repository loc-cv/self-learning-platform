// Provenance of kubectl's own output units (docs/FIDELITY.md §3): the command framework's errors,
// the client's configuration and connection errors, and get's messages and generic printers.
// Printers of tables, YAML/JSON and help register theirs next to their code.
//
// A unit is golden-verified only when the differential runner (tools/src/golden/kubectl/, in the
// gate as tools/src/golden/kubectl.test.ts) or another test compares it with a committed fixture.

import type { ProvenanceSpec } from '@simlab/kernel';

const G = 'fixtures/golden/v1.37.2';

export const KUBECTL_PROVENANCE: ProvenanceSpec[] = [
  {
    name: 'kubectl.cli.unknown-command',
    tag: 'golden-verified',
    sources: [`${G}/client/help.yaml`, 'vendor/github.com/spf13/cobra/args.go legacyArgs', 'vendor/github.com/spf13/cobra/command.go findSuggestions'],
  },
  {
    name: 'kubectl.cli.flag-errors',
    tag: 'golden-verified',
    sources: [
      `${G}/client/help.yaml`,
      'vendor/github.com/spf13/pflag/errors.go',
      'vendor/github.com/spf13/pflag/flag.go parseLongArg, parseSingleShortArg',
      'staging/src/k8s.io/kubectl/pkg/util/templates/templater.go FlagErrorFunc',
    ],
    note: 'other texts checked against the real kubectl binary on the workstation (packages/k8s/src/kubectl/cli/flagset.test.ts)',
  },
  {
    name: 'kubectl.cli.deprecated-flag',
    tag: 'source-derived',
    sources: ['vendor/github.com/spf13/pflag/flag.go FlagSet.Set'],
  },
  {
    name: 'kubectl.errors.check-err',
    tag: 'golden-verified',
    sources: [`${G}/errors/not-found.yaml`, 'staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go checkErr, StandardErrorMessage, MultilineError'],
  },
  {
    name: 'kubectl.errors.no-resource-match',
    tag: 'golden-verified',
    sources: [`${G}/errors/not-found.yaml`, 'staging/src/k8s.io/cli-runtime/pkg/resource/builder.go mappingFor'],
  },
  {
    name: 'kubectl.config.errors',
    tag: 'golden-verified',
    sources: [
      `${G}/client/kubectl-errors.yaml`,
      'staging/src/k8s.io/client-go/tools/clientcmd/client_config.go ConfirmUsable, getContext, getAuthInfo, getCluster',
      'staging/src/k8s.io/client-go/tools/clientcmd/validation.go',
      'staging/src/k8s.io/client-go/tools/clientcmd/loader.go Load',
    ],
    note: 'texts checked against the real kubectl binary on the workstation (packages/k8s/src/kubectl/client/kubeconfig.test.ts)',
  },
  {
    name: 'kubectl.connection.refused',
    tag: 'golden-verified',
    sources: [`${G}/client/no-server.yaml`, 'staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go StandardErrorMessage (*url.Error)'],
  },
  {
    name: 'kubectl.resource.builder-errors',
    tag: 'golden-verified',
    sources: [
      `${G}/client/kubectl-errors.yaml`,'staging/src/k8s.io/cli-runtime/pkg/resource/builder.go'],
    note: 'texts checked against the real kubectl binary on the workstation (packages/k8s/src/kubectl/resource/builder.test.ts)',
  },
  {
    name: 'kubectl.get.no-resources',
    tag: 'golden-verified',
    sources: [`${G}/errors/not-found.yaml`, 'staging/src/k8s.io/kubectl/pkg/cmd/get/get.go Run'],
  },
  {
    name: 'kubectl.get.usage-errors',
    tag: 'golden-verified',
    sources: [
      `${G}/client/kubectl-errors.yaml`,'staging/src/k8s.io/kubectl/pkg/cmd/get/get.go Complete, Validate', 'staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go UsageErrorf'],
  },
  {
    name: 'kubectl.get.output-format-error',
    tag: 'golden-verified',
    sources: [`${G}/errors/validation.yaml`, 'staging/src/k8s.io/kubectl/pkg/cmd/get/get_flags.go AllowedFormats'],
  },
  {
    name: 'kubectl.get.name',
    tag: 'golden-verified',
    sources: [`${G}/namespaces/create-and-read.yaml`, `${G}/pods/run.yaml`, 'staging/src/k8s.io/cli-runtime/pkg/printers/name.go'],
  },
  {
    name: 'kubectl.get.watch',
    tag: 'source-derived',
    sources: ['staging/src/k8s.io/kubectl/pkg/cmd/get/get.go watch', 'staging/src/k8s.io/kubectl/pkg/util/interrupt/interrupt.go'],
    note: 'watch output is not captured by the oracle (docs/FIDELITY.md §6.9)',
  },
  {
    name: 'kubectl.get.list-errors',
    tag: 'golden-verified',
    sources: [`${G}/errors/not-found.yaml`, 'staging/src/k8s.io/cli-runtime/pkg/resource/helper.go EnhanceListError'],
  },
  {
    name: 'kubectl.warnings',
    tag: 'source-derived',
    sources: ['staging/src/k8s.io/client-go/rest/warnings.go WarningWriter'],
  },
];

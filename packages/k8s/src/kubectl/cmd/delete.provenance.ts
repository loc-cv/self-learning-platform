// Provenance of kubectl delete's output units (docs/FIDELITY.md §3).

import type { ProvenanceSpec } from '@simlab/kernel';

const G = 'fixtures/golden/v1.37.2';
const DELETE = 'staging/src/k8s.io/kubectl/pkg/cmd/delete/delete.go';

export const DELETE_PROVENANCE: ProvenanceSpec[] = [
  {
    name: 'kubectl.delete.output',
    tag: 'golden-verified',
    sources: [`${G}/delete/cascade.yaml`, `${G}/delete/options.yaml`, `${G}/delete/errors.yaml`, `${DELETE} PrintObj, DeleteResult`],
    note: '`<kind>[.<group>] "<name>" [force ]deleted[ from <ns> namespace][ (dry run)| (server dry run)]`, -o name, "No resources found"',
  },
  {
    name: 'kubectl.delete.errors',
    tag: 'golden-verified',
    sources: [
      `${G}/delete/errors.yaml`,
      `${DELETE} Complete, Validate`,
      'staging/src/k8s.io/kubectl/pkg/cmd/delete/delete_flags.go parseCascadingFlag',
      'staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go GetDryRunStrategy',
      'staging/src/k8s.io/cli-runtime/pkg/resource/builder.go SelectAllParam, visitorResult, visitBySelector',
    ],
  },
  {
    name: 'kubectl.delete.warnings',
    tag: 'golden-verified',
    sources: [
      `${G}/delete/options.yaml`,
      `${G}/delete/errors.yaml`,
      `${G}/delete/cascade.yaml`,
      `${DELETE} Validate (forced deletion), DeleteResult (cluster scope)`,
      'staging/src/k8s.io/kubectl/pkg/cmd/delete/delete_flags.go parseCascadingFlag',
      'staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go GetDryRunStrategy (klog)',
      'staging/src/k8s.io/cli-runtime/pkg/printers/warningprinter.go Print',
    ],
    note: 'the yellow Warning: on a terminal is source-derived (terminal.go AllowsColorOutput); captures are piped',
  },
  {
    name: 'kubectl.delete.wait',
    tag: 'golden-verified',
    sources: [
      `${G}/delete/options.yaml`,
      'staging/src/k8s.io/kubectl/pkg/cmd/wait/delete.go IsDeleted',
      'staging/src/k8s.io/kubectl/pkg/cmd/wait/condition.go extendErrWaitTimeout',
      'staging/src/k8s.io/apimachinery/pkg/util/wait/error.go errInterrupted.Error',
    ],
    note: 'the timeout error; how long kubectl waits is the simulated kubelet and garbage collector (packages/k8s/src/kubectl/cmd/delete.wait.test.ts)',
  },
];

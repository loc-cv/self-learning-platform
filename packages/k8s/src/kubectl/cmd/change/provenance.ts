// Provenance of the output units of scale, set image, label, annotate and edit, and of the scale
// subresource's writes in the API server (docs/FIDELITY.md §3). The golden-verified units are
// compared by the differential runner in the gate (tools/src/golden/kubectl.test.ts and, for the
// raw API, tools/src/golden/api.test.ts).

import type { ProvenanceSpec } from '@simlab/kernel';

const G = 'fixtures/golden/v1.37.2/change';
const K = 'staging/src/k8s.io/kubectl/pkg/cmd';

export const PROVENANCE: ProvenanceSpec[] = [
  {
    name: 'apiserver.scale.write',
    tag: 'golden-verified',
    sources: [`${G}/scale-subresource.yaml`, 'pkg/registry/apps/deployment/storage/storage.go ScaleREST.Update, scaleUpdatedObjectInfo', 'pkg/apis/autoscaling/validation/validation.go ValidateScale'],
    note: 'update and patch of deployments/scale and replicasets/scale: the Scale answered, Invalid on Scale.autoscaling, the conflicts, NotFound',
  },
  {
    name: 'kubectl.scale.output',
    tag: 'golden-verified',
    sources: [`${G}/scale.yaml`, `${K}/scale/scale.go RunScale`],
    note: '`<kind>.<group>/<name> scaled[ (dry run)| (server dry run)]`, -o name and yaml',
  },
  {
    name: 'kubectl.scale.errors',
    tag: 'golden-verified',
    sources: [`${G}/scale.yaml`, `${K}/scale/scale.go Validate, RunScale`, 'staging/src/k8s.io/kubectl/pkg/scale/scale.go PreconditionError', 'vendor/github.com/spf13/cobra/command.go validateRequiredFlags'],
  },
  {
    name: 'kubectl.scale.wait',
    tag: 'source-derived',
    sources: ['staging/src/k8s.io/kubectl/pkg/scale/scale.go WaitForScaleHasDesiredReplicas, scaleHasDesiredReplicas'],
    note: '`timed out waiting for "<name>" to be synced`; the wait itself in virtual time (cmd/change/scale.wait.test.ts)',
  },
  {
    name: 'kubectl.set.image.output',
    tag: 'golden-verified',
    sources: [`${G}/set-image.yaml`, `${K}/set/set_image.go Run`],
    note: '`image updated` lines, nothing for an unchanged image, typed objects for -o yaml|json (struct order in JSON)',
  },
  {
    name: 'kubectl.set.image.errors',
    tag: 'golden-verified',
    sources: [`${G}/set-image.yaml`, `${K}/set/set_image.go Complete, Validate, Run`, `${K}/set/helper.go CalculatePatches`, 'staging/src/k8s.io/kubectl/pkg/polymorphichelpers/updatepodspec.go', `${K}/util/helpers.go GetResourcesAndPairs, ParsePairs`],
  },
  {
    name: 'kubectl.label.output',
    tag: 'golden-verified',
    sources: [`${G}/label.yaml`, 'fixtures/golden/v1.37.2/client/yaml-input.yaml', `${K}/label/label.go RunLabel, updateDataChangeMsg`],
    note: 'labeled, unlabeled, modified, not labeled; `label "<key>" not found.`; a printer per object (no --- between YAML documents)',
  },
  {
    name: 'kubectl.label.list',
    tag: 'golden-verified',
    sources: [`${G}/label.yaml`, `${K}/label/label.go RunLabel`],
    note: 'Go prints a map in random order; the simulator sorts the keys (compared order-insensitively)',
  },
  {
    name: 'kubectl.label.errors',
    tag: 'golden-verified',
    sources: [`${G}/label.yaml`, `${K}/label/label.go Complete, Validate, parseLabels, validateNoOverwrites`],
  },
  {
    name: 'kubectl.annotate.output',
    tag: 'golden-verified',
    sources: [`${G}/annotate.yaml`, `${K}/annotate/annotate.go RunAnnotate`],
    note: '`annotated` lines; one printer (--- between YAML documents)',
  },
  {
    name: 'kubectl.annotate.list',
    tag: 'golden-verified',
    sources: [`${G}/annotate.yaml`, `${K}/annotate/annotate.go RunAnnotate`],
    note: 'Go prints a map in random order; the simulator sorts the keys (compared order-insensitively)',
  },
  {
    name: 'kubectl.annotate.errors',
    tag: 'golden-verified',
    sources: [`${G}/annotate.yaml`, `${K}/annotate/annotate.go ToOptions, validateAnnotations, validateNoAnnotationOverwrites`, `${K}/util/helpers.go ParsePairs`],
  },
  {
    name: 'kubectl.edit.file',
    tag: 'golden-verified',
    sources: [`${G}/edit.yaml`, `${K}/util/editor/editoptions.go editHeader.writeTo, editFn`],
    note: 'the header comment, the object (a v1 List for several), -o json without a header, CRLF, the reasons of a reopened file',
  },
  {
    name: 'kubectl.edit.output',
    tag: 'golden-verified',
    sources: [`${G}/edit.yaml`, `${K}/util/editor/editoptions.go editFn, visitToPatch, editResults.addError, preservedFile`],
    note: 'edited, skipped, Patch:, the Edit cancelled messages, "A copy of your changes has been stored to"; the temporary name comes from a named PRNG stream',
  },
  {
    name: 'kubectl.edit.errors',
    tag: 'golden-verified',
    sources: [`${G}/edit.yaml`, `${K}/util/editor/launcher_others.go Launch`, `${K}/util/editor/editoptions.go visitToPatch`],
    note: 'the editor errors, the changed name; the retryable and deleted-object endings are source-derived (not captured)',
  },
];

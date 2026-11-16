// Provenance of kubectl create -f and apply's output units, and of reading manifests with -f
// (docs/FIDELITY.md §3). Golden-verified units are compared with the fixtures by the
// differential runner (tools/src/golden/kubectl/, in the gate as tools/src/golden/kubectl.test.ts).

import type { ProvenanceSpec } from '@simlab/kernel';

const G = 'fixtures/golden/v1.37.2';
const BUILDER = 'staging/src/k8s.io/cli-runtime/pkg/resource/builder.go';
const VISITOR = 'staging/src/k8s.io/cli-runtime/pkg/resource/visitor.go';
const HELPERS = 'staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go';
const APPLY = 'staging/src/k8s.io/kubectl/pkg/cmd/apply/apply.go';

export const APPLY_PROVENANCE: ProvenanceSpec[] = [
  {
    name: 'kubectl.resource.files.paths',
    tag: 'golden-verified',
    sources: [`${G}/create/from-files.yaml`, `${G}/errors/validation.yaml`, `${BUILDER} FilenameParam, Path, Stdin, expandIfFilePattern, FilenameOptions.validate`, `${VISITOR} ExpandPathsToFileVisitors`],
    note: 'the path does not exist, cannot be accessed, pattern is not valid, recognized file extensions, standard input used twice, only one of -f or -k; the order files are read in',
  },
  {
    name: 'kubectl.resource.files.parsing',
    tag: 'golden-verified',
    sources: [`${G}/create/from-files.yaml`, `${G}/client/yaml-input.yaml`, `${G}/errors/validation.yaml`, `${VISITOR} StreamVisitor.Visit`],
    note: 'error parsing <source>: … with the YAML line reference (the decoder is apimachinery/yaml)',
  },
  {
    name: 'kubectl.resource.files.validation',
    tag: 'golden-verified',
    sources: [`${G}/create/from-files.yaml`, `${G}/create/no-server.yaml`, `${G}/errors/validation.yaml`, 'staging/src/k8s.io/kubectl/pkg/validation/validation.go getObjectKind', `${VISITOR} ValidateSchema`],
    note: 'error validating "<source>": error validating data: kind not set | apiVersion not set | invalid object to validate | unexpected GroupVersion string | failed to download openapi; client-side OpenAPI checks of kinds the server cannot validate print a notice',
  },
  {
    name: 'kubectl.resource.files.decoding',
    tag: 'golden-verified',
    sources: [`${G}/create/from-files.yaml`, `${G}/create/no-server.yaml`, `${G}/errors/validation.yaml`, 'staging/src/k8s.io/cli-runtime/pkg/resource/mapper.go infoForData, infoForObject', 'staging/src/k8s.io/cli-runtime/pkg/resource/metadata_decoder.go'],
    note: 'unable to decode, Object \'Kind\' is missing, resource mapping not found … ensure CRDs are installed first, unable to recognize',
  },
  {
    name: 'kubectl.resource.files.namespace',
    tag: 'golden-verified',
    sources: [`${G}/create/from-files.yaml`, `${G}/apply/three-way.yaml`, `${VISITOR} RequireNamespace`],
  },
  {
    name: 'kubectl.resource.files.selector',
    tag: 'golden-verified',
    sources: [`${G}/create/from-files.yaml`, `${BUILDER} visitByPaths`, `${VISITOR} FilterByLabelSelector`],
  },
  {
    name: 'kubectl.create.output',
    tag: 'golden-verified',
    sources: [`${G}/create/from-files.yaml`, `${G}/configmaps/list-output.yaml`, 'staging/src/k8s.io/kubectl/pkg/cmd/create/create.go RunCreate', 'staging/src/k8s.io/cli-runtime/pkg/printers/name.go', `${HELPERS} PrintFlagsWithDryRunStrategy`],
    note: '<kind>[.<group>]/<name> created[ (dry run)| (server dry run)], -o name|yaml|json, the last-applied annotation of --save-config',
  },
  {
    name: 'kubectl.create.errors',
    tag: 'golden-verified',
    sources: [
      `${G}/create/from-files.yaml`,
      `${G}/errors/validation.yaml`,
      `${G}/client/help.yaml`,
      'staging/src/k8s.io/kubectl/pkg/cmd/create/create.go Complete, Validate, RunCreate',
      `${HELPERS} AddSourceToErr, GetDryRunStrategy, GetValidationDirective, UsageErrorf`,
      'staging/src/k8s.io/cli-runtime/pkg/genericclioptions/print_flags.go NoCompatiblePrinterError',
    ],
    note: 'error when creating "<source>", Unexpected args, must specify one of -f and -k, no objects passed to create, the dry-run and validate value errors, the printer error; --raw\'s checks are source-derived',
  },
  {
    name: 'kubectl.create.dry-run-warnings',
    tag: 'golden-verified',
    sources: [`${G}/create/from-files.yaml`, `${G}/apply/three-way.yaml`, `${HELPERS} GetDryRunStrategy`],
    note: 'the klog lines at helpers.go:714 and 728; 731 (--dry-run=false) is source-derived',
  },
  {
    name: 'kubectl.apply.output',
    tag: 'golden-verified',
    sources: [`${G}/apply/created-configured-unchanged.yaml`, `${G}/apply/three-way.yaml`, `${G}/apply/overwrite.yaml`, `${APPLY} applyOneObject, printObjects`],
    note: 'created, configured, unchanged with the dry-run suffixes; -o name; -o yaml|json at the end, a List for several objects',
  },
  {
    name: 'kubectl.apply.last-applied',
    tag: 'golden-verified',
    sources: [`${G}/apply/created-configured-unchanged.yaml`, `${G}/apply/three-way.yaml`, 'staging/src/k8s.io/kubectl/pkg/util/apply.go GetModifiedConfiguration, CreateApplyAnnotation'],
  },
  {
    name: 'kubectl.apply.warnings',
    tag: 'golden-verified',
    sources: [`${G}/apply/created-configured-unchanged.yaml`, `${G}/apply/overwrite.yaml`, `${APPLY} warningNoLastAppliedConfigAnnotation`, 'staging/src/k8s.io/kubectl/pkg/cmd/apply/patcher.go patchSimple'],
    note: 'the missing-annotation warning; the patch warnings of a conflict (golden-verified up to managedFields, DIV-015); warningChangesOnDeletingResource is source-derived',
  },
  {
    name: 'kubectl.apply.errors',
    tag: 'golden-verified',
    sources: [
      `${G}/apply/three-way.yaml`,
      `${G}/apply/overwrite.yaml`,
      `${G}/errors/validation.yaml`,
      `${APPLY} ToOptions, Validate, applyOneObject`,
      'staging/src/k8s.io/kubectl/pkg/cmd/apply/patcher.go Patch, createPatchErrFormat',
      'staging/src/k8s.io/kubectl/pkg/cmd/delete/delete_flags.go parseCascadingFlag',
      'staging/src/k8s.io/client-go/rest/request.go Name',
    ],
    note: 'the flag checks of Validate, generate name, the empty name, error when creating|patching|applying patch|retrieving current configuration; the conflict text up to managedFields (DIV-015)',
  },
];

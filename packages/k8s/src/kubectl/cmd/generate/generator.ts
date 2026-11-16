// The run of a `create <kind>` generator: the flags every one of them has, then Complete,
// Validate and Run as each upstream command orders them.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/create/create_deployment.go,
//             create_namespace.go, create_configmap.go, create_secret.go, create_service.go
//             (NewCmd…: PrintFlags, AddApplyAnnotationFlags, AddValidateFlags, AddDryRunFlag,
//             AddFieldManagerFlagVar "kubectl-create"; Complete; Validate; Run)

import type { Op } from '@simlab/host';
import type { JsonObject } from '../../../apimachinery/json.ts';
import type { Invocation, Verb } from '../../cli/command.ts';
import type { KubectlError } from '../../cli/errors.ts';
import type { FlagDef } from '../../cli/flagset.ts';
import { fail } from '../../client/session.ts';
import { openServer } from '../../resource/server.ts';
import { CHANGE_FORMATS, DRY_RUN_NO_OPT } from '../helpers.ts';
import { completeCreate, createRequest, nameFromArgs, printObject, requiredFlag, str, typedApplyAnnotation, wrapped, type Completed, type Target } from './common.ts';

/** PrintFlags, the apply-annotation, validate, dry-run and field-manager flags. */
export function outputFlags(fieldManager: string): FlagDef[] {
  return [
    { name: 'output', shorthand: 'o', kind: 'string', default: '' },
    { name: 'template', kind: 'string', default: '' },
    { name: 'dry-run', kind: 'string', default: 'none', noOptDefVal: DRY_RUN_NO_OPT },
    { name: 'save-config', kind: 'bool', default: false },
    { name: 'field-manager', kind: 'string', default: fieldManager },
  ];
}

export const VALIDATE_FLAG: FlagDef = { name: 'validate', kind: 'string', default: 'strict', noOptDefVal: 'strict' };

export const OUTPUT_NO_EFFECT: Record<string, string> = {
  'allow-missing-template-keys': 'only used by template output formats, which print a notice',
  'show-managed-fields': 'objects have no managedFields (DIV-015)',
};

export const OUTPUT_PARTIAL: Record<string, string> = {
  output: 'kyaml and the template formats print a notice',
  template: 'prints a notice: template output is not simulated',
};

export const OUTPUT_FORMATS = { allowed: CHANGE_FORMATS, simulated: ['json', 'yaml', 'name'] };

export interface GeneratorSpec {
  path: string;
  /** Flags beyond the output flags. */
  flags: FlagDef[];
  /** Flags cobra requires (MarkFlagRequired). */
  required?: string[];
  /** The vendored Go type of the object, e.g. `apps/v1.Deployment`. */
  typeId: string;
  /** Validate, after Complete. */
  validate?(inv: Invocation, c: Completed): KubectlError | undefined;
  /** The object to create (createDeployment …), or the error building it. */
  build(inv: Invocation, name: string, c: Completed): { object: JsonObject } | { error: KubectlError };
  /** Where the create goes. */
  target(c: Completed): Target;
  /** Whether Complete reads --save-config (create service never does). */
  saveConfig: boolean;
  /** The text the command puts before a failed create's error (`failed to create deployment: `), if any. */
  errorPrefix?(inv: Invocation): string;
  noEffect?: Record<string, string>;
  partial?: Record<string, string>;
}

export function generatorVerb(spec: GeneratorSpec): Verb {
  function* run(inv: Invocation): Op<number> {
    const { p } = inv;
    const v = inv.flags.values;
    for (const r of spec.required ?? []) {
      const err = requiredFlag(inv, r);
      if (err) return yield* fail(p, err);
    }
    const name = nameFromArgs(inv);
    if (typeof name !== 'string') return yield* fail(p, name);
    const c = yield* completeCreate(p, inv);
    if ('type' in c) return yield* fail(p, c);
    const invalid = spec.validate?.(inv, c);
    if (invalid) return yield* fail(p, invalid);
    const built = spec.build(inv, name, c);
    if ('error' in built) return yield* fail(p, built.error);
    let obj = built.object;
    typedApplyAnnotation(spec.saveConfig && v['save-config'] === true, obj, spec.typeId);
    if (c.dryRun !== 'client') {
      const server = yield* openServer(p, c.config);
      if (typeof server === 'number') return server;
      const r = yield* createRequest(p, server, spec.target(c), obj, { fieldManager: str(v['field-manager']), directive: c.directive, dryRun: c.dryRun });
      if (typeof r === 'number') return r;
      if ('error' in r) return yield* fail(p, spec.errorPrefix ? wrapped(spec.errorPrefix(inv), r.error) : r.error);
      obj = r.object;
    }
    const err = yield* printObject(p, c.printer, obj, spec.typeId);
    if (err) return yield* fail(p, err);
    return 0;
  }
  return {
    path: spec.path,
    flags: [...outputFlags('kubectl-create'), VALIDATE_FLAG, ...spec.flags],
    noEffect: { ...OUTPUT_NO_EFFECT, ...spec.noEffect },
    partial: { ...OUTPUT_PARTIAL, ...spec.partial },
    outputFormats: OUTPUT_FORMATS,
    run,
  };
}

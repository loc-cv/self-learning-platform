// k8s.rollout: the rollout is complete in the sense of `kubectl rollout status` (docs/SCENARIO_FORMAT.md
// §7.1). The verdict and `observed` are the status viewer's: the line kubectl would print, or its
// progress-deadline error. `rollout status` passes --revision (default 0: any revision), so the
// check does too.
//   upstream: staging/src/k8s.io/kubectl/pkg/polymorphichelpers/rollout_status.go
//             DeploymentStatusViewer.Status (kubectl/cmd/rollout/status.ts deploymentStatus)

import type { CheckCtx, CheckResult, CheckSpec, Json } from '@simlab/kernel';
import type { JsonObject } from '../apimachinery/json.ts';
import { deploymentStatus } from '../kubectl/cmd/rollout/status.ts';
import { evalError, isError, responseError, withClient } from './common.ts';

interface RolloutArgs {
  namespace: string;
  name: string;
  kind?: 'Deployment' | 'StatefulSet' | 'DaemonSet';
}

const SCHEMA: JsonObject = {
  type: 'object',
  description: 'The rollout is complete in the sense of kubectl rollout status: every replica updated, no old replica left, every updated replica available, and the progress deadline not exceeded.',
  properties: {
    namespace: { type: 'string', minLength: 1, description: 'The namespace of the workload.' },
    name: { type: 'string', minLength: 1, description: 'The name of the workload.' },
    kind: { enum: ['Deployment', 'StatefulSet', 'DaemonSet'], description: 'The workload kind. Default Deployment; StatefulSet and DaemonSet arrive with phase 18a.' },
  },
  required: ['namespace', 'name'],
  additionalProperties: false,
};

function run(ctx: CheckCtx, raw: Json): CheckResult {
  const a = raw as unknown as RolloutArgs;
  const kind = a.kind ?? 'Deployment';
  const expected = `the rollout of ${kind} ${a.name} in namespace ${a.namespace} is complete`;
  if (kind !== 'Deployment') return evalError(expected, `[sim] k8s.rollout supports Deployment only; ${kind} arrives with phase 18a`);
  const got = withClient(ctx.kernel, (client) => {
    const r = client.resource('apps/v1/deployments').get(a.namespace, a.name);
    if (r.ok) return { deployment: r.object as JsonObject };
    if ('status' in r && r.code === 404) return { missing: responseError(r) };
    return { error: responseError(r) };
  });
  if (isError(got)) return evalError(expected, got.error);
  if ('missing' in got) return { pass: false, expected, observed: got.missing };
  const s = deploymentStatus(got.deployment, 0n);
  if ('error' in s) return { pass: false, expected, observed: s.error.type === 'message' ? s.error.message : JSON.stringify(s.error) };
  return { pass: s.done, expected, observed: s.text.replace(/\n$/, '') };
}

export const rolloutCheck: CheckSpec = { name: 'k8s.rollout', args: SCHEMA, run };

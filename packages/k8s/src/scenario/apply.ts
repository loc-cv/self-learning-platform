// The `apply` step (docs/SCENARIO_FORMAT.md §6.1): YAML documents submitted as cluster admin with
// kubectl apply semantics. It runs the simulated kubectl itself, `kubectl apply -f -` with the
// documents on standard input, in a root shell on the machine the API server runs on, with
// kubeadm's admin kubeconfig. So the world holds exactly what a person running that command
// leaves: the last-applied annotation, managed fields, events, and kubectl's own errors when a
// manifest is wrong.

import type { Json, StepCtx, StepSpec } from '@simlab/kernel';
import { getMachine, runLine, stepShell, tail } from '@simlab/host';
import { k8sSlice } from '../apiserver/store.ts';

/** kubeadm's kubeconfig for the cluster admin (kubeadm init phase kubeconfig admin). */
const ADMIN_KUBECONFIG = '/etc/kubernetes/admin.conf';
const DELIMITER = 'SIMLAB_APPLY_EOF';

/** The machine the API server listens on: the one holding its advertise address. */
function controlPlaneMachine(ctx: StepCtx): string {
  return ctx.kernel.act('apply.machine', (c) => {
    const servers = k8sSlice(c).apiServers;
    const key = Object.keys(servers).sort()[0];
    const server = key === undefined ? undefined : servers[key];
    if (!server) throw new Error('the world has no Kubernetes API server');
    const host = c.world.slices['host'] as { machines: Record<string, unknown> };
    const machine = Object.keys(host.machines)
      .sort()
      .find((id) => (getMachine(c, id).addresses ?? []).includes(server.advertiseAddress));
    if (!machine) throw new Error(`no machine has the API server's address ${server.advertiseAddress}`);
    return machine;
  });
}

export const applyStep: StepSpec = {
  name: 'apply',
  args: {
    type: 'object',
    properties: {
      apply: { type: 'string', minLength: 1, description: 'YAML documents, applied as `kubectl apply -f -` by the cluster admin.' },
    },
    required: ['apply'],
    additionalProperties: false,
  },
  run(ctx: StepCtx, raw: Json) {
    const manifests = String((raw as { apply: string }).apply);
    if (manifests.split('\n').includes(DELIMITER)) throw new Error(`the manifests contain a line ${DELIMITER}`);
    const body = manifests.endsWith('\n') ? manifests : `${manifests}\n`;
    const login = stepShell(ctx.kernel, ctx.session, controlPlaneMachine(ctx), 'root', 'k8s.apply');
    const r = runLine(login, `KUBECONFIG=${ADMIN_KUBECONFIG} kubectl apply -f - <<'${DELIMITER}'\n${body}${DELIMITER}`);
    if (r.status !== 0) throw new Error(`kubectl apply exited with ${r.status}${r.output === '' ? '' : `:\n${tail(r.output)}`}`);
  },
  show(raw: Json) {
    const manifests = String((raw as { apply: string }).apply).replace(/\n$/, '');
    return [`$ kubectl apply -f - <<'EOF'`, ...manifests.split('\n'), 'EOF'].join('\n');
  },
};

export const K8S_STEPS: readonly StepSpec[] = [applyStep];

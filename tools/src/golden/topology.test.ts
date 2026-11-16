// The simulated kubeadm-1cp-2w Nodes against the oracle's: the Node object the real API server
// stored for the fake node (fixtures/golden/v1.37.2/nodes/read.yaml, `objects` step) and the one
// the simulated topology builds must agree field by field, except where KWOK is not a kubelet
// (docs/FIDELITY.md §6.5) and the simulated Node follows the kubelet's source instead
// (packages/k8s/src/topology/nodes.ts):
// - conditions: KWOK writes Ready first and a NetworkUnavailable condition from a route
//   controller; a kubelet writes MemoryPressure, DiskPressure, PIDPressure, Ready, and nothing sets
//   NetworkUnavailable on a cluster without a cloud provider or CNI agent;
// - declaredFeatures and nodeInfo.runningInUserNamespace: set by a kubelet, not by KWOK.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { bootKernel, createRegistry, DEFAULT_START_TIME } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { buildCluster, createClient, DEFAULT_APISERVER, k8sPlugin, KUBEADM_1CP_2W } from '@simlab/k8s';
import { repoRoot } from '../oracle/paths.ts';

type Obj = Record<string, unknown>;

function oracleNode(name: string): Obj {
  const f = parse(readFileSync(join(repoRoot, 'fixtures/golden/v1.37.2/nodes/read.yaml'), 'utf8')) as { steps: { objects?: { ref: string; object: Obj }[] }[] };
  const o = f.steps.flatMap((s) => s.objects ?? []).find((x) => x.ref === `node/${name}`);
  if (!o) throw new Error(`no node/${name} in nodes/read`);
  return o.object;
}

function simulatedNode(name: string): Obj {
  const k = bootKernel(createRegistry([hostPlugin, k8sPlugin]), { seed: 1, startTime: DEFAULT_START_TIME });
  k.act('topology', (ctx) => buildCluster(ctx, KUBEADM_1CP_2W));
  const r = k.act('get', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource('v1/nodes').get(undefined, name));
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.object as Obj;
}

/** The fixture's normalization applied to the simulated object, and the KWOK-authored fields dropped from both. */
function comparable(node: Obj, tokens: Obj): Obj {
  const n = structuredClone(node) as { metadata: Obj; spec: Obj; status: Obj & { nodeInfo: Obj } };
  n.metadata.creationTimestamp = '<<time>>';
  n.metadata.resourceVersion = '<<rv>>';
  n.metadata.uid = tokens.uid;
  n.spec.podCIDR = '<<ip>>/24';
  n.spec.podCIDRs = ['<<ip>>/24'];
  n.status.nodeInfo.bootID = tokens.bootID;
  n.status.nodeInfo.systemUUID = tokens.systemUUID;
  delete n.status.conditions;
  delete n.status.declaredFeatures;
  delete n.status.nodeInfo.runningInUserNamespace;
  return n;
}

describe('kubeadm-1cp-2w Nodes against the oracle', () => {
  test('the control plane Node has the shape of the real one', () => {
    const real = oracleNode('controlplane') as { metadata: Obj; status: { nodeInfo: Obj } };
    const tokens = { uid: real.metadata.uid, bootID: real.status.nodeInfo.bootID, systemUUID: real.status.nodeInfo.systemUUID };
    expect(comparable(simulatedNode('controlplane'), tokens)).toEqual(comparable(real as Obj, tokens));
  });

  test("the kubelet's conditions in its order, with the real reasons and messages", () => {
    const sim = simulatedNode('node01') as { status: { conditions: Obj[] } };
    const real = oracleNode('controlplane') as { status: { conditions: Obj[] } };
    const pick = (c: Obj) => [c.type, c.status, c.reason, c.message];
    expect(sim.status.conditions.map(pick)).toEqual(['MemoryPressure', 'DiskPressure', 'PIDPressure', 'Ready'].map((t) => pick(real.status.conditions.find((c) => c.type === t) as Obj)));
  });
});

// The world of a k8s transcript (packages/k8s/src/transcripts.test.ts): kubeadm-1cp-2w, settled,
// with the header's files placed in the session user's home directory. Objects are made by the
// transcript itself (`% kubectl create -f …`). Test support only.

import { bootKernel, createRegistry, DEFAULT_START_TIME, TOPOLOGY, type Ports, type TopologyInfo, type TopologySpec } from '@simlab/kernel';
import { hostPlugin, placeFile, type TranscriptWorld } from '@simlab/host';
import { k8sPlugin } from '../plugin.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);

function headerValues(header: readonly string[], key: string): string[] {
  const out: string[] = [];
  for (const h of header) {
    const m = new RegExp(`^${key}:\\s*(.*)$`).exec(h);
    if (m) out.push((m[1] as string).trim());
  }
  return out;
}

/** `read` reads a file next to the transcript, by its path relative to the transcript's directory. */
export function transcriptWorld(header: readonly string[], read: (name: string) => string): (ports: Ports) => TranscriptWorld {
  return (ports) => {
    const kernel = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME, ports });
    const spec = registry.get<TopologySpec>(TOPOLOGY, 'kubeadm-1cp-2w');
    if (!spec) throw new Error('no topology kubeadm-1cp-2w');
    const info = kernel.act('topology', (ctx) => spec.build(ctx, {})) as TopologyInfo;
    kernel.advance(5_000);
    const settle = Number(headerValues(header, 'settle')[0] ?? '10');
    kernel.advance(settle * 1000);
    const machine = headerValues(header, 'machine')[0] ?? info.entry.machine;
    const user = headerValues(header, 'user')[0] ?? info.entry.user;
    for (const name of headerValues(header, 'file')) {
      const text = read(name);
      kernel.act('transcript-file', (ctx) => placeFile(ctx, machine, user, name, text));
    }
    return { kernel, machine, user };
  };
}

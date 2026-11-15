// `ubuntu-1`: one plain Ubuntu 24.04 server, `node01`, with the user `student`. The terminal player
// and script mode have something to run before Kubernetes topologies exist (phase 06a), and host
// content (the Linux pack, phase 34) can use it.

import type { TopologySpec } from '@simlab/kernel';
import { buildUbuntuBase } from './base/ubuntu.ts';
import { createMachine } from './machine.ts';

export const ubuntu1Topology: TopologySpec = {
  name: 'ubuntu-1',
  params: { type: 'object', properties: {}, additionalProperties: false },
  build(ctx) {
    createMachine(ctx, { id: 'node01', hostname: 'node01', kind: 'node' });
    buildUbuntuBase(ctx, 'node01', { user: { name: 'student' } });
    return { entry: { machine: 'node01', user: 'student' }, machines: ['node01'] };
  },
};

// npm run oracle -- <command>
//
//   fetch            download and verify the pinned binaries into .upstream/bin/
//   up [--no-kwok]   start a throwaway control plane with the kubeadm-1cp-2w Nodes
//   down             stop it; fails if a process or port is left behind
//   status           show what is running
//   env              print `export KUBECONFIG=…` for the running oracle
//
// A development tool (docs/FIDELITY.md §6). Nothing at runtime and nothing in `npm run check`
// needs it.

import { fetchBinaries } from './binaries.ts';
import { down, readState, status, up } from './controlplane.ts';

const [cmd, ...rest] = process.argv.slice(2);
const log = (s: string) => console.log(s);

switch (cmd) {
  case 'fetch': {
    const got = await fetchBinaries(log);
    console.log(got.length === 0 ? 'all binaries present' : `fetched ${got.join(', ')}`);
    break;
  }
  case 'up': {
    await fetchBinaries(log);
    const t = Date.now();
    const s = await up({ kwok: !rest.includes('--no-kwok'), log });
    console.log(`oracle up in ${((Date.now() - t) / 1000).toFixed(1)}s: ${s.server}\nexport KUBECONFIG=${s.kubeconfig}`);
    break;
  }
  case 'down': {
    const problems = await down({ log });
    if (problems.length > 0) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    console.log('oracle down; no process or port left');
    break;
  }
  case 'status':
    console.log(status());
    break;
  case 'env': {
    const s = readState();
    if (!s) {
      console.error('no oracle is running');
      process.exit(1);
    }
    console.log(`export KUBECONFIG=${s.kubeconfig}`);
    break;
  }
  default:
    console.error('usage: npm run oracle -- fetch | up [--no-kwok] | down | status | env');
    process.exit(2);
}

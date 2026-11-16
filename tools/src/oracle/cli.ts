// npm run oracle -- <command>
//
//   fetch               download and verify the pinned binaries into .upstream/bin/
//   up [--no-kwok]      start a throwaway control plane with the kubeadm-1cp-2w Nodes in a new
//                       directory; prints the directory and `export KUBECONFIG=…`
//   down [<dir>|--all]  stop the oracle running from <dir> (its path or name, or its kubeconfig);
//                       without <dir>, the only one `up` started; --all, every one `up` started.
//                       Fails if a process or port of it is left behind. Never touches another
//                       oracle, and never one golden capture owns unless <dir> names it
//   status              show every running oracle
//   env [<dir>]         print `export KUBECONFIG=…` for that oracle
//
// Several oracles can run at once (other sessions, golden capture); each is recorded in its own
// file, .upstream/oracle/<directory name>.json, which `status` lists.
//
// A development tool (docs/FIDELITY.md §6). Nothing at runtime and nothing in `npm run check`
// needs it.

import { fetchBinaries } from './binaries.ts';
import { down, findState, listStates, status, up, type OracleState } from './controlplane.ts';

const [cmd, ...rest] = process.argv.slice(2);
const log = (s: string) => console.log(s);
const ref = rest.find((a) => !a.startsWith('--'));

function pick(): OracleState {
  try {
    return findState(ref);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

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
    console.log(`oracle up in ${((Date.now() - t) / 1000).toFixed(1)}s: ${s.server}\ndir ${s.dir}\nexport KUBECONFIG=${s.kubeconfig}`);
    break;
  }
  case 'down': {
    const targets = rest.includes('--all') ? listStates().filter((s) => s.owner === undefined) : [pick()];
    if (targets.length === 0) console.log('no oracle is running');
    let failed = false;
    for (const s of targets) {
      const problems = await down(s, { log });
      if (problems.length > 0) {
        console.error(problems.join('\n'));
        failed = true;
      } else console.log(`oracle ${s.dir} down; no process or port of it left`);
    }
    if (failed) process.exit(1);
    break;
  }
  case 'status':
    console.log(status());
    break;
  case 'env':
    console.log(`export KUBECONFIG=${pick().kubeconfig}`);
    break;
  default:
    console.error('usage: npm run oracle -- fetch | up [--no-kwok] | down [<dir>|--all] | status | env [<dir>]');
    process.exit(2);
}

// Start and stop the throwaway control plane: etcd, kube-apiserver, kube-controller-manager,
// kube-scheduler and KWOK, as detached processes in a temporary directory, on free ports chosen
// at start. `up` records what it started in .upstream/oracle/state.json; `down` stops every
// process group, checks that no process and no port is left, and deletes the directory.
//
// Flags follow the static Pod manifests kubeadm writes (upstream:
// cmd/kubeadm/app/phases/controlplane/manifests.go getAPIServerCommand,
// getControllerManagerCommand, getSchedulerCommand), with local addresses and ports.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { KUBERNETES_TAG } from '@simlab/k8s';
import { binaryPath, requireBinaries } from './binaries.ts';
import { oracleStateFile } from './paths.ts';
import { generatePki, writeKubeconfig } from './pki.ts';
import { CLUSTER, NODES, nodeManifest } from './topology.ts';

export interface OracleState {
  dir: string;
  /** Admin kubeconfig (user kubernetes-admin), as kubeadm's admin.conf. */
  kubeconfig: string;
  server: string;
  ports: Record<string, number>;
  processes: { name: string; pid: number }[];
  kwok: boolean;
  /** The workstation's host name, which leader election identities contain. */
  hostname: string;
}

// Ports come from 20000-29999: below Linux's ephemeral range (32768-60999 by default), where
// outgoing connections of the components themselves would race for a port chosen as free, and
// below the NodePort range. Ports handed out stay reserved for this process's lifetime, so
// concurrent oracles (golden capture runs several) never share one.
const reserved = new Set<number>();

function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.unref();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const p = 20000 + Math.floor(Math.random() * 10000);
    if (reserved.has(p) || portInUse(p) || !(await bindable(p))) continue;
    reserved.add(p);
    return p;
  }
  throw new Error('no free port in 20000-29999');
}

function portInUse(port: number): boolean {
  // ss is iproute2's; -H drops the header. Reading only.
  const r = spawnSync('ss', ['-Htln', `sport = :${port}`], { encoding: 'utf8' });
  return r.stdout.trim() !== '';
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, timeoutMs: number, probe: () => boolean, logFile?: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (probe()) return;
    await sleep(250);
  }
  const tail = logFile && existsSync(logFile) ? '\n' + readFileSync(logFile, 'utf8').split('\n').slice(-30).join('\n') : '';
  throw new Error(`timed out waiting for ${what}${tail}`);
}

export function kubectl(state: Pick<OracleState, 'kubeconfig'>, args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(binaryPath('kubectl'), ['--kubeconfig', state.kubeconfig, ...args], { encoding: 'utf8', input });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

export function readState(file = oracleStateFile): OracleState | undefined {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as OracleState) : undefined;
}

export interface UpOptions {
  kwok?: boolean;
  log?: (s: string) => void;
  /** Where to record the running control plane; one file per concurrently running oracle. */
  stateFile?: string;
}

export async function up(opts: UpOptions = {}): Promise<OracleState> {
  const log = opts.log ?? (() => {});
  const kwok = opts.kwok ?? true;
  const stateFile = opts.stateFile ?? oracleStateFile;
  requireBinaries();
  if (readState(stateFile)) throw new Error(`an oracle is already recorded in ${stateFile}; run npm run oracle -- down`);

  const dir = mkdtempSync(path.join(tmpdir(), 'simlab-oracle-'));
  const names = ['etcd', 'etcd-peer', 'apiserver', 'controller-manager', 'scheduler', 'kwok'];
  const ports: Record<string, number> = {};
  for (const n of names) ports[n] = await freePort();
  const server = `https://127.0.0.1:${ports.apiserver}`;
  const state: OracleState = { dir, kubeconfig: '', server, ports, processes: [], kwok, hostname: hostname() };
  mkdirSync(path.dirname(stateFile), { recursive: true });
  const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
  save();

  const start = (name: string, bin: Parameters<typeof binaryPath>[0], args: string[]) => {
    const out = openSync(path.join(dir, `${name}.log`), 'a');
    const child = spawn(binaryPath(bin), args, { cwd: dir, detached: true, stdio: ['ignore', out, out] });
    child.unref();
    if (child.pid === undefined) throw new Error(`${name} did not start`);
    state.processes.push({ name, pid: child.pid });
    save();
    log(`started ${name} (pid ${child.pid})`);
  };
  const logOf = (n: string) => path.join(dir, `${n}.log`);

  try {
    log(`generating certificates in ${dir}`);
    generatePki(dir);
    state.kubeconfig = writeKubeconfig(dir, 'admin.conf', 'admin', server);
    const superAdmin = { kubeconfig: writeKubeconfig(dir, 'super-admin.conf', 'super-admin', server) };
    writeKubeconfig(dir, 'controller-manager.conf', 'controller-manager', server);
    writeKubeconfig(dir, 'scheduler.conf', 'scheduler', server);
    writeKubeconfig(dir, 'kwok.conf', 'kwok', server);
    save();

    start('etcd', 'etcd', [
      '--name', CLUSTER.controlPlaneName,
      '--data-dir', path.join(dir, 'etcd'),
      '--listen-client-urls', `http://127.0.0.1:${ports.etcd}`,
      '--advertise-client-urls', `http://127.0.0.1:${ports.etcd}`,
      '--listen-peer-urls', `http://127.0.0.1:${ports['etcd-peer']}`,
      '--initial-advertise-peer-urls', `http://127.0.0.1:${ports['etcd-peer']}`,
      '--initial-cluster', `${CLUSTER.controlPlaneName}=http://127.0.0.1:${ports['etcd-peer']}`,
      '--listen-metrics-urls', '',
    ]);
    await until('etcd', 20_000, () => spawnSync(binaryPath('etcdctl'), ['--endpoints', `127.0.0.1:${ports.etcd}`, 'endpoint', 'health'], { stdio: 'ignore' }).status === 0, logOf('etcd'));

    start('kube-apiserver', 'kube-apiserver', [
      `--advertise-address=${CLUSTER.advertiseAddress}`,
      '--allow-privileged=true',
      '--authorization-mode=Node,RBAC',
      `--bind-address=127.0.0.1`,
      `--client-ca-file=${dir}/ca.crt`,
      '--enable-admission-plugins=NodeRestriction',
      '--enable-bootstrap-token-auth=true',
      `--etcd-servers=http://127.0.0.1:${ports.etcd}`,
      '--kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname',
      `--secure-port=${ports.apiserver}`,
      '--service-account-issuer=https://kubernetes.default.svc.cluster.local',
      `--service-account-key-file=${dir}/sa.pub`,
      `--service-account-signing-key-file=${dir}/sa.key`,
      `--service-cluster-ip-range=${CLUSTER.serviceCIDR}`,
      `--tls-cert-file=${dir}/apiserver.crt`,
      `--tls-private-key-file=${dir}/apiserver.key`,
    ]);
    await until('kube-apiserver /readyz', 60_000, () => kubectl(superAdmin, ['get', '--raw', '/readyz']).status === 0, logOf('kube-apiserver'));

    // kubeadm init's bootstrap: the admin group is bound to cluster-admin.
    // upstream: cmd/kubeadm/app/phases/kubeconfig/kubeconfig.go EnsureAdminClusterRoleBinding
    const crb = kubectl(superAdmin, ['create', 'clusterrolebinding', 'kubeadm:cluster-admins', '--clusterrole=cluster-admin', '--group=kubeadm:cluster-admins']);
    if (crb.status !== 0) throw new Error(crb.stderr);

    // Nodes register before any controller runs, as kubelets do during kubeadm init and join.
    const nodes = NODES.map((n) => JSON.stringify(nodeManifest(n, KUBERNETES_TAG))).join('\n');
    const created = kubectl(superAdmin, ['create', '-f', '-'], nodes);
    if (created.status !== 0) throw new Error(created.stderr);

    if (kwok) {
      start('kwok', 'kwok', [
        `--kubeconfig=${dir}/kwok.conf`,
        `--config=${path.join(import.meta.dirname, 'kwok-stages.yaml')}`,
        '--manage-all-nodes=true',
        `--server-address=127.0.0.1:${ports.kwok}`,
        '--node-lease-duration-seconds=40',
      ]);
    }

    start('kube-controller-manager', 'kube-controller-manager', [
      '--allocate-node-cidrs=true',
      `--authentication-kubeconfig=${dir}/controller-manager.conf`,
      `--authorization-kubeconfig=${dir}/controller-manager.conf`,
      '--bind-address=127.0.0.1',
      `--client-ca-file=${dir}/ca.crt`,
      `--cluster-cidr=${CLUSTER.podCIDR}`,
      `--cluster-name=${CLUSTER.clusterName}`,
      `--cluster-signing-cert-file=${dir}/ca.crt`,
      `--cluster-signing-key-file=${dir}/ca.key`,
      '--controllers=*,bootstrapsigner,tokencleaner',
      `--kubeconfig=${dir}/controller-manager.conf`,
      '--leader-elect=true',
      `--root-ca-file=${dir}/ca.crt`,
      `--secure-port=${ports['controller-manager']}`,
      `--service-account-private-key-file=${dir}/sa.key`,
      `--service-cluster-ip-range=${CLUSTER.serviceCIDR}`,
      '--use-service-account-credentials=true',
    ]);
    start('kube-scheduler', 'kube-scheduler', [
      `--authentication-kubeconfig=${dir}/scheduler.conf`,
      `--authorization-kubeconfig=${dir}/scheduler.conf`,
      '--bind-address=127.0.0.1',
      `--kubeconfig=${dir}/scheduler.conf`,
      '--leader-elect=true',
      `--secure-port=${ports.scheduler}`,
    ]);

    const admin = state;
    if (kwok) await until('Ready nodes', 60_000, () => kubectl(admin, ['wait', '--for=condition=Ready', 'node', '--all', '--timeout=1s']).status === 0, logOf('kwok'));
    // Pods can be created once the service account controller made `default` in each namespace.
    await until('the default service account', 60_000, () => kubectl(admin, ['get', 'serviceaccount', 'default', '-n', 'default']).status === 0, logOf('kube-controller-manager'));
    await until('kube-root-ca.crt', 60_000, () => kubectl(admin, ['get', 'configmap', 'kube-root-ca.crt', '-n', 'default']).status === 0, logOf('kube-controller-manager'));
    await until('scheduler leadership', 60_000, () => kubectl(admin, ['get', 'lease', 'kube-scheduler', '-n', 'kube-system']).status === 0, logOf('kube-scheduler'));
    await until('controller-manager leadership', 60_000, () => kubectl(admin, ['get', 'lease', 'kube-controller-manager', '-n', 'kube-system']).status === 0, logOf('kube-controller-manager'));
    for (const p of state.processes) if (!alive(p.pid)) throw new Error(`${p.name} exited:\n${readFileSync(logOf(p.name), 'utf8').split('\n').slice(-30).join('\n')}`);
    return state;
  } catch (e) {
    await down({ log, keepDirOnError: true, stateFile });
    throw e;
  }
}

export interface DownOptions {
  log?: (s: string) => void;
  /** Keep the directory (logs) when `up` failed, and say where it is. */
  keepDirOnError?: boolean;
  stateFile?: string;
}

/** Stops everything the state file lists. Returns problems found (left-over processes or ports). */
export async function down(opts: DownOptions = {}): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const stateFile = opts.stateFile ?? oracleStateFile;
  const state = readState(stateFile);
  if (!state) return [];
  // Reverse start order: clients first, etcd last.
  for (const p of [...state.processes].reverse()) {
    if (!alive(p.pid)) continue;
    try {
      process.kill(-p.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    const end = Date.now() + 10_000;
    while (alive(p.pid) && Date.now() < end) await sleep(100);
    if (alive(p.pid)) {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      await sleep(200);
    }
    log(`stopped ${p.name}`);
  }
  const problems: string[] = [];
  for (const p of state.processes) if (alive(p.pid)) problems.push(`process ${p.name} (pid ${p.pid}) is still running`);
  // A process killed a moment ago can leave its listener closing briefly.
  const end = Date.now() + 5_000;
  let busy = Object.entries(state.ports).filter(([, port]) => portInUse(port));
  while (busy.length > 0 && Date.now() < end) {
    await sleep(200);
    busy = busy.filter(([, port]) => portInUse(port));
  }
  for (const [n, port] of busy) problems.push(`port ${port} (${n}) is still listening`);
  // Anything else started from the directory (a crashed child re-parented to init).
  const stray = spawnSync('pgrep', ['-f', state.dir], { encoding: 'utf8' }).stdout.trim();
  if (stray !== '') problems.push(`processes still reference ${state.dir}: ${stray.split('\n').join(', ')}`);
  if (problems.length === 0) {
    if (opts.keepDirOnError) log(`logs kept in ${state.dir}`);
    else rmSync(state.dir, { recursive: true, force: true });
    rmSync(stateFile, { force: true });
  }
  return problems;
}

/** For `status`: which recorded processes are alive. */
export function status(): string {
  const s = readState();
  if (!s) return 'no oracle is running';
  const lines = [`server ${s.server}`, `kubeconfig ${s.kubeconfig}`, `dir ${s.dir}`];
  for (const p of s.processes) lines.push(`${p.name.padEnd(24)} pid ${p.pid} ${alive(p.pid) ? 'running' : 'not running'}`);
  return lines.join('\n');
}


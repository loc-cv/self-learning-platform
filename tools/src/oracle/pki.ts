// Certificates and kubeconfigs for the throwaway control plane, generated with the workstation's
// openssl. Names follow kubeadm's (cmd/kubeadm/app/phases/certs, kubeconfig) so that identities
// visible in captured output (users, groups, leader election) match a kubeadm cluster.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CLUSTER } from './topology.ts';

function openssl(dir: string, args: string[]): void {
  execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
}

function key(dir: string, name: string): void {
  openssl(dir, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}.key`]);
}

/** A certificate signed by the cluster CA. */
function cert(dir: string, name: string, subject: string, ext: string): void {
  key(dir, name);
  openssl(dir, ['req', '-new', '-key', `${name}.key`, '-subj', subject, '-out', `${name}.csr`]);
  writeFileSync(path.join(dir, `${name}.ext`), ext);
  openssl(dir, [
    'x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
    '-days', '30', '-sha256', '-extfile', `${name}.ext`, '-out', `${name}.crt`,
  ]);
}

const clientExt = 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n';

/** Client identities, as kubeadm names them (constants.go: AdminKubeConfigFileName, …). */
export const IDENTITIES = {
  // kubeadm >= 1.29: admin.conf is in group kubeadm:cluster-admins, bound to cluster-admin.
  admin: '/O=kubeadm:cluster-admins/CN=kubernetes-admin',
  'super-admin': '/O=system:masters/CN=kubernetes-super-admin',
  'controller-manager': '/CN=system:kube-controller-manager',
  scheduler: '/CN=system:kube-scheduler',
  // KWOK plays every kubelet. Not a kubeadm identity; it never appears in captured output.
  kwok: '/O=system:masters/CN=kwok',
} as const;
export type Identity = keyof typeof IDENTITIES;

export function generatePki(dir: string): void {
  key(dir, 'ca');
  openssl(dir, ['req', '-x509', '-new', '-key', 'ca.key', '-subj', '/CN=kubernetes', '-days', '30', '-sha256', '-out', 'ca.crt']);
  const sans = [
    'DNS:kubernetes', 'DNS:kubernetes.default', 'DNS:kubernetes.default.svc', 'DNS:kubernetes.default.svc.cluster.local',
    `DNS:${CLUSTER.controlPlaneName}`, `IP:${CLUSTER.kubernetesServiceIP}`, `IP:${CLUSTER.advertiseAddress}`, 'IP:127.0.0.1',
  ];
  cert(dir, 'apiserver', '/CN=kube-apiserver', `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${sans.join(',')}\n`);
  for (const [name, subject] of Object.entries(IDENTITIES)) cert(dir, name, subject, clientExt);
  // Service account token signing key pair (kubeadm: sa.key, sa.pub).
  openssl(dir, ['genrsa', '-out', 'sa.key', '2048']);
  openssl(dir, ['rsa', '-in', 'sa.key', '-pubout', '-out', 'sa.pub']);
}

/** A kubeconfig like kubeadm's admin.conf: same names, credentials embedded as data. */
export function writeKubeconfig(dir: string, file: string, who: Identity, server: string): string {
  const user = who === 'admin' ? 'kubernetes-admin' : who === 'super-admin' ? 'kubernetes-super-admin' : `system:${who}`;
  const p = path.join(dir, file);
  const b64 = (f: string) => readFileSync(path.join(dir, f)).toString('base64');
  writeFileSync(
    p,
    `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${b64('ca.crt')}
    server: ${server}
  name: kubernetes
contexts:
- context:
    cluster: kubernetes
    user: ${user}
  name: ${user}@kubernetes
current-context: ${user}@kubernetes
kind: Config
users:
- name: ${user}
  user:
    client-certificate-data: ${b64(`${who}.crt`)}
    client-key-data: ${b64(`${who}.key`)}
`,
  );
  return p;
}

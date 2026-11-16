// Image references, pull outcomes, sizes and the files an image offers its processes.

import { describe, expect, test } from 'vitest';
import { IMAGE_CATALOG } from './catalog.data.ts';
import { imageSize, pullOutcome } from './catalog.ts';
import { imageView } from './files.ts';
import { parseImageName, type ImageName } from './reference.ts';

const parsed = (s: string): ImageName => parseImageName(s) as ImageName;
const image = (repo: string, tag: string) => {
  const i = IMAGE_CATALOG.find((x) => x.repository === repo && x.tags.includes(tag));
  if (!i) throw new Error(`${repo}:${tag} not captured`);
  return i;
};

describe('image references (distribution/reference via ParseImageName)', () => {
  test.each([
    ['nginx', { domain: 'docker.io', path: 'library/nginx', repository: 'docker.io/library/nginx', tag: 'latest' }],
    ['nginx:1.29', { domain: 'docker.io', path: 'library/nginx', repository: 'docker.io/library/nginx', tag: '1.29' }],
    ['bitnami/redis:7', { domain: 'docker.io', path: 'bitnami/redis', repository: 'docker.io/bitnami/redis', tag: '7' }],
    ['index.docker.io/library/busybox', { domain: 'docker.io', path: 'library/busybox', repository: 'docker.io/library/busybox', tag: 'latest' }],
    ['registry.k8s.io/pause:3.10.1', { domain: 'registry.k8s.io', path: 'pause', repository: 'registry.k8s.io/pause', tag: '3.10.1' }],
    ['localhost:5000/team/app:v1', { domain: 'localhost:5000', path: 'team/app', repository: 'localhost:5000/team/app', tag: 'v1' }],
  ])('%s', (s, want) => {
    expect(parseImageName(s)).toEqual(want);
  });

  test.each([
    ['Nginx', 'couldn\'t parse image name "Nginx": invalid reference format: repository name (library/Nginx) must be lowercase'],
    ['nginx:', 'couldn\'t parse image name "nginx:": invalid reference format'],
    ['nginx::1', 'couldn\'t parse image name "nginx::1": invalid reference format'],
    ['-nginx', 'couldn\'t parse image name "-nginx": invalid reference format'],
  ])('%s is rejected', (s, error) => {
    expect(parseImageName(s)).toEqual({ error });
  });
});

describe('pull outcomes, as containerd 1.7.28 reports them', () => {
  test('a captured tag resolves to its image', () => {
    const r = pullOutcome(parsed('nginx:1.29'));
    expect('ok' in r && r.ok.repository).toBe('docker.io/library/nginx');
  });

  test('a tag the registry does not have: NotFound, with the gRPC prefix the kubelet keeps', () => {
    expect(pullOutcome(parsed('nginx:1.299'))).toEqual({
      kind: 'not-found',
      error: 'rpc error: code = NotFound desc = failed to pull and unpack image "docker.io/library/nginx:1.299": failed to resolve reference "docker.io/library/nginx:1.299": docker.io/library/nginx:1.299: not found',
    });
  });

  test('a repository that is not an official image: pull access denied', () => {
    expect(pullOutcome(parsed('ngnix'))).toEqual({
      kind: 'denied',
      error: 'failed to pull and unpack image "docker.io/library/ngnix:latest": failed to resolve reference "docker.io/library/ngnix:latest": pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed',
    });
  });

  test('a registry under a reserved domain does not resolve', () => {
    expect(pullOutcome(parsed('registry.example/shop/api:2'))).toEqual({
      kind: 'no-such-host',
      error: 'failed to pull and unpack image "registry.example/shop/api:2": failed to resolve reference "registry.example/shop/api:2": failed to do request: Head "https://registry.example/v2/shop/api/manifests/2": dial tcp: lookup registry.example on 127.0.0.53:53: no such host',
    });
  });

  test('what the catalog cannot answer for is not invented', () => {
    expect(pullOutcome(parsed('python:3.12'))).toEqual({ notSimulated: "image docker.io/library/python:3.12 is not in the simulator's image catalog" });
    expect(pullOutcome(parsed('nginx:1.24'))).toEqual({ notSimulated: "image docker.io/library/nginx:1.24 exists but is not in the simulator's image catalog" });
    expect(pullOutcome(parsed('registry.k8s.io/kube-apiserver:v1.20.0'))).toEqual({ notSimulated: "image registry.k8s.io/kube-apiserver:v1.20.0 exists but is not in the simulator's image catalog" });
    expect(pullOutcome(parsed('quay.io/prometheus/prometheus'))).toHaveProperty('notSimulated');
  });

  test('the size containerd reports: index, one manifest, config, compressed layers', () => {
    const i = image('docker.io/library/nginx', 'latest');
    expect(imageSize(i)).toBe((i.index?.size ?? 0) + i.manifest.size + i.config.size + i.layers.reduce((a, l) => a + l.size, 0));
  });
});

describe('executables in an image', () => {
  const path: [string, string][] = [['PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']];

  test('BusyBox applets behave as the name they are called by', () => {
    const v = imageView(image('docker.io/library/busybox', '1.36').config.digest);
    expect(v.which(path, 'sh')).toEqual({ path: '/bin/sh', model: 'sh', variant: 'busybox' });
    expect(v.which(path, 'sleep')).toEqual({ path: '/bin/sleep', model: 'sleep', variant: 'busybox' });
    expect(v.which(path, 'wget')).toEqual({ path: '/bin/wget', model: 'unmodeled', variant: 'busybox' });
    expect(v.which(path, 'bash')).toBeUndefined();
  });

  test('Debian images: /bin/sh is dash through /bin → /usr/bin; coreutils are GNU', () => {
    const v = imageView(image('docker.io/library/nginx', 'latest').config.digest);
    expect(v.which(path, '/bin/sh')).toEqual({ path: '/bin/sh', model: 'sh', variant: 'dash' });
    expect(v.which(path, 'sleep')).toEqual({ path: '/usr/bin/sleep', model: 'sleep', variant: 'gnu' });
    expect(v.which(path, 'nginx')).toEqual({ path: '/usr/sbin/nginx', model: 'nginx', variant: 'nginx' });
    expect(v.which(path, '/docker-entrypoint.sh')).toEqual({ path: '/docker-entrypoint.sh', model: 'nginx-entrypoint', variant: 'script' });
    expect(v.which([['PATH', '/nowhere']], 'nginx')).toBeUndefined();
  });

  test('distroless images have only their binaries', () => {
    const v = imageView(image('registry.k8s.io/pause', '3.10.1').config.digest);
    expect(v.which(path, '/pause')).toEqual({ path: '/pause', model: 'pause', variant: 'pause' });
    expect(v.which(path, 'sh')).toBeUndefined();
  });
});

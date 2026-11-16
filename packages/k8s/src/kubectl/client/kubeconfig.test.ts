// kubeconfig resolution against what the real kubectl v1.37.2 printed on this workstation
// (2026-11-16) for the same files and flags; error texts as CheckErr prints them.

import { describe, expect, test } from 'vitest';
import type { Json } from '@simlab/kernel';
import { errorMessage } from '../cli/errors.ts';
import { clientConfig, decodeKubeconfig, loadKubeconfig, type KubeconfigFile, type Overrides } from './kubeconfig.ts';

function decoded(doc: Json): KubeconfigFile {
  const r = decodeKubeconfig(doc);
  if ('error' in r || 'notSimulated' in r) throw new Error(JSON.stringify(r));
  return r;
}

const FILE: KubeconfigFile = decoded({
  apiVersion: 'v1',
  kind: 'Config',
  'current-context': 'kubernetes-admin@kubernetes',
  clusters: [{ name: 'kubernetes', cluster: { server: 'https://172.16.0.10:6443' } }],
  contexts: [
    { name: 'kubernetes-admin@kubernetes', context: { cluster: 'kubernetes', user: 'kubernetes-admin' } },
    { name: 'broken', context: { cluster: 'nocluster', user: 'kubernetes-admin' } },
    { name: 'dev', context: { cluster: 'kubernetes', user: 'kubernetes-admin', namespace: 'dev' } },
  ],
  users: [{ name: 'kubernetes-admin', user: {} }],
});

const resolve = (o: Overrides, file = FILE) => {
  const r = clientConfig(file, o);
  return 'type' in r ? errorMessage(r).text : r;
};

describe('client configuration', () => {
  test('the current context', () => {
    expect(resolve({})).toMatchObject({ server: 'https://172.16.0.10:6443', namespace: 'default', explicitNamespace: false });
    expect(resolve({ context: 'dev' })).toMatchObject({ namespace: 'dev' });
    expect(resolve({ context: 'dev', namespace: 'x' })).toMatchObject({ namespace: 'x', explicitNamespace: true });
  });
  test('no kubeconfig: http://localhost:8080', () => {
    expect(resolve({}, decoded({}))).toMatchObject({ server: 'http://localhost:8080', namespace: 'default' });
  });
  test('a context whose cluster is missing falls back to the default server', () => {
    expect(resolve({ context: 'broken' })).toMatchObject({ server: 'http://localhost:8080' });
  });
  test('names that match nothing', () => {
    expect(resolve({ context: 'nosuch' })).toBe('Error in configuration: context was not found for specified context: nosuch\n');
    expect(resolve({ cluster: 'nosuch' })).toBe('error: no server found for cluster "nosuch"\n');
    expect(resolve({ user: 'nosuch' })).toBe('error: auth info "nosuch" does not exist\n');
    expect(resolve({ cluster: 'nosuch', namespace: 'x' })).toBe('error: cluster "nosuch" does not exist\n');
    expect(resolve({ context: 'nosuch', namespace: 'x' })).toBe('error: context "nosuch" does not exist\n');
    expect(resolve({ context: 'nosuch', user: 'nosuch' })).toBe('Error in configuration: context was not found for specified context: nosuch\n');
    expect(resolve({ context: 'nosuch', cluster: 'nosuch' })).toBe(
      'Error in configuration: \n* context was not found for specified context: nosuch\n* no server found for cluster "nosuch"\n',
    );
  });
  test('--server overrides the cluster', () => {
    expect(resolve({ server: '127.0.0.1:2' })).toMatchObject({ server: '127.0.0.1:2' });
  });
});

describe('loading', () => {
  const files: Record<string, string> = { '/a': 'A', '/b': 'B' };
  const docs: Record<string, object> = {
    A: { 'current-context': 'a', clusters: [{ name: 'c', cluster: { server: 'https://a:1' } }] },
    B: { 'current-context': 'b', clusters: [{ name: 'c', cluster: { server: 'https://b:1' } }, { name: 'd', cluster: { server: 'https://b:2' } }] },
  };
  const read = (p: string) => files[p] ?? { missing: true as const };
  const parse = (t: string) => ({ value: docs[t] as never });
  test('KUBECONFIG: the first file wins for every entry and scalar; missing files are skipped', () => {
    const cfg = loadKubeconfig(read, parse, { KUBECONFIG: '/missing:/a:/b' }, '/root', undefined) as KubeconfigFile;
    expect(cfg.currentContext).toBe('a');
    expect(cfg.clusters).toEqual({ c: { server: 'https://a:1' }, d: { server: 'https://b:2' } });
  });
  test('--kubeconfig naming a missing file', () => {
    const r = loadKubeconfig(read, parse, {}, '/root', '/nonexistent');
    expect('type' in r ? errorMessage(r).text : r).toBe('error: stat /nonexistent: no such file or directory\n');
  });
  test('a broken file is reported with its path; a later file does not hide it (config/broken-kubeconfig.yaml)', () => {
    const texts: Record<string, string> = { '/dup': 'DUP', '/num': 'NUM', '/a': 'A' };
    const bad: Record<string, object> = {
      ...docs,
      DUP: { clusters: [{ name: 'c', cluster: { server: 'https://a:1' } }, { name: 'c' }] },
      NUM: { clusters: 3 },
    };
    const readAll = (p: string) => (p === '/file/config' ? { error: 'open /file/config: not a directory' } : (texts[p] ?? { missing: true as const }));
    const parseAll = (t: string) => ({ value: bad[t] as never });
    const text = (env: Record<string, string>, explicit?: string) => {
      const r = loadKubeconfig(readAll, parseAll, env, '/root', explicit);
      return 'type' in r ? errorMessage(r).text : r;
    };
    expect(text({}, '/dup')).toBe(
      'error: error loading config file "/dup": error converting *[]NamedCluster into *map[string]*api.Cluster: duplicate name "c" in list: [{c {https://a:1  false  []  false []}} {c {  false  []  false []}}]\n',
    );
    expect(text({ KUBECONFIG: '/a:/num' })).toBe('error: error loading config file "/num": json: cannot unmarshal number into Go struct field Config.clusters of type []v1.NamedCluster\n');
    expect(text({ KUBECONFIG: '/file/config' })).toBe('error: error loading config file "/file/config": open /file/config: not a directory\n');
    expect(text({}, '/file/config')).toBe('error: error loading config file "/file/config": open /file/config: not a directory\n');
  });
  test('no file at all is an empty configuration', () => {
    expect(loadKubeconfig(read, parse, {}, '/root', undefined)).toEqual({ clusters: {}, contexts: {}, users: {}, currentContext: '' });
  });
});

// The kubeconfig codec: what clientcmd.Load keeps of a file and how clientcmd.Write serializes it.
// Expected texts: fixtures/golden/v1.37.2/config/contexts.yaml and view.yaml (the files after a
// write, the decode errors), and the real binary on the cases noted.

import { describe, expect, test } from 'vitest';
import { parseYaml } from '../printing.ts';
import { decodeConfig, newConfig, toV1, type Config } from '../../client/kubeconfigmodel.ts';
import { serialize } from './modify.ts';

function load(text: string, origin = '/root/.kube/config') {
  const r = parseYaml(text);
  if (!('value' in r)) throw new Error('bad yaml');
  return decodeConfig(r.value, origin);
}

function config(text: string): Config {
  const r = load(text);
  if (!('config' in r)) throw new Error(JSON.stringify(r));
  return r.config;
}

describe('serialize', () => {
  test('an empty config', () => {
    // contexts.yaml: a file created by set-context in an empty KUBECONFIG list, minus its context
    expect(serialize(newConfig())).toBe('apiVersion: v1\nclusters: null\ncontexts: null\ncurrent-context: ""\nkind: Config\nusers: null\n');
  });

  test('comments, unknown fields and empty preferences are dropped; lists are sorted by name', () => {
    const c = config(`# a comment
apiVersion: v1
kind: Config
preferences: {}
clusters:
- name: staging
  cluster:
    server: https://10.0.0.5:6443
- name: kubernetes
  cluster:
    certificate-authority-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCg==
    server: https://172.16.0.10:6443
    unknown-field: dropped
contexts:
- name: b
  context: {cluster: kubernetes, user: u, namespace: team-a}
- name: a
  context: {user: u}
current-context: a
users:
- name: u
  user:
    token: abc123
`);
    expect(serialize(c)).toBe(`apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCg==
    server: https://172.16.0.10:6443
  name: kubernetes
- cluster:
    server: https://10.0.0.5:6443
  name: staging
contexts:
- context:
    cluster: ""
    user: u
  name: a
- context:
    cluster: kubernetes
    namespace: team-a
    user: u
  name: b
current-context: a
kind: Config
users:
- name: u
  user:
    token: abc123
`);
  });

  test('every cluster and user field, in the v1 JSON order', () => {
    const c = config(`clusters:
- name: c
  cluster:
    disable-compression: true
    proxy-url: http://proxy:3128
    certificate-authority: ca.crt
    insecure-skip-tls-verify: true
    tls-server-name: api
    server: https://x
users:
- name: u
  user:
    password: p
    username: admin
    as-user-extra: {scopes: [a, b], none: null}
    as-groups: [g1, g2]
    as-uid: "1"
    as: jane
    tokenFile: /t
    client-key: k
    client-certificate: c
`);
    expect(Object.keys((toV1(c).clusters as { cluster: object }[])[0]?.cluster ?? {})).toStrictEqual([
      'server',
      'tls-server-name',
      'insecure-skip-tls-verify',
      'certificate-authority',
      'proxy-url',
      'disable-compression',
    ]);
    const user = (toV1(c).users as { user: Record<string, unknown> }[])[0]?.user ?? {};
    expect(Object.keys(user)).toStrictEqual(['client-certificate', 'client-key', 'tokenFile', 'as', 'as-uid', 'as-groups', 'as-user-extra', 'username', 'password']);
    expect(user['as-user-extra']).toStrictEqual({ none: null, scopes: ['a', 'b'] });
  });

  test('an empty []byte is kept as non-nil but omitted', () => {
    const c = config('users:\n- name: u\n  user:\n    client-key-data: ""\n');
    expect(c.users.u?.value.clientKeyData).toBe('');
    expect((toV1(c).users as { user: object }[])[0]?.user).toStrictEqual({});
  });

  test('preferences with colors are written', () => {
    const c = config('preferences: {colors: true}\n');
    expect(toV1(c).preferences).toStrictEqual({ colors: true });
  });

  test('entries remember their file', () => {
    const c = config('contexts:\n- name: a\n  context: {cluster: x}\n');
    expect(c.contexts.a?.origin).toBe('/root/.kube/config');
  });
});

describe('decode errors', () => {
  const error = (text: string) => {
    const r = load(text);
    return 'error' in r ? r.error : 'notSimulated' in r ? `notSimulated: ${r.notSimulated}` : 'ok';
  };

  test('type errors name the innermost struct and the field path (view.yaml)', () => {
    expect(error('clusters: 5\n')).toBe('json: cannot unmarshal number into Go struct field Config.clusters of type []v1.NamedCluster');
    // clusters sort before contexts and users: their error is the first
    expect(error('contexts:\n- name: c\n  context:\n    cluster: 5\nusers:\n- name: 7\nclusters:\n- name: s\n  cluster:\n    insecure-skip-tls-verify: "yes"\n')).toBe(
      'json: cannot unmarshal string into Go struct field Cluster.clusters.cluster.insecure-skip-tls-verify of type bool',
    );
    expect(error('contexts:\n- name: c\n  context:\n    cluster: 5\nusers:\n- name: 7\n')).toBe('json: cannot unmarshal number into Go struct field Context.contexts.context.cluster of type string');
    expect(error('users:\n- name: 7\n')).toBe('json: cannot unmarshal number into Go struct field NamedAuthInfo.users.name of type string');
    expect(error('users:\n- name: u\n  user:\n    as-groups: x\n')).toBe('json: cannot unmarshal string into Go struct field AuthInfo.users.user.as-groups of type []string');
  });

  test('a wrong kind or version (view.yaml)', () => {
    expect(error('apiVersion: v1\nkind: Foo\n')).toBe('no kind "Foo" is registered for version "v1" in scheme "k8s.io/client-go/tools/clientcmd/api/latest/latest.go:50"');
    expect(error('apiVersion: v2\n')).toBe('no kind "Config" is registered for version "v2" in scheme "k8s.io/client-go/tools/clientcmd/api/latest/latest.go:50"');
  });

  test('a document that is not a mapping, or whose apiVersion or kind is not a string (the binary)', () => {
    const struct = 'struct { APIVersion string "json:\\"apiVersion,omitempty\\""; Kind string "json:\\"kind,omitempty\\"" }';
    expect(error('hello\n')).toBe(`couldn't get version/kind; json parse error: json: cannot unmarshal string into Go value of type ${struct}`);
    expect(error('- a\n')).toBe(`couldn't get version/kind; json parse error: json: cannot unmarshal array into Go value of type ${struct}`);
    expect(error('kind: [a]\napiVersion: true\n')).toBe("couldn't get version/kind; json parse error: json: cannot unmarshal bool into Go struct field .apiVersion of type string");
    expect(error('# only a comment\n')).toBe('ok');
  });

  test('bad base64 (view.yaml)', () => {
    expect(error('users:\n- name: u\n  user:\n    client-key-data: abc!\n')).toBe('illegal base64 data at input byte 3');
  });

  test('what the simulator does not model prints a notice', () => {
    expect(error('users:\n- name: u\n  user:\n    exec: {command: x}\n')).toBe('notSimulated: exec credentials in a kubeconfig user');
    // a repeated name in a list whose %v would print the exec pointer
    expect(error('users:\n- name: u\n  user:\n    exec: {command: x}\n- name: u\n')).toBe(
      'notSimulated: a kubeconfig whose users repeat the name "u" and hold exec, auth-provider or extensions',
    );
  });

  test('a repeated name is a conversion error that prints the v1 list (config/broken-kubeconfig.yaml)', () => {
    expect(
      error(
        'clusters:\n- name: c\n  cluster:\n    server: https://a:1\n    certificate-authority-data: aGk=\n- name: d\n  cluster:\n    server: https://b:1\n    insecure-skip-tls-verify: true\n- name: c\n  cluster:\n    server: https://c:1\n',
      ),
    ).toBe(
      'error converting *[]NamedCluster into *map[string]*api.Cluster: duplicate name "c" in list: [{c {https://a:1  false  [104 105]  false []}} {d {https://b:1  true  []  false []}} {c {https://c:1  false  []  false []}}]',
    );
    // users convert before contexts
    expect(
      error('contexts:\n- name: u\n- name: u\nusers:\n- name: u\n  user: {token: t, as-groups: [g1, g2], as-user-extra: {b: [yy], a: [x, z]}, client-key-data: aGk=}\n- name: u\n  user: {}\n'),
    ).toBe(
      'error converting *[]NamedAuthInfo into *map[string]*api.AuthInfo: duplicate name "u" in list: [{u { []  [104 105] t    [g1 g2] map[a:[x z] b:[yy]]   <nil> <nil> []}} {u { []  []     [] map[]   <nil> <nil> []}}]',
    );
    expect(error('contexts:\n- name: a\n  context: {cluster: k, namespace: ns}\n- name: a\n')).toBe(
      'error converting *[]NamedContext into *map[string]*api.Context: duplicate name "a" in list: [{a {k  ns []}} {a {   []}}]',
    );
    // a null element is the zero struct, named ""
    expect(error('clusters:\n- null\n- name: ""\n  cluster: {server: https://z:1}\n')).toBe(
      'error converting *[]NamedCluster into *map[string]*api.Cluster: duplicate name "" in list: [{ {  false  []  false []}} { {https://z:1  false  []  false []}}]',
    );
  });

  test('null leaves a field as it is', () => {
    expect(error('clusters: null\ncurrent-context: null\nusers:\n- name: u\n  user: null\n')).toBe('ok');
  });
});

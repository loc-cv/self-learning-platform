// Cases from upstream: pkg/api/pod/warnings_test.go TestWarnings and TestTemplateOnlyWarnings,
// written as versioned JSON. Upstream compares the warnings as sorted lists; so do these, and a
// few cases check the order of warningsForPodSpecAndMeta too.

import { describe, expect, it } from 'vitest';
import { newPath } from '../../../apimachinery/field.ts';
import type { JsonObject } from '../../../apimachinery/json.ts';
import { getWarningsForPod, getWarningsForPodTemplate } from './podwarnings.ts';

const sorted = (xs: string[]): string[] => [...xs].sort();

function pod(spec: JsonObject, metadata: JsonObject = {}): JsonObject {
  return { metadata, spec };
}

/** The env list of the "duplicate env" case: the last entry does not warn. */
const envs = (n: string): JsonObject[] => [
  { name: n, value: n },
  { name: n, value: n },
  { name: n, value: 'other' },
  { name: n, value: '' },
  { name: n, value: `$(${n})` },
  { name: n, valueFrom: {} },
  { name: n, value: `$(${n}) $(${n})` },
];

const CASES: { name: string; spec: JsonObject; metadata?: JsonObject; expected: string[] }[] = [
  { name: 'null', spec: {}, expected: [] },
  { name: 'photon', spec: { volumes: [{ name: 'p', photonPersistentDisk: { pdID: 'x' } }] }, expected: ['spec.volumes[0].photonPersistentDisk: deprecated in v1.11, non-functional in v1.16+'] },
  { name: 'gitRepo plugin disabled', spec: { volumes: [{ name: 'g', gitRepo: { repository: 'r' } }] }, expected: ['spec.volumes[0].gitRepo: deprecated in v1.11, and disabled by default in v1.33+'] },
  { name: 'storageOS', spec: { volumes: [{ name: 's', storageos: { volumeName: 'v' } }] }, expected: ['spec.volumes[0].storageOS: deprecated in v1.22, non-functional in v1.25+'] },
  { name: 'rbd', spec: { volumes: [{ name: 'r', rbd: { monitors: ['m'], image: 'i' } }] }, expected: ['spec.volumes[0].rbd: deprecated in v1.28, non-functional in v1.31+'] },
  {
    name: 'overlapping paths in a configmap volume',
    spec: { volumes: [{ name: 'Test', configMap: { name: 'foo', items: [{ key: 'foo', path: 'test' }, { key: 'bar', path: 'test' }] } }] },
    expected: ['volume "Test" (ConfigMap "foo"): overlapping paths: "test" with "test"'],
  },
  {
    name: 'overlapping paths in a configmap volume - try to mount dir path into a file',
    spec: { volumes: [{ name: 'Test', configMap: { name: 'foo', items: [{ key: 'foo', path: 'test' }, { key: 'bar', path: 'test/app' }] } }] },
    expected: ['volume "Test" (ConfigMap "foo"): overlapping paths: "test/app" with "test"'],
  },
  {
    name: 'overlapping paths in a projected volume - service account and config',
    spec: {
      volumes: [
        {
          name: 'foo',
          projected: { sources: [{ configMap: { name: 'Test', items: [{ key: 'foo', path: 'test' }] } }, { serviceAccountToken: { path: 'test' } }] },
        },
      ],
    },
    expected: ['volume "foo" (Projected): overlapping paths: "test" (ServiceAccountToken) with "test" (ConfigMap "Test")'],
  },
  {
    name: 'empty sources in projected volume',
    spec: { volumes: [{ name: 'foo', projected: { sources: [{}] } }] },
    expected: ['volume "foo" (Projected) has no sources provided'],
  },
  {
    name: 'duplicate hostAlias',
    spec: { hostAliases: [{ ip: '1.1.1.1' }, { ip: '1.1.1.1' }, { ip: '1.1.1.1' }] },
    expected: ['spec.hostAliases[1].ip: duplicate ip "1.1.1.1"', 'spec.hostAliases[2].ip: duplicate ip "1.1.1.1"'],
  },
  {
    name: 'duplicate imagePullSecret',
    spec: { imagePullSecrets: [{ name: 'a' }, { name: 'a' }, { name: 'a' }, { name: 'b' }] },
    expected: ['spec.imagePullSecrets[1].name: duplicate name "a"', 'spec.imagePullSecrets[2].name: duplicate name "a"'],
  },
  { name: 'empty imagePullSecret', spec: { imagePullSecrets: [{ name: '' }] }, expected: ['spec.imagePullSecrets[0].name: invalid empty name ""'] },
  {
    name: 'duplicate env',
    spec: {
      initContainers: [{ name: 'i', env: envs('a') }],
      containers: [{ name: 'c', env: envs('b') }],
    },
    expected: [1, 2, 3, 4, 5].flatMap((i) => [
      `spec.initContainers[0].env[${i}]: hides previous definition of "a", which may be dropped when using apply`,
      `spec.containers[0].env[${i}]: hides previous definition of "b", which may be dropped when using apply`,
    ]),
  },
  {
    name: 'fractional resources',
    spec: {
      initContainers: [{ name: 'i', resources: { requests: { memory: '4m', 'ephemeral-storage': '4m' }, limits: { memory: '4m', 'ephemeral-storage': '4m' } } }],
      containers: [{ name: 'c', resources: { requests: { memory: '4m', 'ephemeral-storage': '4m' }, limits: { memory: '4m', 'ephemeral-storage': '4m' } } }],
      overhead: { memory: '4m', 'ephemeral-storage': '4m' },
    },
    expected: ['initContainers', 'containers']
      .flatMap((c) =>
        ['requests', 'limits'].flatMap((k) => ['ephemeral-storage', 'memory'].map((r) => `spec.${c}[0].resources.${k}[${r}]: fractional byte value "4m" is invalid, must be an integer`)),
      )
      .concat(['spec.overhead[ephemeral-storage]: fractional byte value "4m" is invalid, must be an integer', 'spec.overhead[memory]: fractional byte value "4m" is invalid, must be an integer']),
  },
  {
    name: 'node labels in nodeSelector',
    spec: { nodeSelector: { 'beta.kubernetes.io/arch': 'true', 'beta.kubernetes.io/os': 'true', 'failure-domain.beta.kubernetes.io/zone': 'true' } },
    expected: [
      'spec.nodeSelector[beta.kubernetes.io/arch]: deprecated since v1.14; use "kubernetes.io/arch" instead',
      'spec.nodeSelector[beta.kubernetes.io/os]: deprecated since v1.14; use "kubernetes.io/os" instead',
      'spec.nodeSelector[failure-domain.beta.kubernetes.io/zone]: deprecated since v1.17; use "topology.kubernetes.io/zone" instead',
    ],
  },
  {
    name: 'node labels in affinity requiredDuringSchedulingIgnoredDuringExecution',
    spec: {
      affinity: {
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: {
            nodeSelectorTerms: [{ matchExpressions: [{ key: 'foo', operator: 'Exists' }, { key: 'beta.kubernetes.io/arch', operator: 'Exists' }] }],
          },
        },
      },
    },
    expected: ['spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[1].key: beta.kubernetes.io/arch is deprecated since v1.14; use "kubernetes.io/arch" instead'],
  },
  {
    name: 'invalid label value in preferred node affinity',
    spec: {
      affinity: {
        nodeAffinity: {
          preferredDuringSchedulingIgnoredDuringExecution: [{ weight: 10, preference: { matchExpressions: [{ key: 'foo', operator: 'In', values: ['bar baz'] }] } }],
        },
      },
    },
    expected: [
      "spec.affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution[0].preference.matchExpressions[0].values[0]: bar baz is invalid, a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyValue',  or 'my_value',  or '12345', regex used for validation is '(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?')",
    ],
  },
  {
    name: 'node labels in topologySpreadConstraints',
    spec: { topologySpreadConstraints: [{ topologyKey: 'beta.kubernetes.io/arch', labelSelector: {} }] },
    expected: ['spec.topologySpreadConstraints[0].topologyKey: beta.kubernetes.io/arch is deprecated since v1.14; use "kubernetes.io/arch" instead'],
  },
  {
    name: 'annotations',
    metadata: {
      annotations: {
        foo: 'bar',
        'scheduler.alpha.kubernetes.io/critical-pod': 'true',
        'seccomp.security.alpha.kubernetes.io/pod': 'default',
        'container.seccomp.security.alpha.kubernetes.io/foo': 'default',
        'security.alpha.kubernetes.io/sysctls': 'a,b,c',
        'security.alpha.kubernetes.io/unsafe-sysctls': 'd,e,f',
      },
    },
    spec: { containers: [{ name: 'foo' }] },
    expected: [
      'metadata.annotations[scheduler.alpha.kubernetes.io/critical-pod]: non-functional in v1.16+; use the "priorityClassName" field instead',
      'metadata.annotations[seccomp.security.alpha.kubernetes.io/pod]: non-functional in v1.27+; use the "seccompProfile" field instead',
      'metadata.annotations[container.seccomp.security.alpha.kubernetes.io/foo]: non-functional in v1.27+; use the "seccompProfile" field instead',
      'metadata.annotations[security.alpha.kubernetes.io/sysctls]: non-functional in v1.11+; use the "sysctls" field instead',
      'metadata.annotations[security.alpha.kubernetes.io/unsafe-sysctls]: non-functional in v1.11+; use the "sysctls" field instead',
    ],
  },
  {
    name: 'seccomp fields',
    metadata: { annotations: { 'seccomp.security.alpha.kubernetes.io/pod': 'default', 'container.seccomp.security.alpha.kubernetes.io/foo': 'default' } },
    spec: { securityContext: { seccompProfile: { type: 'RuntimeDefault' } }, containers: [{ name: 'foo', securityContext: { seccompProfile: { type: 'RuntimeDefault' } } }] },
    expected: [],
  },
  { name: 'negative terminationGracePeriodSeconds', spec: { terminationGracePeriodSeconds: -1 }, expected: ['spec.terminationGracePeriodSeconds: must be >= 0; negative values are invalid and will be treated as 1'] },
  {
    name: 'null LabelSelector in topologySpreadConstraints',
    spec: { topologySpreadConstraints: [{ labelSelector: {} }, { labelSelector: null }] },
    expected: ['spec.topologySpreadConstraints[1].labelSelector: a null labelSelector results in matching no pod'],
  },
  {
    name: 'null LabelSelector in PodAffinity',
    spec: {
      affinity: {
        podAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: [{ labelSelector: {} }, {}],
          preferredDuringSchedulingIgnoredDuringExecution: [{ podAffinityTerm: { labelSelector: {} } }, { podAffinityTerm: {} }],
        },
        podAntiAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: [{ labelSelector: {} }, {}],
          preferredDuringSchedulingIgnoredDuringExecution: [{ podAffinityTerm: { labelSelector: {} } }, { podAffinityTerm: {} }],
        },
      },
    },
    expected: [
      'spec.affinity.podAffinity.requiredDuringSchedulingIgnoredDuringExecution[1].labelSelector: a null labelSelector results in matching no pod',
      'spec.affinity.podAffinity.preferredDuringSchedulingIgnoredDuringExecution[1].podAffinityTerm.labelSelector: a null labelSelector results in matching no pod',
      'spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[1].labelSelector: a null labelSelector results in matching no pod',
      'spec.affinity.podAntiAffinity.preferredDuringSchedulingIgnoredDuringExecution[1].podAffinityTerm.labelSelector: a null labelSelector results in matching no pod',
    ],
  },
  {
    name: 'one container port hostIP set without host port set',
    spec: { containers: [{ name: 'foo', ports: [{ containerPort: 80, protocol: 'UDP', hostIP: '10.0.0.1' }] }] },
    expected: ['spec.containers[0].ports[0]: hostIP set without hostPort: {Name: HostPort:0 ContainerPort:80 Protocol:UDP HostIP:10.0.0.1}'],
  },
  {
    name: 'duplicate container ports with one host port set and one without',
    spec: { containers: [{ name: 'foo', ports: [{ containerPort: 80, protocol: 'UDP', hostPort: 80 }, { containerPort: 80, protocol: 'UDP', hostIP: '10.0.0.1' }] }] },
    expected: [
      'spec.containers[0].ports[1]: hostIP set without hostPort: {Name: HostPort:0 ContainerPort:80 Protocol:UDP HostIP:10.0.0.1}',
      'spec.containers[0].ports[1]: overlapping port definition with spec.containers[0].ports[0]',
    ],
  },
  {
    name: 'duplicate container ports with same host port set and different host IPs (one empty)',
    spec: {
      containers: [
        {
          name: 'foo',
          ports: [
            { containerPort: 80, protocol: 'UDP', hostPort: 80 },
            { containerPort: 80, protocol: 'UDP', hostPort: 80, hostIP: '10.0.0.1' },
            { containerPort: 80, protocol: 'UDP', hostPort: 80, hostIP: '10.0.0.2' },
          ],
        },
      ],
    },
    expected: [
      'spec.containers[0].ports[1]: dangerously ambiguous port definition with spec.containers[0].ports[0]',
      'spec.containers[0].ports[2]: dangerously ambiguous port definition with spec.containers[0].ports[0]',
    ],
  },
  {
    name: 'create duplicate container ports in two containers',
    spec: {
      containers: [
        { name: 'foo1', ports: [{ containerPort: 80, hostPort: 80, protocol: 'UDP' }, { containerPort: 180, hostPort: 80, protocol: 'UDP' }, { containerPort: 80, hostPort: 80, protocol: 'UDP' }] },
        { name: 'foo', ports: [{ containerPort: 80, hostPort: 80, protocol: 'UDP' }, { containerPort: 80, hostPort: 80, protocol: 'UDP' }] },
      ],
    },
    expected: [
      'spec.containers[0].ports[2]: duplicate port definition with spec.containers[0].ports[0]',
      'spec.containers[1].ports[0]: duplicate port definition with spec.containers[0].ports[0]',
      'spec.containers[1].ports[0]: duplicate port definition with spec.containers[0].ports[2]',
      'spec.containers[1].ports[1]: duplicate port definition with spec.containers[0].ports[0]',
      'spec.containers[1].ports[1]: duplicate port definition with spec.containers[0].ports[2]',
      'spec.containers[1].ports[1]: duplicate port definition with spec.containers[1].ports[0]',
    ],
  },
  {
    name: 'create duplicate container ports name in two containers',
    spec: {
      containers: [
        { name: 'foo1', ports: [{ containerPort: 80, name: 'test' }] },
        { name: 'foo', ports: [{ containerPort: 81, name: 'test' }] },
      ],
    },
    expected: ['spec.containers[1].ports[0]: duplicate port name "test" with spec.containers[0].ports[0], services and probes that select ports by name will use spec.containers[0].ports[0]'],
  },
  {
    name: 'non-standard IP addresses',
    spec: { dnsConfig: { nameservers: ['1.2.3.4', '05.06.07.08'] }, hostAliases: [{ ip: '::ffff:1.2.3.4' }] },
    expected: ['spec.dnsConfig.nameservers[1]: non-standard IP address "05.06.07.08" is invalid: use "5.6.7.8"', 'spec.hostAliases[0].ip: non-standard IP address "::ffff:1.2.3.4" is invalid: use "1.2.3.4"'],
  },
  {
    name: 'fractional storage of an ephemeral volume claim template',
    spec: { volumes: [{ name: 'e', ephemeral: { volumeClaimTemplate: { spec: { resources: { requests: { storage: '1500m' } } } } } }] },
    expected: ['spec.volumes[0].ephemeral.volumeClaimTemplate.spec.resources.requests[storage]: fractional byte value "1500m" is invalid, must be an integer'],
  },
];

describe('GetWarningsForPod and GetWarningsForPodTemplate', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const p = pod(c.spec, c.metadata);
      expect(sorted(getWarningsForPod(p))).toEqual(sorted(c.expected));
      const template = getWarningsForPodTemplate(newPath('spec', 'template'), p);
      const prefixed = c.expected.map((w) => (w.startsWith('volume ') ? w : `spec.template.${w}`.replace(/ with spec\./g, ' with spec.template.spec.').replace(/ will use spec\./g, ' will use spec.template.spec.')));
      expect(sorted(template)).toEqual(sorted(prefixed));
    });
  }

  it('warns in the order of warningsForPodSpecAndMeta', () => {
    const p = pod(
      { nodeSelector: { 'beta.kubernetes.io/os': 'linux' }, terminationGracePeriodSeconds: -5, containers: [{ name: 'c', env: [{ name: 'A', value: '1' }, { name: 'A', value: '2' }] }] },
      { annotations: { 'scheduler.alpha.kubernetes.io/critical-pod': '' } },
    );
    expect(getWarningsForPod(p)).toEqual([
      'spec.nodeSelector[beta.kubernetes.io/os]: deprecated since v1.14; use "kubernetes.io/os" instead',
      'metadata.annotations[scheduler.alpha.kubernetes.io/critical-pod]: non-functional in v1.16+; use the "priorityClassName" field instead',
      'spec.containers[0].env[1]: hides previous definition of "A", which may be dropped when using apply',
      'spec.terminationGracePeriodSeconds: must be >= 0; negative values are invalid and will be treated as 1',
    ]);
  });

  // TestTemplateOnlyWarnings: the AppArmor annotation warns for templates only, unless the pod's
  // profile is the one the annotation names.
  it('warns about the AppArmor annotation of a template only', () => {
    const annotations = { 'container.apparmor.security.beta.kubernetes.io/foo': 'unconfined' };
    const p = pod({ containers: [{ name: 'foo' }] }, { annotations });
    expect(getWarningsForPod(p)).toEqual([]);
    expect(getWarningsForPodTemplate(newPath('template'), p)).toEqual([
      'template.metadata.annotations[container.apparmor.security.beta.kubernetes.io/foo]: deprecated since v1.30; use the "appArmorProfile" field instead',
    ]);
    const matching = pod({ securityContext: { appArmorProfile: { type: 'Unconfined' } }, containers: [{ name: 'foo' }] }, { annotations });
    expect(getWarningsForPodTemplate(newPath('template'), matching)).toEqual([]);
    const withField = pod({ containers: [{ name: 'foo', securityContext: { appArmorProfile: { type: 'RuntimeDefault' } } }] }, { annotations });
    expect(getWarningsForPodTemplate(newPath('template'), withField)).toEqual([]);
  });
});

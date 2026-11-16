// Provenance of the generators' output units: kubectl run, create deployment|namespace|configmap|
// secret generic|service, expose (docs/FIDELITY.md §3).

import type { ProvenanceSpec } from '@simlab/kernel';

const G = 'fixtures/golden/v1.37.2';
const CMD = 'staging/src/k8s.io/kubectl/pkg/cmd';

interface VerbSources {
  path: string;
  /** Golden cases that compare this verb's output in the gate. */
  cases: string[];
  /** Upstream functions that build its object and check its input. */
  upstream: string[];
}

const ALL_CASES = ['generate/client', 'generate/create'];

const VERBS: VerbSources[] = [
  { path: 'run', cases: ['generate/run', 'generate/client', 'client/generators', 'errors/validation', 'pods/run'], upstream: [`${CMD}/run/run.go Complete, Validate, createPod, createService, createGeneratedObject`, `${CMD}/util/override_options.go Overrider.Apply`] },
  { path: 'expose', cases: ['generate/expose', 'errors/not-found'], upstream: [`${CMD}/expose/expose.go RunExpose, createService`, 'staging/src/k8s.io/kubectl/pkg/polymorphichelpers/mapbasedselectorforobject.go, canbeexposed.go, portsforobject.go, multiprotocolsforobject.go'] },
  { path: 'create deployment', cases: [...ALL_CASES, 'client/generators', 'client/yaml-output', 'errors/validation'], upstream: [`${CMD}/create/create_deployment.go Complete, Validate, createDeployment, buildPodSpec`] },
  { path: 'create namespace', cases: [...ALL_CASES, 'client/generators'], upstream: [`${CMD}/create/create_namespace.go Complete, Validate, createNamespace`] },
  { path: 'create serviceaccount', cases: ['generate/client', 'generate/create'], upstream: [`${CMD}/create/create_serviceaccount.go Complete, Validate, createServiceAccount`] },
  { path: 'create configmap', cases: [...ALL_CASES, 'client/generators', 'client/yaml-output'], upstream: [`${CMD}/create/create_configmap.go createConfigMap`, 'staging/src/k8s.io/kubectl/pkg/util/util.go ParseFileSource, ParseLiteralSource', 'staging/src/k8s.io/kubectl/pkg/util/hash/hash.go ConfigMapHash'] },
  { path: 'create secret generic', cases: [...ALL_CASES, 'client/generators'], upstream: [`${CMD}/create/create_secret.go createSecret`, 'staging/src/k8s.io/kubectl/pkg/util/hash/hash.go SecretHash'] },
  ...['clusterip', 'nodeport', 'loadbalancer', 'externalname'].map((t) => ({
    path: `create service ${t}`,
    cases: [...ALL_CASES, 'client/generators'],
    upstream: [`${CMD}/create/create_service.go Validate, createService, parsePorts`],
  })),
];

const fixtures = (cases: string[]): string[] => cases.map((c) => `${G}/${c}.yaml`);

export const GENERATE_UNITS: ProvenanceSpec[] = [
  ...VERBS.flatMap((v): ProvenanceSpec[] => {
    const prefix = `kubectl.${v.path.replace(/ /g, '.')}`;
    return [
      {
        name: `${prefix}.objects`,
        tag: 'golden-verified',
        sources: [...fixtures(v.cases), ...v.upstream, 'staging/src/k8s.io/cli-runtime/pkg/printers/json.go JSONPrinter (typed objects in struct order)'],
        note: 'the generated object with -o yaml|json (and its --save-config annotation)',
      },
      {
        name: `${prefix}.output`,
        tag: 'golden-verified',
        sources: fixtures(v.cases),
        note: '`<kind>[.<group>]/<name> created|exposed[ (dry run)| (server dry run)]`, -o name',
      },
      {
        name: `${prefix}.errors`,
        tag: 'golden-verified',
        sources: [...fixtures(v.cases), ...v.upstream, `${CMD}/create/create.go NameFromCommandArgs`, 'vendor/github.com/spf13/cobra/command.go ValidateRequiredFlags'],
        note: "client-side errors in their upstream order, the refused request, and API errors behind the command's prefix",
      },
    ];
  }),
  {
    name: 'kubectl.create.configmap.env-file-environment',
    tag: 'source-derived',
    sources: ['staging/src/k8s.io/kubectl/pkg/cmd/util/env_file.go processEnvFileLine (os.Getenv for a bare name)'],
    note: "a bare name in an env file takes the value of kubectl's environment (also create secret generic); the golden cases only show an unset name, the oracle's environment differing from the session's",
  },
  {
    name: 'kubectl.create.deployment.container-name-suffix',
    tag: 'source-derived',
    sources: [`${CMD}/create/create_deployment.go sanitizeAndUniquify`, 'staging/src/k8s.io/apimachinery/pkg/util/rand/rand.go String'],
    note: 'an image name with `.` or `_` gives a container name with a random five-character suffix (PRNG stream kubectl.rand)',
  },
];

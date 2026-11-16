// Provenance of kubectl logs's output units (docs/FIDELITY.md §3). What kubectl and the API server
// decide before a kubelet is reached is compared with the oracle; what a kubelet answers is
// source-derived, since the oracle runs KWOK, not kubelets.

import type { ProvenanceSpec } from '@simlab/kernel';

const G = 'fixtures/golden/v1.37.2/logs/before-the-kubelet.yaml';
const LOGS = 'staging/src/k8s.io/kubectl/pkg/cmd/logs/logs.go';
const LFO = 'staging/src/k8s.io/kubectl/pkg/polymorphichelpers/logsforobject.go';

export const LOGS_UNITS: ProvenanceSpec[] = [
  {
    name: 'kubectl.logs.errors',
    tag: 'golden-verified',
    sources: [
      G,
      `${LOGS} Complete, Validate, ToLogOptions, RunLogsContext (--max-log-requests)`,
      'staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go GetPodRunningTimeoutFlag, UsageErrorf',
      'staging/src/k8s.io/kubectl/pkg/util/util.go ParseRFC3339',
      `${LFO} logsForObjectWithClient ("container %s is not valid for pod %s out of: %s", "cannot get the logs from %T: %v")`,
      'staging/src/k8s.io/kubectl/pkg/polymorphichelpers/helpers.go SelectorsForObject, GetPodList ("timed out waiting for the condition")',
    ],
    note: 'argument and flag errors, the builder\'s ("error from server (NotFound): … in namespace …"), the container and selector errors',
  },
  {
    name: 'kubectl.logs.messages',
    tag: 'golden-verified',
    sources: [G, `${LFO} logsForObjectWithClient`, 'staging/src/k8s.io/kubectl/pkg/cmd/util/podcmd/podcmd.go AllContainerNames', `${LOGS} Complete`],
    note: '`Default container name "x" not found in pod y`, `Defaulted container "x" out of: …`, `Found N pods, using pod/x`, `No resources found in <ns> namespace.`',
  },
  {
    name: 'kube-apiserver.pods.log.errors',
    tag: 'golden-verified',
    sources: [G, 'pkg/registry/core/pod/rest/log.go LogREST.Get', 'pkg/apis/core/validation/validation.go ValidatePodLogOptions', 'pkg/registry/core/pod/strategy.go LogLocation, validateContainer'],
    note: 'the Invalid PodLogOptions; a Pod with no node answers with no content. validateContainer\'s BadRequests (reached only by clients other than kubectl, which checks the name first) are source-derived',
  },
  {
    name: 'kube-apiserver.pods.log.dial-error',
    tag: 'source-derived',
    sources: [
      'pkg/kubelet/client/kubelet_client.go GetConnectionInfo',
      'staging/src/k8s.io/apiserver/pkg/registry/generic/rest/streamer.go InputStream',
      'staging/src/k8s.io/apiserver/pkg/endpoints/handlers/responsewriters/status.go ErrorToAPIStatus',
      'staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go StandardErrorMessage',
    ],
    note: '`Error from server: Get "https://<ip>:10250/containerLogs/<ns>/<pod>/<container>?<query>": dial tcp <ip>:10250: connect: connection refused`; the shape was checked against the v1.37.2 oracle (KWOK nodes, which answer `i/o timeout` there), the errno text is Go\'s for a closed port',
  },
  {
    name: 'kubelet.containerLogs.errors',
    tag: 'source-derived',
    sources: [
      'pkg/kubelet/kubelet_pods.go validateContainerLogStatus',
      'pkg/kubelet/kuberuntime/kuberuntime_container.go GetContainerLogs',
      'staging/src/k8s.io/cri-client/pkg/logs/logs.go ReadLogs',
      'staging/src/k8s.io/apiserver/pkg/registry/generic/rest/response_checker.go GenericHttpResponseChecker.Check',
    ],
    note: 'waiting to start (ContainerCreating, "image can\'t be pulled", "trying and failing to pull image"), "previous terminated container … not found", "is terminated", "is not available", "unable to retrieve container logs for …", the log file errors; as BadRequests',
  },
  {
    name: 'kubelet.containerLogs.output',
    tag: 'source-derived',
    sources: [
      'staging/src/k8s.io/cri-client/pkg/logs/logs.go ReadLogs, parseCRILog, logWriter.write (RFC3339NanoFixed timestamps), waitLogs',
      'staging/src/k8s.io/cri-client/pkg/logs/tail.go findTailLineStartIndex',
      'pkg/kubelet/kuberuntime/kuberuntime_logs.go ReadLogs (since)',
    ],
    note: 'the log text with tail, since, limit-bytes and timestamps; with follow, lines as they are written and the end when the container stops',
  },
  {
    name: 'kubectl.logs.output',
    tag: 'source-derived',
    sources: [
      `${LOGS} DefaultConsumeRequest, addPrefixIfNeeded, consumeWithRetry, parallelConsumeRequest`,
      'staging/src/k8s.io/apimachinery/pkg/util/wait/loop.go loopConditionUntilContext ("context deadline exceeded")',
      'staging/src/k8s.io/kubectl/pkg/util/interrupt/interrupt.go (Ctrl-C: status 1)',
    ],
    note: '`[pod/<name>/<container>] ` prefixes, -f retry lines (the error text alone), --ignore-errors\'s `error: …` on standard output, the order of several requests (a Go map)',
  },
];

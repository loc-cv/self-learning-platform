// Provenance of kubectl rollout's output units (docs/FIDELITY.md §3).

import type { ProvenanceSpec } from '@simlab/kernel';

const G = 'fixtures/golden/v1.37.2';
const ROLLOUT = 'staging/src/k8s.io/kubectl/pkg/cmd/rollout';
const HELPERS = 'staging/src/k8s.io/kubectl/pkg/polymorphichelpers';

export const ROLLOUT_UNITS: ProvenanceSpec[] = [
  {
    name: 'kubectl.rollout.status.lines',
    tag: 'golden-verified',
    sources: [`${G}/rollout/history-undo.yaml`, `${G}/rollout/status-output.yaml`, `${G}/deployments/rollout.yaml`, `${G}/controllers/paused.yaml`, `${HELPERS}/rollout_status.go DeploymentStatusViewer.Status`],
    note: 'once settled: `deployment "<name>" successfully rolled out`, and a paused Deployment\'s waiting line',
  },
  {
    name: 'kubectl.rollout.status.progress',
    tag: 'source-derived',
    sources: [`${HELPERS}/rollout_status.go DeploymentStatusViewer.Status`, `${ROLLOUT}/rollout_status.go Run`, 'staging/src/k8s.io/client-go/tools/watch/until.go UntilWithSync'],
    note: 'the Waiting for … lines while a rollout runs, one per event: timing-dependent (FIDELITY §6.9), tested in virtual time (kubectl/cmd/rollout/rollout.test.ts)',
  },
  {
    name: 'kubectl.rollout.status.errors',
    tag: 'golden-verified',
    sources: [
      `${G}/rollout/history-undo.yaml`,
      `${G}/controllers/rollout-stuck.yaml`,
      `${ROLLOUT}/rollout_status.go Validate, Run`,
      `${HELPERS}/rollout_status.go StatusViewerFor, DeploymentStatusViewer.Status`,
      'staging/src/k8s.io/client-go/tools/watch/until.go UntilWithoutRetry, ContextWithOptionalTimeout',
      'staging/src/k8s.io/apimachinery/pkg/util/wait/error.go errInterrupted.Error',
    ],
    note: '"timed out waiting for the condition" and "object has been deleted" are source-derived (timing)',
  },
  {
    name: 'kubectl.rollout.history.output',
    tag: 'golden-verified',
    sources: [`${G}/rollout/history-undo.yaml`, `${G}/deployments/rollout.yaml`, `${ROLLOUT}/rollout_history.go Run`, `${HELPERS}/history.go HistoryViewerFor, ViewHistory, GetHistory, printTemplate`],
    note: 'the REVISION/CHANGE-CAUSE table, --revision with the pod template, -o, the errors; the klog warning for an unparsable revision is source-derived',
  },
  {
    name: 'kubectl.rollout.undo.output',
    tag: 'golden-verified',
    sources: [`${G}/rollout/history-undo.yaml`, `${G}/rollout/pause-restart.yaml`, `${G}/deployments/rollout.yaml`, `${ROLLOUT}/rollout_undo.go RunUndo`, `${HELPERS}/rollback.go DeploymentRollbacker.Rollback, deploymentRevision`],
    note: 'rolled back, skipped rollback, the dry runs, the last-applied warning and the errors; "failed restoring revision" and "failed to retrieve" are source-derived',
  },
  {
    name: 'kubectl.rollout.pause.output',
    tag: 'golden-verified',
    sources: [`${G}/rollout/pause-restart.yaml`, `${G}/rollout/status-output.yaml`, `${G}/controllers/paused.yaml`, `${ROLLOUT}/rollout_pause.go RunPause`, `${HELPERS}/objectpauser.go`],
    note: 'paused, -o, "is already paused", "pausing is not supported", "No resources found"',
  },
  {
    name: 'kubectl.rollout.resume.output',
    tag: 'golden-verified',
    sources: [`${G}/rollout/pause-restart.yaml`, `${G}/rollout/status-output.yaml`, `${G}/controllers/paused.yaml`, `${ROLLOUT}/rollout_resume.go RunResume`, `${HELPERS}/objectresumer.go`],
    note: 'resumed, -o, "is not paused", "resuming is not supported", "No resources found"',
  },
  {
    name: 'kubectl.rollout.restart.output',
    tag: 'golden-verified',
    sources: [`${G}/rollout/pause-restart.yaml`, `${ROLLOUT}/rollout_restart.go RunRestart`, `${HELPERS}/objectrestarter.go`],
    note: 'restarted, the restartedAt annotation (RFC 3339 from the kernel clock), the paused and unsupported errors; "failed to create patch … within the past second" needs two restarts in one second and is source-derived (kubectl/cmd/rollout/rollout.test.ts)',
  },
];

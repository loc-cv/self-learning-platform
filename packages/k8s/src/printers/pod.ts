// The Pod table: READY, STATUS (the "reason" kubectl users know: Running, Pending,
// ContainerCreating, CrashLoopBackOff, Init:0/1, Completed, Terminating …), RESTARTS with the age
// of the last restart, and the wide columns.
// upstream: pkg/printers/internalversion/printers.go printPod, hasPodReadyCondition,
// isPodInitializedConditionTrue, podSuccessConditions, podFailedConditions;
// pkg/api/pod/util.go IsRestartableInitContainer; pkg/api/v1/pod/util.go IsPodPhaseTerminal.

import type { JsonObject } from '../apimachinery/json.ts';
import { since, timestampMicros } from './duration.ts';
import { age, bool, metadata, nameOf, num, obj, objs, str, type GenerateOptions } from './helpers.ts';
import type { TableRow, TableRowCondition } from './types.ts';

// upstream: pkg/util/node/node.go NodeUnreachablePodReason, which the node lifecycle controller
// writes into status.reason of Pods it evicts from an unreachable node
// (pkg/controller/util/node/controller_utils.go SetPodTerminationReason).
const NODE_UNREACHABLE_POD_REASON = 'NodeLost';

const POD_SUCCESS_CONDITIONS: TableRowCondition[] = [{ type: 'Completed', status: 'True', reason: 'Succeeded', message: 'The pod has completed successfully.' }];
const POD_FAILED_CONDITIONS: TableRowCondition[] = [{ type: 'Completed', status: 'True', reason: 'Failed', message: 'The pod failed.' }];

const isRestartableInitContainer = (c: JsonObject | undefined): boolean => c !== undefined && c.restartPolicy === 'Always';

const hasPodReadyCondition = (conditions: JsonObject[]): boolean => conditions.some((c) => c.type === 'Ready' && c.status === 'True');

function isPodInitializedConditionTrue(conditions: JsonObject[]): boolean {
  const c = conditions.find((x) => x.type === 'Initialized');
  return c !== undefined && c.status === 'True';
}

/** The FinishedAt of a container's last termination, in µs; undefined when zero. */
const lastTerminated = (cs: JsonObject): number | undefined => {
  const t = obj(cs.lastState).terminated;
  return t === undefined || t === null ? undefined : timestampMicros(obj(t).finishedAt);
};
// metav1.Time.Before on possibly zero times: the zero time is before every set time.
const later = (cur: number | undefined, t: number | undefined): number | undefined => (t !== undefined && (cur === undefined || cur < t) ? t : cur);

export function printPod(pod: JsonObject, o: GenerateOptions): TableRow[] {
  const spec = obj(pod.spec);
  const status = obj(pod.status);
  const conditions = objs(status.conditions);
  const containers = objs(spec.containers);
  const initContainerSpecs = objs(spec.initContainers);

  let restarts = 0;
  let restartableInitContainerRestarts = 0;
  let totalContainers = containers.length;
  let readyContainers = 0;
  let lastRestartDate: number | undefined;
  let lastRestartableInitContainerRestartDate: number | undefined;

  const podPhase = str(status.phase);
  let reason = podPhase;
  if (str(status.reason) !== '') reason = str(status.reason);

  // A Pod with {type: PodScheduled, reason: SchedulingGated} shows SchedulingGated.
  for (const c of conditions) if (c.type === 'PodScheduled' && c.reason === 'SchedulingGated') reason = 'SchedulingGated';

  const row: TableRow = { cells: [], object: pod };
  if (podPhase === 'Succeeded') row.conditions = POD_SUCCESS_CONDITIONS;
  else if (podPhase === 'Failed') row.conditions = POD_FAILED_CONDITIONS;

  const initContainers: Record<string, JsonObject> = {};
  for (const c of initContainerSpecs) {
    initContainers[str(c.name)] = c;
    if (isRestartableInitContainer(c)) totalContainers++;
  }

  let initializing = false;
  const initStatuses = objs(status.initContainerStatuses);
  for (let i = 0; i < initStatuses.length; i++) {
    const container = initStatuses[i] as JsonObject;
    const state = obj(container.state);
    const terminated = state.terminated === undefined || state.terminated === null ? undefined : obj(state.terminated);
    const waiting = state.waiting === undefined || state.waiting === null ? undefined : obj(state.waiting);
    const restartable = isRestartableInitContainer(Object.hasOwn(initContainers, str(container.name)) ? initContainers[str(container.name)] : undefined);
    restarts += num(container.restartCount);
    lastRestartDate = later(lastRestartDate, lastTerminated(container));
    if (restartable) {
      restartableInitContainerRestarts += num(container.restartCount);
      lastRestartableInitContainerRestartDate = later(lastRestartableInitContainerRestartDate, lastTerminated(container));
    }
    if (terminated !== undefined && num(terminated.exitCode) === 0) continue;
    if (restartable && bool(container.started)) {
      if (bool(container.ready)) readyContainers++;
      continue;
    }
    if (terminated !== undefined) {
      // initialization failed
      if (str(terminated.reason) === '') {
        reason = num(terminated.signal) !== 0 ? `Init:Signal:${num(terminated.signal)}` : `Init:ExitCode:${num(terminated.exitCode)}`;
      } else reason = `Init:${str(terminated.reason)}`;
      initializing = true;
    } else if (waiting !== undefined && str(waiting.reason) !== '' && waiting.reason !== 'PodInitializing') {
      reason = `Init:${str(waiting.reason)}`;
      initializing = true;
    } else {
      reason = `Init:${i}/${initContainerSpecs.length}`;
      initializing = true;
    }
    break;
  }

  if (!initializing || isPodInitializedConditionTrue(conditions)) {
    restarts = restartableInitContainerRestarts;
    lastRestartDate = lastRestartableInitContainerRestartDate;
    let hasRunning = false;
    let errorReason = '';
    const statuses = objs(status.containerStatuses);
    for (let i = statuses.length - 1; i >= 0; i--) {
      const container = statuses[i] as JsonObject;
      const state = obj(container.state);
      const terminated = state.terminated === undefined || state.terminated === null ? undefined : obj(state.terminated);
      const waiting = state.waiting === undefined || state.waiting === null ? undefined : obj(state.waiting);
      const running = state.running !== undefined && state.running !== null;
      restarts += num(container.restartCount);
      lastRestartDate = later(lastRestartDate, lastTerminated(container));
      if (waiting !== undefined && str(waiting.reason) !== '') {
        reason = str(waiting.reason);
      } else if (terminated !== undefined) {
        if (str(terminated.reason) !== '') reason = str(terminated.reason);
        else if (num(terminated.signal) !== 0) reason = `Signal:${num(terminated.signal)}`;
        else reason = `ExitCode:${num(terminated.exitCode)}`;
        if (num(terminated.exitCode) !== 0) errorReason = reason;
      } else if (bool(container.ready) && running) {
        hasRunning = true;
        readyContainers++;
      }
    }

    // Back to "Running" if at least one container still reports running.
    if (reason === 'Completed') {
      if (hasRunning && hasPodReadyCondition(conditions)) reason = 'Running';
      else if (errorReason !== '') reason = errorReason;
      else if (hasRunning) reason = 'NotReady';
    }
  }

  const deleting = timestampMicros(metadata(pod).deletionTimestamp) !== undefined;
  if (deleting && str(status.reason) === NODE_UNREACHABLE_POD_REASON) reason = 'Unknown';
  else if (deleting && podPhase !== 'Succeeded' && podPhase !== 'Failed') reason = 'Terminating';

  let restartsStr = String(restarts);
  if (restarts !== 0 && lastRestartDate !== undefined) restartsStr = `${restarts} (${since(lastRestartDate, o.now)} ago)`;

  row.cells.push(nameOf(pod), `${readyContainers}/${totalContainers}`, reason, restartsStr, age(pod, o));
  if (o.wide) {
    let nodeName = str(spec.nodeName);
    let nominatedNodeName = str(status.nominatedNodeName);
    const podIPs = objs(status.podIPs);
    let podIP = podIPs.length > 0 ? str((podIPs[0] as JsonObject).ip) : '';
    if (podIP === '') podIP = '<none>';
    if (nodeName === '') nodeName = '<none>';
    if (nominatedNodeName === '') nominatedNodeName = '<none>';
    let readinessGates = '<none>';
    const gates = objs(spec.readinessGates);
    if (gates.length > 0) {
      let trueConditions = 0;
      for (const g of gates) {
        const c = conditions.find((x) => x.type === g.conditionType);
        if (c !== undefined && c.status === 'True') trueConditions++;
      }
      readinessGates = `${trueConditions}/${gates.length}`;
    }
    row.cells.push(podIP, nodeName, nominatedNodeName, readinessGates);
  }
  return [row];
}


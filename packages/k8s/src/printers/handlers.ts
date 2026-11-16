// The column definitions and print functions of each kind the API server serves: the part of
// AddHandlers that covers them. Keyed by the group and kind of the object the printer reads (the
// internal type; for us the storage version, which events.k8s.io Events share with core ones).
// upstream: pkg/printers/internalversion/printers.go AddHandlers (podColumnDefinitions,
// replicaSetColumnDefinitions, daemonSetColumnDefinitions, serviceColumnDefinitions,
// endpointColumnDefinitions, nodeColumnDefinitions, eventColumnDefinitions,
// namespaceColumnDefinitions, secretColumnDefinitions, serviceAccountColumnDefinitions,
// deploymentColumnDefinitions, configMapColumnDefinitions, leaseColumnDefinitions,
// endpointSliceColumnDefinitions, scaleColumnDefinitions, serviceCIDRColumnDefinitions,
// ipAddressColumnDefinitions).

import { printDaemonSet, printDeployment, printReplicaSet, printScale } from './apps.ts';
import { printConfigMap, printEndpoints, printEvent, printNamespace, printNode, printSecret, printService, printServiceAccount } from './core.ts';
import { doc } from './descriptions.ts';
import { column, type PrintHandler } from './helpers.ts';
import { printEndpointSlice, printIPAddress, printLease, printServiceCIDR } from './networking.ts';
import { printPod } from './pod.ts';

const NAME = () => column('Name', 'string', doc('ObjectMeta.name'), { format: 'name' });
const AGE = () => column('Age', 'string', doc('ObjectMeta.creationTimestamp'));
const wide = { priority: 1 };
const CONTAINERS = () => column('Containers', 'string', 'Names of each container in the template.', wide);
const IMAGES = () => column('Images', 'string', 'Images referenced by each container in the template.', wide);

const HANDLERS: Readonly<Record<string, PrintHandler>> = {
  '/Pod': {
    columns: [
      NAME(),
      column('Ready', 'string', 'The aggregate readiness state of this pod for accepting traffic.'),
      column('Status', 'string', 'The aggregate status of the containers in this pod.'),
      column('Restarts', 'string', 'The number of times the containers in this pod have been restarted and when the last container in this pod has restarted.'),
      AGE(),
      column('IP', 'string', doc('PodStatus.podIP'), wide),
      column('Node', 'string', doc('PodSpec.nodeName'), wide),
      column('Nominated Node', 'string', doc('PodStatus.nominatedNodeName'), wide),
      column('Readiness Gates', 'string', doc('PodSpec.readinessGates'), wide),
    ],
    print: printPod,
  },
  'apps/ReplicaSet': {
    columns: [
      NAME(),
      column('Desired', 'integer', doc('ReplicaSetSpec.replicas')),
      column('Current', 'integer', doc('ReplicaSetStatus.replicas')),
      column('Ready', 'integer', doc('ReplicaSetStatus.readyReplicas')),
      AGE(),
      CONTAINERS(),
      IMAGES(),
      column('Selector', 'string', doc('ReplicaSetSpec.selector'), wide),
    ],
    print: printReplicaSet,
  },
  'apps/DaemonSet': {
    columns: [
      NAME(),
      column('Desired', 'integer', doc('DaemonSetStatus.desiredNumberScheduled')),
      column('Current', 'integer', doc('DaemonSetStatus.currentNumberScheduled')),
      column('Ready', 'integer', doc('DaemonSetStatus.numberReady')),
      column('Up-to-date', 'integer', doc('DaemonSetStatus.updatedNumberScheduled')),
      column('Available', 'integer', doc('DaemonSetStatus.numberAvailable')),
      column('Node Selector', 'string', doc('PodSpec.nodeSelector')),
      AGE(),
      CONTAINERS(),
      IMAGES(),
      column('Selector', 'string', doc('DaemonSetSpec.selector'), wide),
    ],
    print: printDaemonSet,
  },
  '/Service': {
    columns: [
      NAME(),
      column('Type', 'string', doc('ServiceSpec.type')),
      column('Cluster-IP', 'string', doc('ServiceSpec.clusterIP')),
      column('External-IP', 'string', doc('ServiceSpec.externalIPs')),
      column('Port(s)', 'string', doc('ServiceSpec.ports')),
      AGE(),
      column('Selector', 'string', doc('ServiceSpec.selector'), wide),
    ],
    print: printService,
  },
  '/Endpoints': {
    columns: [NAME(), column('Endpoints', 'string', doc('Endpoints.subsets')), AGE()],
    print: printEndpoints,
  },
  '/Node': {
    columns: [
      NAME(),
      column('Status', 'string', 'The status of the node'),
      column('Roles', 'string', 'The roles of the node'),
      AGE(),
      column('Version', 'string', doc('NodeSystemInfo.kubeletVersion')),
      column('Internal-IP', 'string', doc('NodeStatus.addresses'), wide),
      column('External-IP', 'string', doc('NodeStatus.addresses'), wide),
      column('OS-Image', 'string', doc('NodeSystemInfo.osImage'), wide),
      column('Kernel-Version', 'string', doc('NodeSystemInfo.kernelVersion'), wide),
      column('Container-Runtime', 'string', doc('NodeSystemInfo.containerRuntimeVersion'), wide),
    ],
    print: printNode,
  },
  '/Event': {
    columns: [
      column('Last Seen', 'string', doc('Event.lastTimestamp')),
      column('Type', 'string', doc('Event.type')),
      column('Reason', 'string', doc('Event.reason')),
      column('Object', 'string', doc('Event.involvedObject')),
      column('Subobject', 'string', doc('ObjectReference.fieldPath'), wide),
      column('Source', 'string', doc('Event.source'), wide),
      column('Message', 'string', doc('Event.message')),
      column('First Seen', 'string', doc('Event.firstTimestamp'), wide),
      column('Count', 'string', doc('Event.count'), wide),
      column('Name', 'string', doc('ObjectMeta.name'), { priority: 1, format: 'name' }),
    ],
    print: printEvent,
  },
  '/Namespace': {
    columns: [NAME(), column('Status', 'string', 'The status of the namespace'), AGE()],
    print: printNamespace,
  },
  '/Secret': {
    columns: [NAME(), column('Type', 'string', doc('Secret.type')), column('Data', 'string', doc('Secret.data')), AGE()],
    print: printSecret,
  },
  '/ServiceAccount': {
    columns: [NAME(), AGE()],
    print: printServiceAccount,
  },
  'apps/Deployment': {
    columns: [
      NAME(),
      column('Ready', 'string', 'Number of the pod with ready state'),
      column('Up-to-date', 'string', doc('DeploymentStatus.updatedReplicas')),
      column('Available', 'string', doc('DeploymentStatus.availableReplicas')),
      AGE(),
      CONTAINERS(),
      IMAGES(),
      column('Selector', 'string', doc('DeploymentSpec.selector'), wide),
    ],
    print: printDeployment,
  },
  '/ConfigMap': {
    columns: [NAME(), column('Data', 'string', doc('ConfigMap.data')), AGE()],
    print: printConfigMap,
  },
  'coordination.k8s.io/Lease': {
    columns: [NAME(), column('Holder', 'string', doc('LeaseSpec.holderIdentity')), AGE()],
    print: printLease,
  },
  'discovery.k8s.io/EndpointSlice': {
    columns: [
      NAME(),
      column('AddressType', 'string', doc('EndpointSlice.addressType')),
      column('Ports', 'string', doc('EndpointSlice.ports')),
      column('Endpoints', 'string', doc('EndpointSlice.endpoints')),
      AGE(),
    ],
    print: printEndpointSlice,
  },
  // The scale column definitions have no "name" format.
  'autoscaling/Scale': {
    columns: [column('Name', 'string', doc('ObjectMeta.name')), column('Desired', 'integer', doc('ScaleSpec.replicas')), column('Available', 'integer', doc('ScaleStatus.replicas')), AGE()],
    print: printScale,
  },
  'networking.k8s.io/ServiceCIDR': {
    columns: [NAME(), column('CIDRs', 'string', doc('ServiceCIDRSpec.cidrs')), AGE()],
    print: printServiceCIDR,
  },
  'networking.k8s.io/IPAddress': {
    columns: [NAME(), column('ParentRef', 'string', doc('IPAddressSpec.parentRef'))],
    print: printIPAddress,
  },
};

/** The handler for objects of a group and kind, or undefined (then the default convertor applies). */
export function printHandler(group: string, kind: string): PrintHandler | undefined {
  const key = `${group}/${kind}`;
  return Object.hasOwn(HANDLERS, key) ? HANDLERS[key] : undefined;
}

/** Every kind with a printer, as `<group>/<Kind>` (core: `/Pod`). */
export const PRINTED_KINDS: readonly string[] = Object.keys(HANDLERS);

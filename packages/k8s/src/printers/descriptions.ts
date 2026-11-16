// Column descriptions of the server's Table columns: the SwaggerDoc() of the Go API types, which
// printers.go AddHandlers reads (`metav1.ObjectMeta{}.SwaggerDoc()["name"]`). Copied verbatim
// from the generated swagger docs at the pin; keyed `<Type>.<json field>`.

export const SWAGGER_DOC: Readonly<Record<string, string>> = {
  // upstream: staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/types_swagger_doc_generated.go
  'ObjectMeta.name':
    "Name must be unique within a namespace. Is required when creating resources, although some resources may allow a client to request the generation of an appropriate name automatically. Name is primarily intended for creation idempotence and configuration definition. Cannot be updated. More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/names#names",
  'ObjectMeta.creationTimestamp':
    "CreationTimestamp is a timestamp representing the server time when this object was created. It is not guaranteed to be set in happens-before order across separate operations. Clients may not set this value. It is represented in RFC3339 form and is in UTC.\n\nPopulated by the system. Read-only. Null for lists. More info: https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#metadata",
  // upstream: staging/src/k8s.io/api/core/v1/types_swagger_doc_generated.go
  'PodStatus.podIP':
    "podIP address allocated to the pod. Routable at least within the cluster. Empty if not yet allocated.",
  'PodStatus.nominatedNodeName':
    "nominatedNodeName is set only when this pod preempts other pods on the node, but it cannot be scheduled right away as preemption victims receive their graceful termination periods. This field does not guarantee that the pod will be scheduled on this node. Scheduler may decide to place the pod elsewhere if other nodes become available sooner. Scheduler may also decide to give the resources on this node to a higher priority pod that is created after preemption. As a result, this field may be different than PodSpec.nodeName when the pod is scheduled.",
  'PodSpec.nodeName':
    "NodeName indicates in which node this pod is scheduled. If empty, this pod is a candidate for scheduling by the scheduler defined in schedulerName. Once this field is set, the kubelet for this node becomes responsible for the lifecycle of this pod. This field should not be used to express a desire for the pod to be scheduled on a specific node. https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/#nodename",
  'PodSpec.readinessGates':
    "If specified, all readiness gates will be evaluated for pod readiness. A pod is ready when all its containers are ready AND all conditions specified in the readiness gates have status equal to \"True\" More info: https://git.k8s.io/enhancements/keps/sig-network/580-pod-readiness-gates",
  'PodSpec.nodeSelector':
    "NodeSelector is a selector which must be true for the pod to fit on a node. Selector which must match a node's labels for the pod to be scheduled on that node. More info: https://kubernetes.io/docs/concepts/configuration/assign-pod-node/",
  'ServiceSpec.type':
    "type determines how the Service is exposed. Defaults to ClusterIP. Valid options are ExternalName, ClusterIP, NodePort, and LoadBalancer. \"ClusterIP\" allocates a cluster-internal IP address for load-balancing to endpoints. Endpoints are determined by the selector or if that is not specified, by manual construction of an Endpoints object or EndpointSlice objects. If clusterIP is \"None\", no virtual IP is allocated and the endpoints are published as a set of endpoints rather than a virtual IP. \"NodePort\" builds on ClusterIP and allocates a port on every node which routes to the same endpoints as the clusterIP. \"LoadBalancer\" builds on NodePort and creates an external load-balancer (if supported in the current cloud) which routes to the same endpoints as the clusterIP. \"ExternalName\" aliases this service to the specified externalName. Several other fields do not apply to ExternalName services. More info: https://kubernetes.io/docs/concepts/services-networking/service/#publishing-services-service-types",
  'ServiceSpec.clusterIP':
    "clusterIP is the IP address of the service and is usually assigned randomly. If an address is specified manually, is in-range (as per system configuration), and is not in use, it will be allocated to the service; otherwise creation of the service will fail. This field may not be changed through updates unless the type field is also being changed to ExternalName (which requires this field to be blank) or the type field is being changed from ExternalName (in which case this field may optionally be specified, as describe above).  Valid values are \"None\", empty string (\"\"), or a valid IP address. Setting this to \"None\" makes a \"headless service\" (no virtual IP), which is useful when direct endpoint connections are preferred and proxying is not required.  Only applies to types ClusterIP, NodePort, and LoadBalancer. If this field is specified when creating a Service of type ExternalName, creation will fail. This field will be wiped when updating a Service to type ExternalName. More info: https://kubernetes.io/docs/concepts/services-networking/service/#virtual-ips-and-service-proxies",
  'ServiceSpec.externalIPs':
    "externalIPs is a list of IP addresses for which nodes in the cluster will also accept traffic for this service.  These IPs are not managed by Kubernetes.  The user is responsible for ensuring that traffic arrives at a node with this IP.  A common example is external load-balancers that are not part of the Kubernetes system.",
  'ServiceSpec.ports':
    "The list of ports that are exposed by this service. More info: https://kubernetes.io/docs/concepts/services-networking/service/#virtual-ips-and-service-proxies",
  'ServiceSpec.selector':
    "Route service traffic to pods with label keys and values matching this selector. If empty or not present, the service is assumed to have an external process managing its endpoints, which Kubernetes will not modify. Only applies to types ClusterIP, NodePort, and LoadBalancer. Ignored if type is ExternalName. More info: https://kubernetes.io/docs/concepts/services-networking/service/",
  'Endpoints.subsets':
    "The set of all endpoints is the union of all subsets. Addresses are placed into subsets according to the IPs they share. A single address with multiple ports, some of which are ready and some of which are not (because they come from different containers) will result in the address being displayed in different subsets for the different ports. No address will appear in both Addresses and NotReadyAddresses in the same subset. Sets of addresses and ports that comprise a service.",
  'NodeSystemInfo.kubeletVersion':
    "Kubelet Version reported by the node.",
  'NodeSystemInfo.osImage':
    "OS Image reported by the node from /etc/os-release (e.g. Debian GNU/Linux 7 (wheezy)).",
  'NodeSystemInfo.kernelVersion':
    "Kernel Version reported by the node from 'uname -r' (e.g. 3.16.0-0.bpo.4-amd64).",
  'NodeSystemInfo.containerRuntimeVersion':
    "ContainerRuntime Version reported by the node through runtime remote API (e.g. containerd://1.4.2).",
  'NodeStatus.addresses':
    "List of addresses reachable to the node. Queried from cloud provider, if available. More info: https://kubernetes.io/docs/reference/node/node-status/#addresses Note: This field is declared as mergeable, but the merge key is not sufficiently unique, which can cause data corruption when it is merged. Callers should instead use a full-replacement patch. See https://pr.k8s.io/79391 for an example. Consumers should assume that addresses can change during the lifetime of a Node. However, there are some exceptions where this may not be possible, such as Pods that inherit a Node's address in its own status or consumers of the downward API (status.hostIP).",
  'Event.lastTimestamp':
    "The time at which the most recent occurrence of this event was recorded.",
  'Event.type':
    "Type of this event (Normal, Warning), new types could be added in the future",
  'Event.reason':
    "This should be a short, machine understandable string that gives the reason for the transition into the object's current status.",
  'Event.involvedObject':
    "The object that this event is about.",
  'Event.source':
    "The component reporting this event. Should be a short machine understandable string.",
  'Event.message':
    "A human-readable description of the status of this operation.",
  'Event.firstTimestamp':
    "The time at which the event was first recorded. (Time of server receipt is in TypeMeta.)",
  'Event.count':
    "The number of times this event has occurred.",
  'ObjectReference.fieldPath':
    "If referring to a piece of an object instead of an entire object, this string should contain a valid JSON/Go field access statement, such as desiredState.manifest.containers[2]. For example, if the object reference is to a container within a pod, this would take on a value like: \"spec.containers{name}\" (where \"name\" refers to the name of the container that triggered the event) or if no container name is specified \"spec.containers[2]\" (container with index 2 in this pod). This syntax is chosen only to have some well-defined way of referencing a part of an object.",
  'Secret.type':
    "Used to facilitate programmatic handling of secret data. More info: https://kubernetes.io/docs/concepts/configuration/secret/#secret-types",
  'Secret.data':
    "Data contains the secret data. Each key must consist of alphanumeric characters, '-', '_' or '.'. The serialized form of the secret data is a base64 encoded string, representing the arbitrary (possibly non-string) data value here. Described in https://tools.ietf.org/html/rfc4648#section-4",
  'ConfigMap.data':
    "Data contains the configuration data. Each key must consist of alphanumeric characters, '-', '_' or '.'. Values with non-UTF-8 byte sequences must use the BinaryData field. The keys stored in Data must not overlap with the keys in the BinaryData field, this is enforced during validation process.",
  // upstream: staging/src/k8s.io/api/apps/v1/types_swagger_doc_generated.go
  'ReplicaSetSpec.replicas':
    "Replicas is the number of desired pods. This is a pointer to distinguish between explicit zero and unspecified. Defaults to 1. More info: https://kubernetes.io/docs/concepts/workloads/controllers/replicaset",
  'ReplicaSetSpec.selector':
    "Selector is a label query over pods that should match the replica count. Label keys and values that must match in order to be controlled by this replica set. It must match the pod template's labels. More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/#label-selectors",
  'ReplicaSetStatus.replicas':
    "Replicas is the most recently observed number of non-terminating pods. More info: https://kubernetes.io/docs/concepts/workloads/controllers/replicaset",
  'ReplicaSetStatus.readyReplicas':
    "The number of non-terminating pods targeted by this ReplicaSet with a Ready Condition.",
  'DaemonSetStatus.desiredNumberScheduled':
    "The total number of nodes that should be running the daemon pod (including nodes correctly running the daemon pod). More info: https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/",
  'DaemonSetStatus.currentNumberScheduled':
    "The number of nodes that are running at least 1 daemon pod and are supposed to run the daemon pod. More info: https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/",
  'DaemonSetStatus.numberReady':
    "numberReady is the number of nodes that should be running the daemon pod and have one or more of the daemon pod running with a Ready Condition.",
  'DaemonSetStatus.updatedNumberScheduled':
    "The total number of nodes that are running updated daemon pod",
  'DaemonSetStatus.numberAvailable':
    "The number of nodes that should be running the daemon pod and have one or more of the daemon pod running and available (ready for at least spec.minReadySeconds)",
  'DaemonSetSpec.selector':
    "A label query over pods that are managed by the daemon set. Must match in order to be controlled. It must match the pod template's labels. More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/#label-selectors",
  'DeploymentStatus.updatedReplicas':
    "Total number of non-terminating pods targeted by this deployment that have the desired template spec.",
  'DeploymentStatus.availableReplicas':
    "Total number of available non-terminating pods (ready for at least minReadySeconds) targeted by this deployment.",
  'DeploymentSpec.selector':
    "Label selector for pods. Existing ReplicaSets whose pods are selected by this will be the ones affected by this deployment. It must match the pod template's labels.",
  // upstream: staging/src/k8s.io/api/coordination/v1/types_swagger_doc_generated.go
  'LeaseSpec.holderIdentity':
    "holderIdentity contains the identity of the holder of a current lease. If Coordinated Leader Election is used, the holder identity must be equal to the elected LeaseCandidate.metadata.name field.",
  // upstream: staging/src/k8s.io/api/discovery/v1/types_swagger_doc_generated.go
  'EndpointSlice.addressType':
    "addressType specifies the type of address carried by this EndpointSlice. All addresses in this slice must be the same type. This field is immutable after creation. The following address types are currently supported: * IPv4: Represents an IPv4 Address. * IPv6: Represents an IPv6 Address. * FQDN: Represents a Fully Qualified Domain Name. (Deprecated) The EndpointSlice controller only generates, and kube-proxy only processes, slices of addressType \"IPv4\" and \"IPv6\". No semantics are defined for the \"FQDN\" type.",
  'EndpointSlice.ports':
    "ports specifies the list of network ports exposed by each endpoint in this slice. Each port must have a unique name. Each slice may include a maximum of 100 ports. Services always have at least 1 port, so EndpointSlices generated by the EndpointSlice controller will likewise always have at least 1 port. EndpointSlices used for other purposes may have an empty ports list.",
  'EndpointSlice.endpoints':
    "endpoints is a list of unique endpoints in this slice. Each slice may include a maximum of 1000 endpoints.",
  // upstream: staging/src/k8s.io/api/autoscaling/v1/types_swagger_doc_generated.go
  'ScaleSpec.replicas':
    "replicas is the desired number of instances for the scaled object.",
  'ScaleStatus.replicas':
    "replicas is the actual number of observed instances of the scaled object.",
  // upstream: staging/src/k8s.io/api/networking/v1/types_swagger_doc_generated.go
  'ServiceCIDRSpec.cidrs':
    "cidrs defines the IP blocks in CIDR notation (e.g. \"192.168.0.0/24\" or \"2001:db8::/64\") from which to assign service cluster IPs. Max of two CIDRs is allowed, one of each IP family. This field is immutable.",
  'IPAddressSpec.parentRef':
    "parentRef references the resource that an IPAddress is attached to. An IPAddress must reference a parent object.",
};

/** The swagger doc of `<Type>.<field>`; a missing key is a bug in this file. */
export function doc(key: string): string {
  const d = SWAGGER_DOC[key];
  if (d === undefined) throw new Error(`no swagger doc for ${key}`);
  return d;
}

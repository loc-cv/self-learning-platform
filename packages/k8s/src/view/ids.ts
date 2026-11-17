// The view ids of the Kubernetes entities (PLAN.md §6.5): stable across worlds and time, built from
// the object's kind and name, so an event can name an object that no longer exists.

export const namespaceId = (ns: string): string => `k8s/Namespace/${ns}`;
export const nodeId = (name: string): string => `k8s/Node/${name}`;
/** The view id of a namespaced object the view draws (Pod, Deployment, ReplicaSet, Service). */
export const objectId = (kind: string, ns: string, name: string): string => `k8s/${kind}/${ns}/${name}`;

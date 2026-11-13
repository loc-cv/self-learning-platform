# Phase 29c — Highly available control plane

**Milestone** M4 · **Needs** 29a · Follow the session protocol in `CLAUDE.md`.

## Goal

A control plane with three members, so I can see and practice what high availability means: what
keeps working when a node dies, what quorum is, and how such a cluster is assembled. Covers
"implement and configure a highly-available control plane".

## Read first

Official kubeadm documentation on HA topologies and on creating HA clusters. The etcd behavior
model (phases 27, 28) and component leader election.

## Build

- **Topology `kubeadm-ha-3cp`**: three control-plane nodes with stacked etcd, two workers, and a
  load balancer machine in front of the API servers. The load balancer is a host service with a
  behavior model (an HAProxy-style TCP proxy with health checks and a readable config file), built
  on the host substrate so the later Nginx domain can reuse the pattern.
- **Assembly with kubeadm**: `init --control-plane-endpoint … --upload-certs`, `kubeadm join
  --control-plane --certificate-key …`, `kubeadm init phase upload-certs` to refresh an expired
  key, joining workers through the endpoint. The topology is built by this logic, as in phase 29a.
- **etcd membership**: several members with peer URLs, leader and followers, quorum; `etcdctl
  member list`, `endpoint status --cluster`, `endpoint health --cluster` showing each member;
  `member remove` and `member add` for replacing a failed member; writes failing without quorum
  while reads of stale data behave as the real default does; the API server's real errors when etcd
  has no quorum.
- **API servers behind the endpoint**: clients use the load balancer address; one API server down
  is invisible apart from the health check; the load balancer down breaks clients using the
  endpoint while a local API server is still reachable directly.
- **Leader election** for kube-scheduler and kube-controller-manager through Leases, with failover
  after the real lease duration, visible in the Lease objects and component logs.
- **Failure scenarios** as faults: one control-plane node powered off; two powered off; the load
  balancer misconfigured; one etcd member with a corrupted data directory; a control-plane node
  that needs replacing.
- Extend the X-ray view provider: etcd members and leader, lease holders, load balancer backends.
  Add four items: a lesson on quorum with predictions before each failure; add a control-plane
  node; an incident with one node down (find what still works and restore redundancy); an incident
  with quorum lost, restored from a snapshot.

## Not in this phase

External etcd clusters, keepalived and virtual IPs (the Nginx HA domain may add them), HA upgrades
unless cheap.

## Exit criteria

- Simulation tests: with one control-plane node off, the API stays reachable through the endpoint,
  leadership moves within the real lease timing, and workloads reconcile; with two off, writes fail
  with the real error and existing Pods keep running.
- A transcript adds a third control-plane node to a two-member cluster with the documented commands.
- Replacing a failed etcd member works with `member remove` and a fresh join.
- The single-control-plane topologies are unaffected and equally fast (measure boot time).
- The items pass `content:check`.

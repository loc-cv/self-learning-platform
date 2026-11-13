# Phase 19a — Service types and NetworkPolicy

**Milestone** M3 · **Needs** 17 · Follow the session protocol in `CLAUDE.md`.

## Goal

How traffic reaches a Service from outside the cluster, and how policies block traffic between
workloads. "Why can't A reach B" is among the most common real tickets and a staple of both exams.

## Read first

`PLAN.md` §7 (network model). The network model code and docs from phase 17. The official
NetworkPolicy documentation for semantics; golden cases from the oracle for object output and
validation.

## Build

- **Service types**: NodePort (allocation from the range, explicit ports, reachability on every
  node address), LoadBalancer (pending without a provider; a topology option adds a simple provider
  that assigns an address), ExternalName, session affinity, `externalTrafficPolicy` and
  `internalTrafficPolicy` where they change the outcome, multi-port and named-port Services,
  Services without selectors with manual EndpointSlices.
- **Network model**: extend `connect` through NodePort and load balancer addresses; clients on the
  workstation and on nodes can test from "outside".
- **NetworkPolicy**: an evaluator for ingress and egress with Pod, namespace and IP block
  selectors, ports, port ranges and protocols, default-deny patterns and the union of policies.
  Enforced only when the topology's CNI supports it; a topology without enforcement accepts the
  objects and applies nothing, as in reality. Denied traffic times out; it is not refused. Egress
  policies affect DNS lookups. Traffic from a node to its own Pods follows the real rule.
- **kubectl**: printer and describer for NetworkPolicy in the real layout; `expose --type`,
  `create service nodeport|loadbalancer|externalname`.
- **Checks**: `net.reach` can expect a timeout, and can run from outside the cluster.
- X-ray: which policies select a Pod, and for a failed connection, which direction and which policy
  set dropped it. Add five items, including a default-deny incident where DNS egress was forgotten.

## Not in this phase

Ingress and Gateway API (phase 19b). CoreDNS, kube-proxy and CNI failures (phase 30).

## Exit criteria

- A table-driven NetworkPolicy suite of at least thirty cases, each justified by the official
  semantics, including a namespace selector combined with a Pod selector in one entry versus two
  entries (the AND versus OR pitfall), empty selectors, and policies in both directions.
- Transcripts: curl to a NodePort from the workstation; a default-deny policy making curl time
  out; a lookup failing under an egress policy without a DNS rule; the same manifests having no
  effect on a topology whose CNI doesn't enforce policies.
- The new items pass `content:check`; the divergence register is current.

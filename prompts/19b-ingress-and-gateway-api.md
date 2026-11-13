# Phase 19b — Ingress and Gateway API

**Milestone** M3 · **Needs** 19a, 20c · Follow the session protocol in `CLAUDE.md`.

## Goal

HTTP routing into the cluster with both generations of the API: Ingress with a controller, and the
Gateway API, which the CKA now tests explicitly.

## Read first

`PLAN.md` §6.3, §7. Official Ingress and Gateway API documentation for semantics and status
conditions. The Gateway API resources are CRDs: phase 20c provides the machinery to install them.

## Build

- **Ingress**: IngressClass and the default class; an ingress-nginx controller as a workload with a
  behavior model that reads Ingress objects and routes by host and path (the three path types and
  their precedence, default backend, TLS termination from a Secret, the rewrite-target annotation,
  several hosts); its Service; the address appearing in the Ingress status; the real responses when
  no rule matches or the backend has no endpoints. Without a running controller, Ingress objects are
  accepted and do nothing.
- **Gateway API**: the CRD bundle of the version current for the pinned Kubernetes release,
  installed by a scenario or by me from manifests; GatewayClass, Gateway (listeners, hostnames,
  allowed routes), HTTPRoute (parent references, hostnames, path, header and method matches, backend
  weights for traffic splitting, the request header and redirect filters), ReferenceGrant for
  cross-namespace backends; a controller workload with a behavior model; the status conditions on
  each object (`Accepted`, `Programmed`, `ResolvedRefs`) with reasons.
- **Network model**: extend `connect` through the controller's Service to the routed backend, with
  the `Host` header and path taken from the client request (`curl -H`, `--resolve`).
- **kubectl**: printers and describers for Ingress and IngressClass in the real layout;
  `create ingress` with its rule syntax; Gateway API kinds through their CRD printer columns.
- **Checks**: `net.reach` with host, path, expected status and expected backend.
- X-ray: route resolution from listener to backend Pod. Add five items: an Ingress built to a
  specification, a broken Ingress (wrong class, wrong Service port), migrating an Ingress to an
  HTTPRoute, a weighted split, a cross-namespace route missing its ReferenceGrant.

## Not in this phase

Other Gateway route kinds (TCP, gRPC, TLS), other ingress controllers, service mesh. Record the
omissions.

## Exit criteria

- A table-driven routing suite for Ingress path types and precedence and for HTTPRoute matching,
  each case justified by the official documentation.
- Transcripts: curl through an Ingress by host and path, including a 404 from the default backend
  and a 503 for a backend without endpoints; a weighted HTTPRoute split observed over a seeded run.
- Gateway and HTTPRoute status conditions reflect misconfiguration: no matching class, listener
  not allowing the route's namespace, unresolved backend, missing ReferenceGrant.
- The new items pass `content:check`; the divergence register lists what the controller models omit.

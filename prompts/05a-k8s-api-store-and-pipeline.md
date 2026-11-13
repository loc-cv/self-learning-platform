# Phase 05a — Kubernetes API: schema, registry, store, request pipeline

**Milestone** M1 · **Needs** 01, 04 · Follow the session protocol in `CLAUDE.md`.

## Goal

The API server half of the Kubernetes plugin: objects pass through a request pipeline into a
store, with the defaults and validation errors of the real API server. Everything later (kubectl,
controllers, kubelet) talks to this, so its semantics must be right.

## Read first

`PLAN.md` §7. `docs/ARCHITECTURE.md` Kubernetes sections. `docs/FIDELITY.md`. The golden fixtures
for defaulted objects and validation errors from phase 04.

## Build

- **Schema data**: a tool that turns the upstream OpenAPI v3 documents into compact per-version
  data vendored in the package. Keep it small enough to load fast in a browser, and lazy where it helps.
- **Resource registry**: every built-in resource's group, version, kind, scope, short names,
  categories and verbs (needed later by `api-resources` and name resolution), even though behavior
  exists only for some kinds.
- **Store**: objects keyed by resource, namespace and name; `resourceVersion`, `uid`, `generation`,
  `creationTimestamp` from the kernel; watch with ordered delivery through the kernel event queue.
- **Request pipeline**: create, get, list, update, patch (JSON merge patch now), delete with grace
  period, `deletionTimestamp` and finalizers; label and field selectors; `generateName` with the
  real suffix alphabet; status subresource; Status errors (NotFound, AlreadyExists, Conflict,
  Invalid, BadRequest for unknown fields and wrong types) in upstream message formats. Leave explicit
  hooks for authentication, authorization and admission (phases 20a, 20b).
- **Kinds with defaulting and validation ported from upstream**: Namespace, Node, Pod, Service
  (with ClusterIP allocation), ConfigMap, Secret, ServiceAccount, Event, Deployment, ReplicaSet,
  EndpointSlice and Endpoints, Lease. Port the validations for the most common mistakes first and
  cite the upstream function for each.
- A typed client API that programs and controllers use to talk to the pipeline.

## Not in this phase

Controllers (phase 05b). Scheduler and kubelet (06a, 06b). kubectl. RBAC and admission plugins.

## Exit criteria

- Defaulted objects equal the golden fixtures after normalization, for every kind above with a fixture.
- Validation error messages match fixtures for the common mistakes (missing selector, selector and
  template labels mismatch, invalid names, unknown field, wrong type, immutable field change).
- Tests cover optimistic concurrency conflicts, finalizers holding deletion, graceful deletion, and
  selector semantics.
- Watch delivery order is deterministic; the world hash is stable across runs.
- The vendored schema size and load time are measured and recorded.
- Divergences found while comparing are fixed or entered in the divergence register.

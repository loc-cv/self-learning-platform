# Phase 20c — CRDs, operators, API deprecations

**Milestone** M3 · **Needs** 15 · Follow the session protocol in `CLAUDE.md`.

## Goal

Resources that extend Kubernetes behave like built-in ones, an operator reconciles them, and old
API versions warn and disappear the way they really do. Both exams test discovering and using
CRDs and operators; the Gateway API phase needs this machinery too.

## Read first

`PLAN.md` §7. The resource registry and schema code from phase 05a. The oracle's real API server
serves CRDs: capture golden cases for CRD validation, printer columns and `explain`.

## Build

- **CustomResourceDefinition**: establishing a CRD registers the resource dynamically (group,
  versions, scope, names, short names, categories); structural OpenAPI schema validation with real
  error messages; defaulting; pruning of unknown fields; additional printer columns; `status` and
  `scale` subresources; several versions with one storage version; the CRD's own conditions
  (`Established`, `NamesAccepted`); deleting a CRD removes its objects.
- **Custom objects through every existing path**: all kubectl verbs, selectors, output formats,
  `explain`, `api-resources`, tab completion, RBAC rules, garbage collection by owner reference,
  watches, X-ray (generic view).
- **A sample operator**: a workload whose behavior model runs a registered reconciler. Provide one
  realistic operator (for example a small database operator: a custom resource becomes a StatefulSet
  or Deployment, a Service and a status), installed from manifests the way real ones are (CRD, RBAC,
  Deployment). If its Pod isn't running, or its RBAC is insufficient, custom objects are accepted and
  nothing reconciles, with the operator's logs saying why.
- **Plugin point**: document how a content pack or later domain registers further operators.
- **API deprecations**: resources served in several versions with conversion; deprecation warnings
  on use as kubectl prints them; removed versions failing with the real "no matches for kind" text;
  `kubectl api-versions`, `api-resources --api-group`, `explain --api-version`; `kubectl convert`
  as a notice unless cheap. Scenarios can present a manifest written for an older release.
- Add five items: find and use an unfamiliar CRD with `explain`, write a custom object that passes
  validation, an operator that doesn't reconcile (missing RBAC), fix manifests using removed API
  versions, install an operator from manifests.

## Not in this phase

Conversion webhooks, admission webhooks, operator SDK topics. Record the omissions.

## Exit criteria

- Golden cases pass for CRD establishment, an invalid custom object, printer columns in `get`, and
  `explain` on a custom resource.
- A custom object owned by another object is garbage-collected; RBAC can grant access to a custom
  resource and `auth can-i` agrees.
- The sample operator reconciles create, update and delete of its resource, and each of its
  failure modes is observable in status or logs.
- A manifest with a removed API version fails the real way; a deprecated one warns the real way.
- The new items pass `content:check`.

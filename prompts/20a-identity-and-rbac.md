# Phase 20a — Identity and RBAC

**Milestone** M3 · **Needs** 17 · Follow the session protocol in `CLAUDE.md`.

## Goal

Who is making a request and whether they may. After this phase a request can be Forbidden for a
real reason, and I can build and debug roles and bindings the way I do on a real cluster.

## Read first

`PLAN.md` §7 (request pipeline). The pipeline hooks left in phase 05a. The oracle runs a real API
server with real RBAC: capture golden cases for every decision family and error text.

## Build

- **Authentication**: identities from kubeconfig (client certificate subject and groups, bearer
  tokens), ServiceAccount tokens (`kubectl create token`, projected tokens from phase 16a), `--as`,
  `--as-group` and `--as-uid` impersonation with its own authorization check, the system groups.
- **RBAC objects**: Role, ClusterRole, RoleBinding, ClusterRoleBinding; rules with API groups,
  resources, subresources, resource names, verbs including wildcards, non-resource URLs; aggregated
  ClusterRoles; the bootstrap roles and bindings in common use (`cluster-admin`, `admin`, `edit`,
  `view`, the `system:` ones that later phases rely on); escalation and bind restrictions.
- **Authorizer** in the request pipeline, with Forbidden messages in the real format for every
  verb and scope. Controllers and kubelets act under their own identities where it is cheap to do
  so; where it isn't, record it.
- **kubectl**: `auth can-i` (resource and subresource forms, `--list`, `-A`, `--as`),
  `auth whoami`, `auth reconcile` as a notice, `create role`, `create clusterrole`,
  `create rolebinding`, `create clusterrolebinding`, `create serviceaccount`, `create token`;
  printers and describers for the four RBAC kinds in their real layouts.
- **Certificates API**: CertificateSigningRequest objects, `kubectl certificate approve` and
  `deny`, a signer that issues a certificate in the PKI stand-in format (define that format in
  `packages/host` per `PLAN.md` §7, so phase 25b extends it instead of replacing it), and enough `openssl`
  (`genrsa`, `req -new`, `x509 -in … -text -noout`) and `kubectl config set-credentials`,
  `set-context` for the "create a user with a client certificate" flow to work end to end. Full PKI
  tooling comes in phase 25b.
- Trace records explaining each authorization decision (which binding and rule allowed it, or that
  none did), shown in X-ray. Add five items: build a role to a specification, a ServiceAccount for a
  workload that calls the API, a Forbidden incident, a too-broad binding to tighten, a new user with
  a certificate.

## Not in this phase

Admission and quotas (phase 20b). CRDs (20c). OIDC, webhook authorization, audit logging:
non-goals; record them.

## Exit criteria

- A table-driven RBAC suite of at least forty decisions, each verified against the oracle,
  covering namespaced versus cluster scope, a ClusterRole bound by a RoleBinding, resource names,
  subresources, wildcards and impersonation.
- Golden cases for Forbidden texts and for `auth can-i --list` pass.
- The certificate user flow works from key generation to a successful, correctly limited `kubectl get`.
- A Pod using a ServiceAccount can call the API from inside (through `kubectl` or `curl` in a
  suitable image) and gets the right allow or deny.
- The new items pass `content:check`.

# Phase 04 — Real control plane as an oracle, golden fixtures

**Milestone** M1 · **Needs** 00 · Follow the session protocol in `CLAUDE.md`.

## Goal

Give every later Kubernetes phase real output to match instead of memory. The official release
binaries of the pinned version run on this workstation without Docker: `kube-apiserver`, `etcd`,
`kube-controller-manager`, `kube-scheduler` and `kubectl`. Run them locally as a throwaway control
plane with fake Node objects, capture what real Kubernetes prints, and store it as golden fixtures.

This is a development tool only. The platform never needs it at runtime and must work without it.

## Read first

`PLAN.md` §3, §9. `docs/FIDELITY.md`.

## Build

- **`tools/oracle`**: download the pinned binaries (dl.k8s.io for Kubernetes, the etcd release
  page for etcd) into `.upstream/bin/` with checksum verification. Start and stop a local control
  plane in a temporary directory with generated certificates, on non-default ports, leaving nothing
  running afterward. Register fake Nodes matching the `kubeadm-1cp-2w` topology (capacity, labels,
  the control-plane taint). Check first that this works here; if a component can't run, say so,
  capture with what does run, and record the limit in `docs/FIDELITY.md`.
- Optionally run a KWOK binary so Pods reach Running, which is needed to capture table and
  `describe` layouts of running workloads. Strings authored by KWOK's fake kubelet are not
  authoritative; mark those fixture fields so they are never asserted as real kubelet text.
- **Case format**: a declarative file with setup manifests, a list of commands, optional waits, and
  what to capture (stdout, stderr, exit code, and selected objects as JSON).
- **Normalization**: replace volatile values (UIDs, resource versions, timestamps, ages, IPs,
  generated name suffixes, ports) with tokens, by rule, so a simulator run can be compared. Share the
  token vocabulary with the transcript format from phase 02.
- **Capture command**: `npm run golden:capture -- <case or folder>` writes fixtures under
  `fixtures/golden/<k8s-version>/`. Fixtures are committed; binaries are not.
- **Client-only oracle**: a second mode that runs the real `kubectl` with no server, for output that
  needs none: help and usage text, `--dry-run=client -o yaml` generators, `kubectl config`,
  `kubectl kustomize`. Use it to produce a machine-readable manifest of every kubectl command and
  flag, which phase 07a needs to tell "real but not simulated" from "really unknown".
- **Initial cases** for the M1 surface: creating and reading Pods, Deployments, ReplicaSets,
  Services, Namespaces, ConfigMaps and Nodes in each output format; `describe` for Pod, Deployment,
  Service and Node; defaulted objects as JSON; common validation and not-found errors; apply
  created, configured and unchanged; scheduling failures from taints, node selectors and
  insufficient resources with their exact event messages; Deployment rollout objects and events.
- `docs/FIDELITY.md`: document the oracle, what each tier can and can't verify, and how to add a case.

## Not in this phase

The differential runner that compares the simulator to fixtures (phase 07a adds it for kubectl
output; phase 05a may compare object JSON). kind-based capture of real kubelet behavior (phase 32).

## Exit criteria

- One command brings the oracle up, another tears it down, and no process or port stays behind.
- The initial cases are captured, normalized and committed, and re-capturing produces identical files.
- The kubectl command and flag manifest exists for the pinned version.
- `npm run check` does not depend on the oracle or the network.

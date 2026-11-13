# Phase 26a — Kubelet and container runtime as node services, static Pods, node lifecycle

**Milestone** M4 · **Needs** 25b, 18a · Follow the session protocol in `CLAUDE.md`.

## Goal

Tie each node's Kubernetes behavior to the state of its machine. The kubelet becomes a real systemd
unit reading real files; when I break one of them, the node goes NotReady for that reason and the
logs say so. "Troubleshoot clusters and nodes" is the heaviest part of the CKA, and this phase is
what makes it practicable.

## Read first

`PLAN.md` §7 ("Components are processes on nodes"). `docs/BEHAVIOR_MODELS.md`. Upstream kubelet
and kubeadm sources for file layouts, flags, log lines and condition messages (search; don't read
whole files). Official kubeadm documentation for the node file layout.

## Build

- **Node file layout** as kubeadm produces it: `/var/lib/kubelet/config.yaml` and
  `kubeadm-flags.env`, `/etc/kubernetes/kubelet.conf`, `/etc/kubernetes/pki/ca.crt`, the kubelet's
  client certificate with its rotation files, the systemd unit and its kubeadm drop-in,
  `/etc/containerd/config.toml`, `/etc/crictl.yaml`, `/etc/cni/net.d`, `/opt/cni/bin`,
  `/var/log/pods` and `/var/log/containers`, binaries in `/usr/bin`. Register the packages
  (`kubelet`, `kubeadm`, `kubectl`, `containerd`, `cri-tools`, `kubernetes-cni`) with versions.
- **Kubelet as a unit**: the kubelet from phase 06b now runs only while its unit is active, and
  its behavior model reads its real inputs: flags, config file (static Pod path, cluster DNS and
  domain, cgroup driver, eviction settings, max Pods), kubeconfig (server address, credentials), CA,
  container runtime endpoint. Each wrong input has its real consequence and its real journal lines:
  unit failing to start and restarting, cannot reach the API server, certificate rejected or
  expired, runtime not reachable, cgroup driver mismatch, swap enabled, CNI not initialized.
- **containerd as a unit** with its config; when it is down, containers on the node are gone from
  the kubelet's view, with the real effects on Pod status and node conditions.
- **CNI presence**: a node without a CNI configuration is NotReady with the real condition message.
- **Node lifecycle controller**: a node whose kubelet stops heartbeating becomes `NotReady` then
  `Unknown` after the real grace periods, gets the `not-ready` and `unreachable` taints, and its
  Pods are evicted after their toleration seconds and replaced elsewhere; DaemonSet and static Pods
  behave as they really do.
- **Node conditions and pressure**: `MemoryPressure`, `DiskPressure`, `PIDPressure` with their
  taints, eviction in simple form driven by scenario faults, allocatable accounting.
- **Static Pods**: the kubelet watches its manifest directory in the node's VFS, runs what is
  there, creates mirror Pods with the node-name suffix, and reacts to edits, removals, invalid
  manifests and deletion of the mirror Pod the real way. Use ordinary example Pods here; the
  control-plane components become static Pods in phase 27.
- **Faults**: kubelet stopped or disabled, a wrong path or value in each input file, missing
  binary, expired client certificate, runtime down, CNI configuration removed.
- Extend the X-ray view provider with node internals: unit states and the reason for NotReady.

## Not in this phase

`crictl`, `drain`, `cordon`, `taint` and the content items (phase 26b). Control-plane components
as static Pods (27). kubeadm commands (28, 29a).

## Exit criteria

- For each kubelet input, a simulation test breaks it and asserts the unit state, the journal
  lines, the node condition and the downstream effects (Pods, taints, evictions) over virtual time;
  repairing it and restarting the unit recovers the node.
- Stopping containerd on a node produces the real node condition and Pod states, and starting it
  recovers them.
- Editing a static Pod manifest on a node restarts the Pod; an invalid manifest removes it and the
  kubelet log says why; deleting the mirror Pod with kubectl brings it straight back.
- The default topology still boots to a healthy cluster, deterministically.
- `packages/host` still imports nothing from `packages/k8s`.

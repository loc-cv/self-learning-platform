# Phase 29a — kubeadm: prepare machines, init, CNI, join

**Milestone** M4 · **Needs** 28 · Follow the session protocol in `CLAUDE.md`.

## Goal

Build a cluster from bare machines with the real preflight checks, the real order of steps and the
real output. Covers "prepare underlying infrastructure" and "create and manage Kubernetes clusters
using kubeadm".

## Read first

`PLAN.md` §7, §9. Official kubeadm installation and cluster creation documentation. The real
`kubeadm` binary in `.upstream/bin/` runs offline for help text, `config print`, phase lists and
many validation errors: use it as the oracle. Upstream kubeadm sources for preflight and progress
text (search; don't read whole files).

## Build

- **Bare-machine topology**: Ubuntu-like hosts with nothing Kubernetes-related installed.
- **Infrastructure preparation**, each step with real effect on preflight and on the kubelet: swap
  off now and persistently, kernel modules (`overlay`, `br_netfilter`), sysctls for forwarding and
  bridged traffic, installing and configuring containerd (`SystemdCgroup`, the sandbox image,
  generating the default config), adding the Kubernetes package repository for a minor version,
  installing and holding `kubelet`, `kubeadm` and `kubectl`.
- **`kubeadm init`**: preflight checks with their real errors and warnings and
  `--ignore-preflight-errors`; `--pod-network-cidr`, `--service-cidr`,
  `--apiserver-advertise-address`, `--control-plane-endpoint`, `--kubernetes-version`,
  `--cri-socket`, `--node-name`, `--config` with the kubeadm configuration kinds, `--upload-certs`,
  `--dry-run` as a notice; phases that produce every file and object phase 27 expects, by
  generating them, not by copying a finished topology; the real progress output and final
  instructions with a working join command. `kubeadm config print init-defaults|join-defaults`,
  `config images list|pull`, `kubeadm version`.
- **After init**: copying `admin.conf` for the user; nodes NotReady and CoreDNS Pending until a CNI
  is installed.
- **CNI installation**: two modeled plugins installed from manifests, one that enforces
  NetworkPolicy and one that doesn't; a mismatch between the plugin's Pod network and
  `--pod-network-cidr` has its real symptom.
- **`kubeadm join`** for workers: discovery token and CA certificate hash validation with real
  errors, TLS bootstrap through the certificates API, the kubelet starting, the node registering;
  `kubeadm token create` (with `--print-join-command`, `--ttl`), `token list`, `token delete`,
  token expiry against the virtual clock; computing the CA hash by hand with `openssl`.
- **`kubeadm reset`** and removing a node cleanly (`drain`, `delete node`, reset, cleanup notes).
- **Refactor**: the default topology is now produced by running this same init and join logic at
  build time (cached as a snapshot), so the prepared cluster and a hand-built one are identical.
- **Checks**: node joined and Ready, package installed and held, sysctl and module state, cluster
  CIDRs. Add four items: prepare a machine and join it as a worker; fix a join that fails (expired
  token, wrong hash, swap on, runtime misconfigured); initialize a cluster from scratch to a given
  specification (a long lab); drills for the join command and preflight fixes.

## Not in this phase

Upgrades (phase 29b). HA control planes (29c). External etcd, air-gapped installs.

## Exit criteria

- A transcript builds a three-node cluster from bare machines to all nodes Ready and a test Pod
  running, using only the documented commands.
- A simulation test for each skipped preparation step asserts the real preflight error or kubelet
  symptom.
- kubeadm output equals the real binary's wherever the oracle can produce it.
- The hand-built cluster and the default topology have equivalent state (compared in a test,
  ignoring names and addresses).
- The items pass `content:check`.

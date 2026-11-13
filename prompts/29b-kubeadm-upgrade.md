# Phase 29b — kubeadm: cluster upgrade

**Milestone** M4 · **Needs** 29a · Follow the session protocol in `CLAUDE.md`.

## Goal

Take a cluster through a minor-version upgrade with the documented sequence, where every skipped
step leaves its real symptom. "Manage the lifecycle of Kubernetes clusters" is tested this way.

## Read first

`PLAN.md` §9 (version data). Official "Upgrading kubeadm clusters" documentation for the pinned
version, and the version skew policy. Upstream kubeadm sources for `upgrade plan` and `upgrade
apply` output (search; don't read whole files).

## Build

- **Version data for two minors**: the pinned minor and the one before it: component images and
  versions, package versions with their repository layout (one repository per minor), manifests as
  kubeadm generates them for each, and the differences the upgrade applies. Structure it so adding
  a minor later is data, as `prompts/R5-version-bump.md` will require.
- **A topology one minor behind**, built with phase 29a's logic.
- **The sequence on the first control-plane node**: switching the package repository to the new
  minor, `apt-get update`, finding the target patch with `apt-cache madison`, unholding and
  upgrading `kubeadm`, `kubeadm version`, `kubeadm upgrade plan` in the real table layout with its
  notes, `kubeadm upgrade apply vX.Y.Z` with real preflight, progress and success output: new
  static Pod manifests, component restarts in order, CoreDNS and kube-proxy updates, the ConfigMaps
  and RBAC it refreshes, certificate renewal as a side effect.
- **Per node**: drain; `kubeadm upgrade node`; unholding and upgrading `kubelet` and `kubectl`,
  re-holding; `systemctl daemon-reload` and restart; uncordon. The node's reported version changes
  only after the kubelet process is actually restarted with the new binary.
- **Enforcement and symptoms**: version skew rules between kubeadm, the control plane and kubelets
  with the real refusals; trying to skip a minor; an upgraded package with an unrestarted kubelet;
  a held package refusing to upgrade; the old repository offering no newer version; forgetting to
  uncordon; upgrading a worker before the control plane.
- **Checks**: control-plane version, each node's kubelet version, packages held, nodes schedulable,
  workloads still running. Add four items: upgrade the control plane (the classic exam task, graded
  on versions and a healthy cluster), upgrade a worker with zero-downtime workloads, recover a
  half-finished upgrade, drills for `upgrade plan` and the package steps.

## Not in this phase

HA upgrades across several control-plane nodes (touch on them in 29c if cheap). Downgrades.

## Exit criteria

- A transcript performs the full upgrade of the three-node cluster and ends with all nodes on the
  new version and all workloads running.
- A simulation test for each listed mistake asserts its real symptom or refusal.
- `kubeadm upgrade plan` and `upgrade apply` output match upstream formats for the version pair.
- After the upgrade, the cluster state equals what phase 29a builds directly at the new version,
  apart from expected history.
- The items pass `content:check`.

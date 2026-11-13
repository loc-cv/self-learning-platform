# Phase 21 — Storage: PersistentVolumes, claims, StorageClasses, provisioning

**Milestone** M3 · **Needs** 16a, 18a · Follow the session protocol in `CLAUDE.md`.

## Goal

Persistent storage with real binding rules and real data: what a Pod writes to a volume is there
when another Pod mounts it, and a claim that can't bind says why in the real words.

## Read first

`PLAN.md` §7. Upstream PV controller and scheduler volume-binding sources for event strings
(search; don't read whole files). Capture golden cases with the oracle for object output and the
controller's binding behavior.

## Build

- **Objects and binding**: PersistentVolume, PersistentVolumeClaim, StorageClass; matching by
  capacity, access modes, class, selector and `volumeName`; phases and the events for unbound claims;
  claim protection finalizers and why a claim in use stays Terminating.
- **Provisioning**: a dynamic provisioner as a workload with a behavior model (a local-path style
  one in the default topology), the default class annotation, `Immediate` versus
  `WaitForFirstConsumer` and its interaction with the scheduler, provisioning failures when the
  provisioner is down.
- **Reclaim and reuse**: `Retain`, `Delete`, the Released phase and what it takes to reuse a volume.
- **Expansion**: `allowVolumeExpansion`, resizing a claim, conditions shown during resize.
- **Data**: volume contents live in the VFS of the node (or of a shared backend for network-style
  classes), so data survives Pod restarts, follows the access mode rules, and node affinity of local
  volumes constrains scheduling.
- **Volume types and modes**: `hostPath` and `local` volumes with node affinity, an NFS-like shared
  class, access modes including `ReadWriteOncePod`, `volumeMode`, ephemeral generic volumes if cheap.
- **StatefulSet storage**: `volumeClaimTemplates` create claims per replica, retention policy on
  scale-down and deletion.
- **kubectl**: printers and describers for the three kinds, including the columns that change with
  state.
- Extend the X-ray view provider with the claim, volume and Pod chain. Add five items, including a
  Pending Pod caused by an unbound claim and a data-recovery task with a Released volume.

## Not in this phase

CSI drivers as components, snapshots and cloning. Explain them in content; record the omission.

## Exit criteria

- Simulation tests for the binding matrix (capacity, modes, class, selector), both binding modes,
  each reclaim policy, and expansion.
- A file written through one Pod is readable from a replacement Pod and visible on the node's
  filesystem at the backing path.
- Events and `describe pvc` output for the unbound cases match golden or upstream sources.
- A StatefulSet scaled down and up again reattaches each replica to its own data.
- The new items pass `content:check`.

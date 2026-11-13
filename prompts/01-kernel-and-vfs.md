# Phase 01 — Kernel and VFS

**Milestone** M1 · **Needs** 00 · Follow the session protocol in `CLAUDE.md`.

## Goal

Build the deterministic core everything else stands on: virtual time, world state with snapshot,
fork and replay, and simulated machines with a filesystem. Later phases can't fix a weak kernel
cheaply, so correctness and tests matter more here than anywhere.

## Read first

`PLAN.md` §3, §6.1, §6.2. `docs/ARCHITECTURE.md` kernel and host sections.

## Build

**`packages/kernel`**
- World state container: one plain serializable tree, with a registry for state slices owned by plugins.
- Virtual clock and event queue ordered by (time, sequence). Events are `type` plus payload,
  dispatched to handlers registered by type.
- Headless time control: `advance(duration)` and `settle(limit)` (run until no event is due within
  a window). The interactive driver interface is defined here; its wall-clock adapter belongs to the apps.
- Seeded PRNG with named streams whose state lives in the world.
- Snapshot, restore, fork and a canonical hash of the world.
- Input log and replay harness: record inputs stamped with virtual time, replay them into a fresh
  world, compare hashes.
- Trace bus with structured cause records.
- Plugin registry (programs, state slices, event handlers, topology templates, checks, faults).

**`packages/host`** (first part)
- Machine: hostname, users and groups (root and one normal user), environment defaults.
- VFS: directories, regular files, symlinks, modes, owners, timestamps from the virtual clock;
  path resolution with `.`/`..`, symlink following and loop detection; permission checks; errors
  carrying errno names so tools can print real messages.
- Generated files: content computed on read by a registered provider.
- Executable stubs: a file that names a registered program.
- A helper that builds a plausible base filesystem for an Ubuntu-like host.

## Not in this phase

The shell, any program, systemd, networking, anything Kubernetes.

## Exit criteria

- Determinism: the same seed and input log produce the same world hash across runs; snapshot,
  restore, continue equals continue; a fork never affects its parent. All tested.
- Pending events survive snapshot and restore.
- VFS tests cover resolution edge cases, permissions and each error code.
- Measured and recorded in `docs/ARCHITECTURE.md`: fork and hash time for a world of three machines
  with a few thousand files each. Fork must be cheap enough to run on every check (target: under
  10 ms). If it isn't, change the state representation now.

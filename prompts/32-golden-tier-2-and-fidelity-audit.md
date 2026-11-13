# Phase 32 — Golden fixtures from a full cluster, fidelity audit

**Milestone** M5 · **Needs** 07b · Optional · Useful any time after phase 06b; best after 27 · Follow the session protocol in `CLAUDE.md`.

## Goal

The oracle from phase 04 has no real kubelet, so everything a kubelet or a real node says is
`source-derived` at best. A full cluster (kind) closes that gap. This phase builds the capture
tooling for it and audits the whole simulator against everything captured so far.

Capture needs Docker, which my workstation doesn't have. Build and test the tooling so that I can
run one command on any machine with Docker and kind, copy the result back, and have the simulator
checked against it. Everything else in this phase runs here.

## Read first

`docs/FIDELITY.md`. The oracle tooling and case format from phase 04. `npm run fidelity:report` output.

## Build

- **Tier 2 capture**: a self-contained script (bash plus the pinned `kubectl`, no Node required on
  the capture machine) that creates a kind cluster of the pinned version with three nodes, runs
  cases, and writes raw captures into one archive. The same case format as tier 1, extended with
  node-level steps (`docker exec` into a node for `crictl`, `journalctl -u kubelet`, `systemctl
  status kubelet`, files under `/etc/kubernetes` and `/var/lib/kubelet`).
- **Import**: `npm run golden:import -- <archive>` normalizes and stores fixtures under
  `fixtures/golden/<k8s-version>/tier2/`, recording kind and node image versions.
- **Cases** for what only a real node can show: Pod lifecycle events and their messages; container
  status reasons for image errors, crashes, OOM, config errors, probe failures; `kubectl logs`
  errors; `describe pod` and `describe node` on a live node; kubelet journal lines for the failure
  modes of phase 26a (as far as kind allows breaking them); static Pod behavior; `crictl` tables;
  control-plane component logs for bad flags; kubeadm-generated files; real timings for image pulls,
  backoff and probes.
- **Known differences of kind** (containerd in Docker, its CNI, its storage class, node names) are
  written down so they aren't mistaken for simulator divergences.
- **Dry run without Docker**: tests exercise the script's logic against a recorded sample archive,
  so the tooling is known to work before I run it elsewhere.
- **Fidelity audit**, with whatever fixtures exist:
  - run the differential runner across all tiers and triage every difference: fix, or enter it in
    the divergence register with a reason;
  - promote provenance tags to `golden-verified` where a fixture now proves the output;
  - list every unit still `approximate` or unverified, ranked by how often content uses it;
  - review the divergence register for entries that debriefs should mention, and link them.
- `docs/FIDELITY.md`: the capture procedure for me, step by step, and the audit results.

## Not in this phase

Capturing other distributions (RKE2, k3s). New simulator features.

## Exit criteria

- The capture script and import are tested against the sample archive; the step-by-step procedure
  for running the capture elsewhere is in `docs/FIDELITY.md` and in your summary.
- The audit is complete for the fixtures available: zero untriaged differences.
- `npm run fidelity:report` shows counts per tag before and after this phase.
- If I have supplied a tier 2 archive, it is imported and audited too; if not, say plainly what
  remains unverified until I do.

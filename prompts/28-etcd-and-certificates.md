# Phase 28 — etcd backup and restore, kubeadm certificates

**Milestone** M4 · **Needs** 27 · Follow the session protocol in `CLAUDE.md`.

## Goal

Two classic administrator procedures with real consequences: saving and restoring etcd, including
the pitfalls that cost people the exam task, and inspecting and renewing the cluster's certificates.

## Read first

`PLAN.md` §7. The etcd behavior model and PKI tree from phase 27. Official documentation for etcd
backup and restore on kubeadm clusters and for `kubeadm certs`. Download the real `etcdctl` and
`etcdutl` into `.upstream/bin/` for help text, flag validation and error messages; start a
throwaway real etcd through the oracle tooling to capture real command output.

## Build

- **`etcdctl`**: `snapshot save` (requiring endpoints and the three certificate flags as real etcd
  does, with the real errors when they are missing or wrong), `snapshot status` with its
  deprecation message, `snapshot restore` with its deprecation message, `endpoint health`,
  `endpoint status`, `member list`, `get` and `put` with `--prefix` and `--keys-only` over the
  cluster's keys under `/registry` (values shown as opaque, stated as a divergence), `version`,
  `-w table|json`, the `ETCDCTL_API` and environment variable forms.
- **`etcdutl`**: `snapshot restore` with `--data-dir` and the cluster flags, `snapshot status`.
- **Snapshots as data**: a snapshot file in the VFS holds a real copy of the store at that moment.
  Restoring writes a data directory. etcd serves whatever its `--data-dir` (through the manifest's
  host path volume) points at, so the full procedure works and each mistake fails the real way:
  restoring into the live directory, forgetting to change the host path, changing the flag but not
  the volume, wrong ownership, leaving the API server running, stale static Pod containers.
- **After a restore**: objects created after the snapshot are gone; kubelets and controllers
  reconcile the restored state against what is running, with the effects a real cluster shows.
- **`kubeadm certs`**: `check-expiration` in the real table layout, `renew all` and per
  certificate, the reminder that components must be restarted, `generate-csr` as a notice;
  `kubeadm kubeconfig user` to issue a kubeconfig; renewing `admin.conf` and copying it to
  `~/.kube/config`. Manual inspection with `openssl` agrees with kubeadm's table.
- **Kubelet certificates**: client rotation and what to do when it has lapsed; kubelet serving
  certificates and their CSR approval in simple form.
- **Faults and checks**: snapshot exists and is valid, cluster state equals a given snapshot,
  certificate validity beyond a date. Add six items: back up etcd to a path, restore a cluster to a
  snapshot (graded on the restored state and a healthy cluster), a restore gone wrong to repair,
  check expirations, renew certificates and recover kubectl access, an incident a year in the
  future where everything has expired.

## Not in this phase

Multi-member etcd operations and external etcd (phase 29c covers HA). etcd defragmentation,
compaction, encryption at rest: record as omissions or leave to content as explanation.

## Exit criteria

- The documented backup and restore procedure works end to end in a transcript, and a simulation
  test for each listed mistake asserts its real symptom.
- After a restore, an object created after the snapshot is absent and one deleted after it is back.
- `kubeadm certs check-expiration` matches `openssl x509 -enddate` for every certificate, before
  and after renewal, and components keep failing until restarted, as in reality.
- Command output for `etcdctl` and `etcdutl` equals captured real output.
- The items pass `content:check`.

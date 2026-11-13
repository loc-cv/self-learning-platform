# Phase 26b — crictl, node operations, node troubleshooting content

**Milestone** M4 · **Needs** 26a, 20b · Follow the session protocol in `CLAUDE.md`.

## Goal

The tools for working on a node and taking it in and out of service, and the first set of node
troubleshooting incidents built on phase 26a.

## Read first

`docs/AUTHORING.md`. Upstream `kubectl drain` sources for its messages (search; don't read whole
files). Download the real `crictl` into `.upstream/bin/` for help text and flag validation. The
oracle's real API server handles cordon, taint and the eviction API: capture golden cases.

## Build

- **`crictl`**: `ps` (`-a`, `--name`, `--pod`, `--state`), `pods` (`--name`, `--namespace`),
  `images`, `inspect`, `inspectp`, `inspecti`, `logs` (`-f`, `--tail`, `-p`), `stop`, `rm`, `stopp`,
  `rmp`, `rmi`, `pull`, `exec` (reusing the container shell from phase 17), `stats`, `info`,
  `version`, with real table layouts; `/etc/crictl.yaml` and `--runtime-endpoint`, and the real
  errors when the endpoint is wrong or the runtime is down. Containers removed by hand are
  recreated by the kubelet as in reality.
- **kubectl node operations**: `cordon`, `uncordon`, `drain` with `--ignore-daemonsets`,
  `--delete-emptydir-data`, `--force`, `--grace-period`, `--timeout`, `--pod-selector`,
  `--disable-eviction`; the eviction API honoring PodDisruptionBudgets with the real retry
  messages; every real refusal message (DaemonSet-managed Pods, Pods with local storage, bare Pods);
  `taint` (add, overwrite, remove with the trailing minus, all effects, `NoExecute` evicting
  running Pods with `tolerationSeconds`); `label node`, `annotate node`; `describe node` reflecting
  conditions, taints, allocated resources and events from phase 26a; `get nodes -o wide`;
  `kubectl debug node/…` as a notice unless cheap.
- **Checks**: node Ready or NotReady, schedulable or cordoned, drained, static Pod running,
  container running on a node.
- **Content**, following `docs/AUTHORING.md`, each with several fault variants:
  - three NotReady incidents whose root cause is drawn from the fault family of phase 26a;
  - a static Pod task (create one on a named node; find and fix a broken one);
  - a maintenance task: drain a node safely, blocked first by a PodDisruptionBudget and a bare Pod;
  - an incident solved with `crictl` and node logs when the API view is unhelpful;
  - a lesson on the kubelet's inputs with a guided tour of the node's files, and drills for
    `systemctl`, `journalctl -u kubelet` and `crictl`.

## Not in this phase

Control-plane component failures (phase 27).

## Exit criteria

- `kubectl get pods -o wide`, `crictl ps` on each node and `/var/log/pods` agree at all times,
  including during restarts (tested).
- `drain` transcripts cover success and each refusal, verified against golden cases where the API
  server is the source of the message.
- `NoExecute` taints evict running Pods on the real schedule.
- All new items pass `content:check` on several seeds and fault variants, and each incident is
  solvable from the terminal alone with X-ray off.
- `docs/COVERAGE.md` regenerated.

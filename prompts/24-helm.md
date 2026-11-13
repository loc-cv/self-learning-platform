# Phase 24 — Helm

**Milestone** M3 · **Needs** 20c, 18b · Follow the session protocol in `CLAUDE.md`.

## Goal

Helm as both exams use it: find a chart, inspect and override its values, install, upgrade, roll
back and uninstall, and debug a release that went wrong. Rendering must be real enough that
changing a value changes the workload.

## Read first

`PLAN.md` §6.3, §9. Download the real `helm` binary of a current version into `.upstream/bin/` and
use it as an offline oracle: `helm template`, `helm show`, `helm lint` and help text need no cluster.

## Build

- **Template engine**: an implementation of the Go template subset that charts in the catalog use:
  actions, pipelines, variables, `if`/`else`, `range`, `with`, `define`/`template`/`include`,
  whitespace control, comparison and logic functions, and the Sprig and Helm functions in common
  use (`default`, `required`, `quote`, `toYaml`, `nindent`, `indent`, `trim`, `trunc`, `printf`,
  `tpl` if cheap, `lookup` as empty), with `.Values`, `.Release`, `.Chart`, `.Capabilities`.
  An unsupported function fails with a `[sim]` notice naming it, never with wrong output.
- **Charts**: chart structure (`Chart.yaml`, `values.yaml`, `templates/`, `_helpers.tpl`,
  `NOTES.txt`, `crds/`, dependencies already vendored); a catalog of a few realistic charts written
  for the simulator (a web application, a database, metrics-server, the sample operator, and
  ingress-nginx if phase 19b is done) served from simulated repositories; charts on the local
  filesystem, including ones I write or edit.
- **Commands**: `repo add|list|update|remove`, `search repo` (with `--versions`), `show
  chart|values|readme|all`, `pull` (with `--untar`), `template`, `lint`, `install` (name or
  `--generate-name`, `-n`, `--create-namespace`, `-f`, `--set`, `--set-string`, `--version`,
  `--dry-run`, `--wait`, `--timeout`), `upgrade` (with `--install`, `--reuse-values`,
  `--reset-values`, `--atomic` if cheap), `rollback`, `uninstall`, `list` (`-A`, `-a`, filters,
  `-o`), `status`, `history`, `get values|manifest|notes|all`, `create`, `env`, `version`.
- **Releases**: stored as Secrets in the release namespace like real Helm 3, with revisions and
  statuses (`deployed`, `superseded`, `failed`, `pending-…`); three-way merge on upgrade; hooks in
  simple form (pre and post install as Jobs) or a notice; ownership labels and annotations.
- Output formats and messages equal the real binary's wherever the oracle can produce them.
- Add five items: install a chart with overridden values, upgrade and roll back, find why a release
  failed, discover a chart's values to change a setting, render templates to inspect what would
  be applied.

## Not in this phase

OCI registries, chart signing, plugins, library charts, post-renderers. Notices cover them.
Writing charts in depth belongs to a later Helm domain (`prompts/R4-new-domain.md`).

## Exit criteria

- For every chart in the catalog and a matrix of value overrides, the simulator's `helm template`
  output equals the real binary's.
- A release lifecycle transcript (install, upgrade with a bad value, failed status, rollback,
  history, uninstall) matches real Helm's output formats.
- Release Secrets are visible with kubectl and removing one makes Helm forget the revision.
- `--set` and `-f` precedence matches the real tool across a test table.
- The new items pass `content:check`; the divergence register lists unsupported template functions.

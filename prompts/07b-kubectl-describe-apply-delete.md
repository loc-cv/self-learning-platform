# Phase 07b — kubectl I: describe, create, apply, delete

**Milestone** M1 · **Needs** 07a · Follow the session protocol in `CLAUDE.md`.

## Goal

Complete the declarative kubectl loop on top of the framework: inspect an object in depth, create
it from a file, change it with apply, remove it. `describe` is where troubleshooting happens, so its
layout and its events section must be exact.

## Read first

`docs/FIDELITY.md`, `docs/COVERAGE.md`. Golden fixtures for `describe`, apply and delete. Upstream
describers in `.upstream/` (search; don't read whole files).

## Build

- **`describe`** for Pod, Deployment, Service and Node, with their events sections, by name, by
  selector and by prefix match, plus the messages for no match. Other kinds print a `[sim]` notice
  until phase 15 adds them.
- **`create -f`**: files, directories, URLs refused with a notice, stdin, multi-document YAML and
  JSON; the real messages for already-exists, validation failures and parse errors (including the
  YAML line reference).
- **`apply -f`**: client-side apply with the last-applied-configuration annotation and three-way
  merge; created, configured and unchanged; the warning when applying to an object that lacks the
  annotation; `-R`; `--dry-run=client|server`; `-o`.
- **`delete`**: by name, type and name, file, selector and `--all`; waiting for finalization by
  default; `--wait=false`, `--force`, `--grace-period`, `--now`, `--ignore-not-found`, and the real
  output for each, including the force-delete warning.
- **`docs/COVERAGE.md`**: generate the supported and unsupported commands and flags from the
  command manifest and the framework's registrations, so it is never hand-kept.

## Not in this phase

Imperative verbs, logs, rollout, explain, edit, completion (phase 08).

## Exit criteria

- Every golden case for `describe`, `create`, `apply` and `delete` in scope passes the differential
  runner or is in the divergence register.
- Transcripts cover apply's three outcomes, a three-way merge that removes a field, a manifest with
  an unknown field, a manifest with a YAML syntax error, and delete of an object with dependents.
- `describe pod` for a Pending, a Running and a crash-looping Pod matches sources, including the
  events table and its age format.
- In the terminal player, I can create a Deployment from a file, watch its Pods start, describe one
  and delete it, and nothing looks different from a real cluster. Show the session output.

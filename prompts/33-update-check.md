# Phase 33 — Update check and version bump tooling

**Milestone** M5 · **Needs** 14 · Follow the session protocol in `CLAUDE.md`.

## Goal

The exams move to each new Kubernetes minor within weeks of its release, and the curricula change
now and then. Build the tool that notices and tells me what needs changing, and make the version
bump a procedure instead of an adventure.

## Read first

`PLAN.md` §9. `docs/FIDELITY.md`. `docs/curriculum/`. `prompts/R5-version-bump.md` (improve it
with what you learn here).

## Build

- **`npm run update:check`** (needs network; never part of the gate). It compares and reports:
  - the pinned Kubernetes version against the latest patch of that minor and the newest minor;
  - the version the CKA and CKAD exam pages state, against the pin;
  - the official curriculum documents (file names and checksums in `cncf/curriculum`) against the
    recorded ones, with a text diff of competencies when they changed;
  - for a newer minor: the release notes' sections that matter here (API removals and deprecations,
    kubectl changes, kubeadm changes, changed defaults, graduated features touching simulated
    behavior), mapped where possible to simulator modules and content items by keyword and by API
    kind;
  - the versions of the tools the oracle uses (etcd, Helm, crictl, kind, Gateway API CRDs) against
    current releases.
  It writes `docs/update-reports/<date>.md` with findings ranked by urgency and a suggested action
  for each, and exits with a distinct code when action is needed.
- Parsing is defensive: when a page's structure changed and something can't be determined, the
  report says so instead of guessing.
- **Version inventory**: one generated file listing everything version-dependent in the repository
  (the pin, vendored schema data, per-version manifests and package data, fixtures, content items
  that mention a version), so a bump knows what to touch. A test fails when version-dependent data
  exists outside the per-version locations.
- **Content hooks**: items may declare the versions they are valid for and the API kinds they
  rely on; the report lists items affected by a removal or a changed default.
- **Scheduling**: document in `docs/FIDELITY.md` how to run the check on a schedule with Claude
  Code so a report lands monthly, and what to do with it.
- Run it once now and act on trivial findings; list the rest in `STATUS.md`.

## Not in this phase

Performing a bump (that is `prompts/R5-version-bump.md`). Automatic changes to the simulator.

## Exit criteria

- The check runs against live sources and produces a correct report today; tests cover its parsers
  with saved pages, including a changed curriculum and a new minor.
- With the network down it fails clearly and writes nothing misleading.
- The version inventory is complete: changing the pin constant in a scratch branch makes exactly
  the expected tests fail, pointing at per-version data, and nothing else.
- `prompts/R5-version-bump.md` reflects the real steps.

# Phase 34 — Linux pack and the adding-a-domain guide

**Milestone** M5 · **Needs** 25b, 12 · Can run any time after 25b · Follow the session protocol in `CLAUDE.md`.

## Goal

Prove the platform is extensible by adding a second domain, and write down how it was done. Linux
is the natural first: the host substrate already simulates it, so this phase is mostly a plugin
boundary check and content. If adding it requires changing `kernel`, `learn` or the apps for
domain-specific reasons, that is a design defect to fix here, before more domains arrive.

## Read first

`PLAN.md` §6.4. `docs/ARCHITECTURE.md` plugin registry. `docs/AUTHORING.md`. `docs/LEARNING_MODEL.md`.

## Build

- **A `linux` content pack**, separate from the Kubernetes pack: its own skills, track and
  topologies (a single server; two servers that talk to each other), using only `packages/host`.
- **Skills and items** for server operations I use daily, about twenty items across lessons,
  drills, labs and incidents: services and units (write a unit, fix a failing one, restart
  policies, enablement), logs (`journalctl` filtering, finding the cause of a crash), processes
  and signals, permissions and ownership, users and sudo, packages and holds, networking basics
  (listening ports, name resolution, routes, "connection refused versus timeout"), disk usage,
  text processing on logs, SSH between hosts. Include three incidents with chained causes.
- **Substrate gaps**: whatever these items need that the host lacks, add in `packages/host` with
  transcripts verified against the real tools on this workstation. Keep it to what the items use.
- **Extensibility audit**: search the code for Kubernetes knowledge outside `packages/k8s` and its
  content pack (in `kernel`, `host`, `learn`, the apps, tooling, the X-ray UI, exam assembly,
  coverage reports, the home screen's domain grouping). Move each finding behind the plugin
  contract. The app must run with only the Linux pack loaded, and with both.
- **`docs/ADDING_A_DOMAIN.md`**: the contract and a step-by-step checklist: state slice, behavior
  models, programs, completions, checks and faults, topologies, view provider, package catalog
  entries, oracle strategy for ground truth, content pack, skills and tracks, coverage and fidelity
  registration, tests. Include a decision guide for what to model versus leave out, and worked
  sketches of how two later domains would fit: Nginx (a host service with a config parser and a
  behavior model; HA with a second host) and AI model hosting (GPU resources on nodes, a model
  server behavior model, a device plugin in the Kubernetes plugin).
- **`prompts/R4-new-domain.md`**: revise it to match what this phase learned.

## Not in this phase

Networking in depth (firewalls, routing labs), storage management, performance tools, security
hardening: later runs of R1 for the Linux pack, driven by what I want to learn.

## Exit criteria

- The app runs with only the Linux pack: home, daily session, items, X-ray (generic host view),
  debrief, and a short exam assembled from Linux items if phase 31 is done.
- A lint rule or test fails if `kernel`, `host` or `learn` imports a domain package, or if an app
  names a domain-specific concept outside its one wiring module.
- All Linux items pass `content:check`; `content:coverage` reports per pack.
- `docs/ADDING_A_DOMAIN.md` is complete enough that the Nginx sketch could be started from it alone.
- List every core change this phase needed and why, in your summary and in `docs/decisions.md`.

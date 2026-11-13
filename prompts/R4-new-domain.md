# R4 — New domain (repeatable, three sessions per domain)

**Needs** phase 34 · Follow the session protocol in `CLAUDE.md`.

**Domain:** `<for example: nginx, helm-authoring, argocd, model-hosting, vault, rke2>`
**Stage for this session:** `<A spec | B engine | C content>` (a large domain may need B more than once)

## Goal

Add a learning domain as a plugin package plus a content pack, without changing the core. Each
domain goes through three stages, one session each, so that what to simulate is decided before
anything is built.

## Read first

`docs/ADDING_A_DOMAIN.md`, `PLAN.md` §3, §4.3, §6. For stages B and C, the domain's spec from stage A.

## Stage A — Spec (research and design, no engine code)

1. **Ask me first**, in one short batch: what I want to be able to do with this technology at work,
   what I already know, which version and deployment style I use, and which incidents I've met.
2. **Research** the current stable version and the official documentation on the web. Record
   sources and the version to pin.
3. **Write `docs/domains/<domain>/SPEC.md`**:
   - skills worth learning, as a graph with prerequisites, and the real-world tasks and incidents
     they serve;
   - the model: state, behavior models, programs with the commands and flags to support, config
     file formats to parse, how it attaches to hosts and (if relevant) to the Kubernetes plugin;
   - what is deliberately not simulated, and how content will stay honest about it;
   - the ground-truth strategy: which real binaries can run on this workstation as an oracle
     (without Docker), what must come from upstream source or documentation;
   - topologies, checks, faults, view provider;
   - a content outline (tracks, item counts per type) and five fully worked example items;
   - the build split: what fits in one stage B session and what needs another.
4. Confirm the spec with me before ending the session.

## Stage B — Engine

Build the plugin package to the spec: state slice, behavior models, programs with completion,
checks, faults, topologies, package catalog entries, view provider, coverage and provenance
registration, oracle tooling and golden fixtures, transcripts and simulation tests. The five
example items from the spec become real content and must pass `content:check`. Core packages change
only for domain-neutral improvements, each recorded in `docs/decisions.md`.

## Stage C — Content

Run as `prompts/R1-content-pack.md` does, with this domain's pack and skills as the target: plan
from coverage, write complete items, play each one, sequence the track, validate.

## Exit criteria

- **A**: the spec exists, pins a version with sources, states its non-goals, and I confirmed it.
- **B**: `npm run check` is green; the domain's golden and transcript tests pass; the boundary lint
  from phase 34 passes; the app works with this pack alone and together with the others; the five
  example items pass `content:check`.
- **C**: as in R1.
- Every stage updates `STATUS.md`, and `docs/ADDING_A_DOMAIN.md` if the procedure taught something.

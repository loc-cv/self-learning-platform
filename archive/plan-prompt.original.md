# Project: Personal Infra/DevOps Learning Simulator — Planning & Spec Phase

## Who I am
I'm a DevOps/infrastructure engineer. I run production RKE2 Kubernetes, Nginx HA, Consul, ArgoCD, Vault, GitLab CI, and Linux servers. This platform is for me only (single user, no auth, no multi-tenancy). It's for learning Infra/DevOps in depth, starting with Kubernetes to cover the full CKA and CKAD curricula plus real-world operational practice.

## The idea
A self-learning platform where I learn by doing inside a **simulated** environment. There are no real clusters or VMs behind it. It should feel as real as possible: I type real commands into a terminal and get realistic output, I break and fix things, and I troubleshoot realistic failures. Theory is present but secondary to hands-on labs.

## Core architectural principle (non-negotiable)
This must be a **state engine**, not a canned-response replayer.
- The simulator holds a model of the environment (cluster objects, nodes, node filesystems, services, processes, logs, events).
- Commands are parsed and executed against that state: reads render from state, writes mutate it.
- Simulated controllers reconcile state the way the real system would (Deployment→ReplicaSet→Pods, scheduler with taints/tolerations/affinity/resources, endpoints from selectors, kubelet-driven pod status, etc.).
- Labs are graded by checking **final state**, not by matching the commands I typed. Any valid solution path should work.
- Pre-saved data is used for **presentation fidelity**: exact output formats, column layouts, `describe` layouts, event/error message strings. It is not used as the source of behavior.

## Scope
**Phase 1 domain: Kubernetes (CKA + CKAD), at full depth.** This includes:
- kubectl, at broad coverage of verbs, flags, output formats (`-o wide/yaml/json/jsonpath`), selectors, `explain`, `edit`, `apply`/`create`/`patch`, `--dry-run=client -o yaml`, `rollout`, `auth can-i`, etc.
- **Node-level work** needed for CKA: a simulated Linux node shell with a virtual filesystem, `systemctl`, `journalctl`, kubelet config, `/etc/kubernetes/manifests` static pods, certificates, `crictl`, `etcdctl` backup/restore, `kubeadm` upgrade flow, and SSH between nodes.
- Real-world fault scenarios beyond the exam. Examples: Pending pods (taints, quotas, no StorageClass), Services with no endpoints, NetworkPolicy drops, CoreDNS failures, NotReady nodes (kubelet down, expired certs), RBAC Forbidden, stuck rollouts from failing probes, broken static pod manifests, etcd restore pitfalls. Scenarios can chain multiple faults.

**Later domains** (design the engine so these plug in as modules, but don't spec them in detail yet): Linux/networking, Nginx, Terraform, ArgoCD/GitOps, Vault, CI/CD, Kafka.

## UX direction (open to your counter-proposal)
I'm leaning toward a local web app:
- A real terminal in the browser (xterm.js or similar)
- A lesson/ticket panel
- An optional live visualization of cluster state (nodes, pods, services, health) that I can turn off for exam-style practice
- A timed mock-exam mode
- Progress tracking

A TUI is an acceptable alternative if you make a strong case. It runs locally on my machine.

## Fidelity & correctness strategy (must be addressed in the spec)
- Output realism should be grounded in authoritative sources, not memory. Primary source: kubectl/Kubernetes source code and official docs. Optional higher-fidelity source: a "golden fixture" capture script I can run against a throwaway kind cluster (once per K8s version) to record real outputs and errors. The platform must work fully without the capture step; outputs not verified against a real capture should be tagged as such.
- Pin a target Kubernetes version and design how version bumps are handled.
- Design an "update check" process that compares the platform against upstream Kubernetes release notes and the current official CKA/CKAD curricula and produces a list of needed changes. I may run it as a recurring scheduled job later.

## What I want from THIS session (planning only, no platform implementation)
1. **Ask me clarifying questions first** about anything that materially changes the design. Batch them and keep them few. Include this one: should the learning platform's own content (lessons, tickets, hints, explanations) be bilingual like the docs, or only the planning docs? The answer affects the scenario file format.
2. **Research the current official CKA and CKAD curricula** (CNCF/Linux Foundation sources) and the current stable Kubernetes version. Use the web; don't rely on memory. Cite sources.
3. Write these planning documents in English first, in `docs/en/`:
   - `VISION.md`: goals, non-goals, principles, what "feels real" means in measurable terms.
   - `ARCHITECTURE.md`: components (state store, command parser/dispatcher, controllers/reconcile loop, node/OS simulator, renderers, scenario runner, grader, UI, persistence), data flow, the tech stack with alternatives and tradeoffs, and how new domains plug in.
   - `STATE_MODEL.md`: how cluster and node state is represented, how time/reconciliation ticks work, and how determinism and reset/snapshot work.
   - `SCENARIO_FORMAT.md`: a scenario/lab file schema (initial state, injected faults, ticket text, hints, success checks, solution notes, curriculum tags) with 3 fully worked examples: one CKAD workload task, one CKA node troubleshooting task, and one chained real-world incident.
   - `CURRICULUM_MAP.md`: every CKA and CKAD domain/competency mapped to the planned lessons, labs and simulator features it requires. Flag the features with the highest simulation difficulty.
   - `COMMAND_COVERAGE.md`: the kubectl and node commands and flags to support in v1 vs. later, with a rationale.
   - `FIDELITY.md`: output sources, the optional golden-fixture capture pipeline, testing strategy, version pinning, and the update-check process.
   - `ROADMAP.md`: phased milestones with clear exit criteria. Milestone 1 must be a thin vertical slice (engine + ~10 kubectl verbs + 3 working labs) I can try within days, to validate whether it "feels real" before building breadth.
   - `RISKS.md`: the hardest problems and where the simulation will inevitably diverge from reality, with how each is mitigated or made explicit to me.
4. Build the bilingual documentation site described below, and translate all docs to Vietnamese.
5. Finish with a short summary and a `CLAUDE.md` for this repo (conventions, how to run tests, how to add a scenario, the docs and translation workflow) so future sessions stay consistent.

## Documentation format: bilingual HTML site
The planning docs must be readable as a local static HTML site, and must support multiple languages.

Source structure:
- Markdown stays the source of truth: `docs/<lang>/<DOC>.md`, e.g. `docs/en/ARCHITECTURE.md` and `docs/vi/ARCHITECTURE.md`.
- English (`en`) is canonical: write it first, then translate. Vietnamese (`vi`) is the first translation.
- Languages are defined in one config file (e.g. `docs/languages.json` with code, display name, and order). Adding a language means adding one config entry plus a `docs/<lang>/` folder, with no code changes.
- Every heading has a stable, language-independent ID (e.g. `{#state-model-ticks}`) that is identical across languages. Side-by-side alignment depends on these IDs.

Site requirements:
- A build script generates a static site into `site/` (e.g. `make docs`). It must work fully offline, with no CDN dependencies.
- View modes: **side by side** (one column per selected language, aligned section by section using the shared heading IDs), or **single language**. A toggle switches between EN / VI / both, extensible to N languages. Remember the choice in localStorage.
- Navigation sidebar listing all docs, a per-page table of contents, and search across the docs.
- Render Mermaid diagrams for architecture and data-flow visuals. Use diagrams wherever they explain better than prose (component architecture, reconcile loop, scenario lifecycle, roadmap).
- Readable code blocks with syntax highlighting. Dark mode.
- If a section is missing or outdated in a language, show it clearly in that column (e.g. "not yet translated" or "translation outdated"), never silently blank.

Translation rules:
- Vietnamese should read naturally for a Vietnamese DevOps engineer, not word-for-word.
- Keep technical terms, Kubernetes resource names, commands, flags, file paths and code blocks in English (e.g. Pod, Deployment, kubelet, `kubectl rollout`). Don't translate them. Code blocks are identical across languages.
- Track translation freshness: each translated section records a hash of the English section it was translated from. A check script (e.g. `make docs-check`) lists sections that are missing or outdated. CLAUDE.md must state that any English doc change requires updating the translations, or the check fails.

Pick the site tooling yourself and justify it. Note that most doc generators handle multiple languages as separate pages, not side by side, so a small custom generator may be simpler. Keep it lightweight and easy to maintain. After building, open the site and verify that side-by-side alignment, the language toggle, search and diagrams all work.

## Constraints & preferences
- Keep it maintainable by one person plus Claude Code. Favor simple, well-tested components over clever ones.
- Make the engine deterministic and testable: every lab should be runnable headlessly in CI with a scripted "reference solution" that must pass the grader.
- No cloud dependencies. It runs fully offline once built.
- Be honest about tradeoffs and limits. Don't over-promise fidelity.

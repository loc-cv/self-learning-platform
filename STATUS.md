# Status

How to run a phase: open a new Claude Code session in this folder and send
`Execute the phase in prompts/<file>.md`. One phase per session. Each session updates this file.

Run phases in the order listed. Numbers group topics; a letter suffix means a topic was split to
fit one session. Notes in parentheses say where the order is flexible.

Legend: `[ ]` not started · `[~]` partly done, see carry-over · `[x]` done

## Phases

**M0 — Foundations**
- [x] 00 `prompts/00-bootstrap-and-specs.md`

**M1 — Thin vertical slice**
- [x] 01 `prompts/01-kernel-and-vfs.md`
- [x] 02 `prompts/02-shell-and-coreutils.md`
- [x] 03 `prompts/03-tty-and-terminal-player.md`
- [ ] 04 `prompts/04-oracle-and-golden-fixtures.md` (needs only 00; can run earlier)
- [ ] 05a `prompts/05a-k8s-api-store-and-pipeline.md`
- [ ] 05b `prompts/05b-k8s-controllers.md`
- [ ] 06a `prompts/06a-topology-and-scheduler.md`
- [ ] 06b `prompts/06b-kubelet-runtime-behavior-models.md`
- [ ] 07a `prompts/07a-kubectl-framework-and-get.md`
- [ ] 07b `prompts/07b-kubectl-describe-apply-delete.md`
- [ ] 08 `prompts/08-kubectl-2.md`
- [ ] 09 `prompts/09-scenarios-and-first-labs.md`
- [ ] 10 `prompts/10-web-app.md`
- [ ] **Checkpoint A** — play the three labs, write `FEEDBACK.md`, then run `prompts/R3-feedback-and-gap-triage.md`

**M2 — Learning loop**
- [ ] 11 `prompts/11-learning-core.md`
- [ ] 12 `prompts/12-learning-ui.md`
- [ ] 13 `prompts/13-xray-and-time-controls.md`
- [ ] 14 `prompts/14-curriculum-map-and-authoring.md`
- [ ] R1 run, target `k8s-foundations`
- [ ] **Checkpoint B** — use the daily session for a week, write `FEEDBACK.md`, run R3

**M3 — Application-level Kubernetes**
- [ ] 15 `prompts/15-kubectl-3.md`
- [ ] 16a `prompts/16a-pod-configuration-and-volumes.md`
- [ ] 16b `prompts/16b-probes-resources-security.md`
- [ ] 17 `prompts/17-exec-and-network-model.md`
- [ ] 18a `prompts/18a-job-cronjob-daemonset-statefulset.md`
- [ ] 18b `prompts/18b-strategies-metrics-autoscaling.md`
- [ ] 19a `prompts/19a-service-types-and-networkpolicy.md`
- [ ] 20a `prompts/20a-identity-and-rbac.md`
- [ ] 20b `prompts/20b-admission-quotas-scheduling-policy.md`
- [ ] 20c `prompts/20c-crds-operators-deprecations.md`
- [ ] 19b `prompts/19b-ingress-and-gateway-api.md` (after 20c: Gateway API resources are CRDs)
- [ ] 21 `prompts/21-storage.md`
- [ ] 22a `prompts/22a-shell-control-flow-and-text-tools.md` (any time after 03)
- [ ] 22b `prompts/22b-awk-jq-pager.md` (any time after 22a)
- [ ] 23 `prompts/23-kustomize-and-image-builds.md`
- [ ] 24 `prompts/24-helm.md`

**M4 — Node-level Kubernetes**
- [ ] 25a `prompts/25a-systemd-processes-ssh.md`
- [ ] 25b `prompts/25b-packages-sysconfig-pki.md`
- [ ] 26a `prompts/26a-kubelet-and-runtime-on-nodes.md`
- [ ] 26b `prompts/26b-crictl-and-node-operations.md`
- [ ] 27 `prompts/27-control-plane-static-pods.md`
- [ ] 28 `prompts/28-etcd-and-certificates.md`
- [ ] 29a `prompts/29a-kubeadm-init-and-join.md`
- [ ] 29b `prompts/29b-kubeadm-upgrade.md`
- [ ] 29c `prompts/29c-ha-control-plane.md`
- [ ] 30 `prompts/30-cluster-networking-troubleshooting.md`

**M5 — Exams, fidelity, extensibility**
- [ ] 31 `prompts/31-exam-mode.md` (possible after 14; worth it once several R1 runs exist)
- [ ] 32 `prompts/32-golden-tier-2-and-fidelity-audit.md` (optional; capture needs a machine with Docker)
- [ ] 33 `prompts/33-update-check.md` (any time after 14)
- [ ] 34 `prompts/34-linux-pack-and-domain-guide.md` (any time after 25b)
- [ ] 35 `prompts/35-coach-skill.md` (any time after 14)

## Repeatable prompts

Edit the target line at the top of the prompt file, or name the target in your message
(`Execute prompts/R1-content-pack.md for target ckad-deployment`).

- `prompts/R1-content-pack.md` — content for one area. Interleave runs with engine phases once the
  features a target needs exist. Runs completed: none
- `prompts/R2-translation-pass.md` — Vietnamese translation. Runs completed: none
- `prompts/R3-feedback-and-gap-triage.md` — fix what `FEEDBACK.md` and the gap log report
- `prompts/R4-new-domain.md` — add a domain (three stages)
- `prompts/R5-version-bump.md` — move to a new Kubernetes version

## Temporary shortcuts in the engine

Seeded or simplified behavior that a later phase must replace. Each session adds and removes entries.

- **Link protections are constants** (`PROTECTED` in `packages/host/src/vfs/fs.ts`: Ubuntu's
  `protected_hardlinks = 1`, `protected_symlinks = 1`, `protected_regular = 2`). Phase 25b reads
  them from the machine's sysctl table.
- **`/proc` and `/sys` are empty directories, and `/dev` holds only `null`.** `ls /proc` prints
  nothing, which no real machine does. Phase 25a makes `/proc` a provider mount with processes;
  `/dev` entries come with the phases that need them (`/dev/tty` and `/dev/pts/N` with the first
  consumer, at the latest phase 25a's `tty` and `ps` TTY column; phase 03 did not need them;
  `/dev/zero` and `/dev/urandom` produce binary data, DIV-002, and wait for a consumer).
- **No `/etc/shadow`, `/etc/gshadow` or `/etc/hosts`** (D-020). Shadow files come in phase 25a
  with passwords, `su` and `sudo`; `/etc/hosts` in phase 17.
- **Startup files are not read** (D-025, DIV-003): a login shell starts as `bash --noprofile
  --norc`, so Ubuntu's `ll`/`la` and `--color=auto` aliases do not exist. Phase 22a (control flow)
  sources `/etc/profile`, `~/.profile` and `~/.bashrc`, and then removes two stand-ins:
  - the login prompt is set by `packages/host/src/shell/startup.ts` to what Ubuntu's `~/.bashrc`
    would leave (D-031);
  - bash-completion (which Ubuntu's `.bashrc` loads) is reproduced by completers: builtin ones in
    `shell/complete.ts` (`cd`, `pushd`) and `ProgramSpec.complete`. These stay after 22a, since our
    bash will not run bash-completion's scripts; 22a only stops pretending the files ran.
- **`/bin/sh` is dash, which is not simulated**: `sh -c`, `egrep`, `fgrep`, `zgrep` and scripts
  without `#!` run through `env` reach the "not simulated" stub. No phase owns dash yet; R3 decides
  when learners hit it.

## Carry-over

Unfinished work from a phase, precise enough for the next session to continue.

- **Phase 02, program names in messages (DIV-011).** GNU tools print their `argv[0]` as typed.
  `programs/lib/io.ts` (`parseArgs`, `warn`, `usageError`), `lib/argmatch.ts` and about 25 programs
  that write `${p.name}:` use the base name instead, and the captured `--help` texts hard-code
  `Usage: <name>`. Fix by giving `ProcApi` the invocation name (argv[0], without a login dash)
  and using it in those helpers, programs and help texts (misc's echo/printf/test already
  substitute argv[0] with a `\u0000` placeholder; copy that). Add a transcript that runs
  `/usr/bin/sleep x` and `/bin/cat --help | head -1`. Owner: the next session that touches
  coreutils, or R3.

## Handoff notes

Newest first. Each session adds: what was built, decisions made, surprises, known gaps.

- 2026-11-16 — **Phase 03 done.** Terminal, line editor, completion, editor protocol, `play` and `sim`.
  - Built: the line discipline and readline's emacs mode in the engine (`packages/host/src/tty/`:
    `discipline.ts`, `editor.ts`, `display.ts`, `keys.ts`, `bindings.ts`, `complete.ts`; `screen.ts`
    is a terminal model for tests and script mode). bash reads with `ProcApi.readLine`, decodes and
    expands PS1/PS2 (`shell/prompt.ts`), completes through `shell/complete.ts`, honors
    `--noediting`, and sets `$?` to 130 after Ctrl-C at the prompt. The editor protocol
    (`proc/editor.ts`, inputs `editor.save`/`editor.close`, output records `editor.open`/
    `editor.status`) and the programs `vim` and `nano` (`programs/editors/`). The base system gained
    vim, vim-tiny, nano and sensible-utils with their alternatives (`editor`, `vi`, `vim`, `view`,
    `ex`, `pico`, plus `pager`, `rmt`, `nawk` that the old hand-written table missed), read from the
    packages' maintainer scripts. `apps/cli`: `play.ts` (raw-mode player, `$EDITOR`, recording,
    `--replay`), `sim.ts` (script mode), `player.ts`/`script.ts` (their testable cores), the
    topology `ubuntu-1` (`packages/host/src/topology.ts`). Kernel: `OutputRecord` is a union,
    registry kind constants (`TOPOLOGY`, …), `ENGINE_VERSION` 0.2.0, host slice version 2.
  - Exit criteria. Key-level tests: `tty/editor.reference.test.ts` replays 38 cases captured from
    real bash 5.2.21 on a pty (`fixtures/reference/bash/readline.{py,json}`) and requires the same
    screen and cursor after every key: editing, kill and yank, history, Ctrl-R (incl. failed,
    repeated, aborted), Ctrl-C at the prompt and during `sleep` and `cat`, Ctrl-D, wrapping at and
    across the margin, multi-line quotes and here-documents, completion with zero, one and many
    matches (common prefix, double Tab, `Display all 150 possibilities?`, `--More--`), typeahead.
    `tty/terminal.test.ts` covers program completers, `cd`, `~user`, notices, Ctrl-Z, resize,
    hang-up and a half-typed line across snapshot/restore. The player was run for real on a
    pseudo-terminal (a Python pty driver, since this session has no interactive terminal): pipes
    and redirects, `vim notes.txt` opening a real `$EDITOR` command that appended a line which
    `cat` then showed, Ctrl-C, `exit`; `--replay` of that recording printed "world hash
    fe172bb8974ba82a matches the recording". `apps/cli/src/player.test.ts` checks record → replay →
    same hash in the gate. Script mode works (`npm run sim -- --topology ubuntu-1 -c …`) and
    `CLAUDE.md` documents both commands. Not done by a human yet: the owner sitting in
    `npm run play` with their own editor; worth five minutes before phase 04.
  - Decisions D-026 (notice style: yellow), D-027 (line editor), D-028 (plain vs terminal
    sessions), D-029 (editor protocol), D-030 (CLI, `ubuntu-1`), D-031 (prompt shortcut).
    Divergences: DIV-005 removed; DIV-012 (no bracketed paste), DIV-013 (readline subset),
    DIV-014 (editors are overlays). `docs/COVERAGE.md` has a Terminal section.
  - Surprises. The reference exposed a phase 02 bug: assigning PATH did not empty bash's command
    hash table (fixed in `shell/state.ts`). bash keeps a here-document command's trailing newline in
    its history. When a Tab changed the line, the next Tab only rings the bell and the third lists.
    Command completion marks matches that are directories, so the builtin `.` lists as `./`.
    readline's `\e[4~` (End without an inputrc) rings the bell and inserts `~`, `\e[1~` only rings.
    Ctrl-C at the prompt echoes `^C` where the cursor is. Real bash 5.2 turns on bracketed paste.
  - For later phases. Phase 08's kubectl completer plugs into `ProgramSpec.complete`; through
    `alias k=kubectl` it needs the alias's value, but `completionData` hands the completer alias
    names only (or phase 08 models `complete -F … k`, which is what the real setup asks for).
    Phase 10's web terminal drives the same `tty.*` and `editor.*` inputs and renders the
    `editor.open` record as the overlay; it should decide on bracketed paste (DIV-012). Raw-mode
    readers (a pager, phase 22b) set `Tty.mode` through `setTtyMode` (`tty/discipline.ts`), which
    has no `ProcApi` method yet. The simulated server's `awk` is gawk, as on the cloud image
    (D-032, decided with the owner after this phase; `prompts/22b-awk-jq-pager.md` updated).
  - Workflow: two parallel agents captured the readline reference and regenerated the base
    binaries while the engine was written.

- 2026-11-16 — **Phase 02 done.** Shell, process runtime, 40 programs, the transcript format.
  - Built: processes as world data (`packages/host/src/proc/`): pipes with capacity and SIGPIPE,
    open file descriptions with shared offsets, signals with `finally` cleanup, preemption after
    1000 syscalls, `exec`, a minimal terminal (`tty.open`/`tty.bytes` inputs, Ctrl-C, Ctrl-D,
    `onlcr`), the `[sim]` notice and gap reporting. The kernel gained the `output` port and
    `SliceSpec.attach`, used to end frameless programs after fork and restore while the shell at
    its prompt is recreated from its saved state. The bash subset (`packages/host/src/shell/`):
    real lexer/parser one command line at a time, aliases, here-documents, expansion in bash's
    order, pipelines of subshells that exec, 17 builtins; everything else is a notice. Programs:
    cat, ls, dir, vdir, mkdir, touch, rm, rmdir, cp, mv, ln, chmod, chown, head, tail, wc, sort,
    uniq, cut, tr, tee, grep, base64, sleep, date, env, which, clear, seq, basename, dirname,
    whoami, hostname, id and the binaries echo, printf, true, false, pwd, test, `[`. The base system
    now installs every executable of 14 Ubuntu base packages as stubs or scripts with real sizes
    (`base/binaries.ts`, generated by `tools/src/base/capture_binaries.py`).
  - Exit criteria: all pass. Shell transcripts (`transcripts/shell/`) cover quoting and expansion,
    pipelines of 3–5 stages, redirections including both `2>&1` orders, here-documents into
    pipelines, command substitution, aliases, `&&`/`||`, exit statuses, command not found and
    syntax errors. Every program has golden transcripts for its common flags and errors:
    55 golden-verified files, about 2 200 commands, and `npm run transcript:capture -- --check`
    finds no difference from the real tools. Streaming: `proc/runtime.test.ts` pipes a producer
    that prints every virtual second through `grep` and `cat`, sees each line arrive as time
    advances, and stops it with Ctrl-C (status 130); also SIGPIPE (141), preemption, fork,
    snapshot/restore and replay. `docs/COVERAGE.md` is started.
  - Decisions D-022 (C.UTF-8, sshd's login environment), D-023 (runtime), D-024 (pty capture),
    D-025 (gaps for later phases). New docs: `docs/TRANSCRIPTS.md`, `docs/COVERAGE.md`.
    Divergences DIV-001…DIV-011 in `docs/FIDELITY.md` §5.
  - Surprises. bash orders the exported environment by its variable hash table (FNV-1 mod 1024),
    not by insertion; reproduced exactly. An alias defined on a line is not active on that line.
    `${x:?}` abandons the rest of an interactive line and exits a non-interactive shell with 127.
    `exit 1 2` prints `logout`, then aborts the line keeping `$?`. Python ignores SIGPIPE, and the
    capture had to restore it for its children. In C.UTF-8 coreutils quotes arguments with ‘…’
    but file names in shell style ('a b', "it's").
  - Workflow: programs were written by five parallel agents after the runtime, shell, program
    helpers and transcript tooling existed. The files agent downloaded the coreutils 9.4 source
    tarball (with its gnulib) into the session scratchpad and ported logic from it (rank 2; not
    committed). Later phases that cite coreutils source should add it to the upstream fetch.
    VFS fixes from their findings: O_CREAT with a trailing slash is EISDIR; `link`/`symlink` to a
    name with a trailing slash is ENOENT; truncation publishes the file topic. Gaps they found
    and left: no fstat/lseek in `ProcApi`, `wait` takes one topic, no directory-change topic for
    programs, no lchown/lutimes in the VFS, no `umask` builtin.
  - For phase 03: the session in `transcript/session.ts` is the base for script mode; the shell
    passes its prompt in each read (`readLoop` in `shell/bash.ts`), echo and `^C` echo belong to
    the line discipline, and a foreground job killed by SIGINT already gets bash's newline.
    `tty.open` exists as an input.

- 2026-11-15 — **Phase 01 done.** Kernel and VFS, with every exit criterion tested.
  - Built: `packages/kernel` contains the world (containers plus frozen values), tables, a binary
    heap event queue, the kernel loop (`runUntil`, `advance`, `settle`, `nextEventTime`, `act`,
    inputs, topics, a livelock guard), xoshiro128** streams, a Merkle cyrb53 hash with a cache,
    fork, snapshot and restore with version checks, the input log, recorder and replay with
    checkpoints, the interactive driver's logic, the trace buffer and ports, the registry, the
    check, fault, step and topology contracts, and civil-date functions. `packages/host`
    contains machines, the VFS (`createFs`: 21 calls with Linux check order and errno), Ubuntu's
    link protections, generated files and devices, executable stubs, users from
    `/etc/passwd` and `/etc/group`, and `buildUbuntuBase`. 172 tests in 24 files.
  - Exit criteria. Determinism (same seed and log give the same hash, snapshot plus continue
    equals continue, a fork never affects its parent) is tested in
    `packages/kernel/src/determinism.test.ts`. Pending events and waiters survive restore (same
    file). VFS edge cases, permissions and every errno are covered by
    `packages/host/src/vfs/linux-reference.test.ts`, which replays 90 captured Linux cases, and
    `fs.test.ts`. Fork takes 1.2 ms (median) for 3 machines and 9 708 inodes, against a 10 ms
    target, so the representation stays. The numbers are in `docs/ARCHITECTURE.md` §2.7;
    rerun them with `npm run bench:fork`.
  - Decisions D-018 to D-021 in `docs/decisions.md`: kernel API refinements; users, groups and
    environment as files; simulated hosts are Ubuntu 24.04.5 LTS built from the essential
    packages' real files; where rank 3 captures live (`fixtures/reference/`).
  - Surprises. A recorded input could run before zero-delay events already due at the same
    instant, while replay ran them first, so `Kernel.input` now drains due events (found by the
    replay test). mkdir(2) drops set-group-ID from its mode argument, so the base builder chmods
    after mkdir, as base-files does. `/bin/../etc` is ENOENT on a usrmerged system, because `..`
    is physical. Ubuntu's procps turns on `protected_regular = 2` and `protected_symlinks = 1`,
    which apply to root too: root cannot `>` into another user's file in `/tmp`. Pop!_OS keeps
    Ubuntu's identity files as `*.diverted`, which gave a verified `os-release`.
  - For phase 02. Decide the simulated locale (FIDELITY §2.1) and the process slice budget
    (ARCHITECTURE §6). Add the fork hook that ends running programs, and deferred deletion of
    open unlinked files. `checkExec` returns the inode; deciding script versus binary (the
    kernel's ENOEXEC) is the exec layer's job. `/etc/profile` sources `/etc/profile.d/*.sh`,
    which is still empty (D-020).
  - Workflow: the tools package now depends on `@simlab/kernel` and `@simlab/host`, with the
    lockfile updated offline. New memory: `memory/no-glob-rm-on-variable-paths.md`.

- 2026-11-15 — **Moved to a new workstation.** No phase work. The plan, docs and prompts were
  checked for anything tied to the old machine and adapted (`docs/decisions.md` D-017, `PLAN.md`
  §15). Phase 01 is next and needs nothing else first.
  - The workstation is now Pop!_OS 24.04 (an Ubuntu 24.04 derivative) on x86_64 with Node 26.13.1
    through nvm, npm 11.20, bash 5.2.21, GNU coreutils 9.4, systemd 255, OpenSSL 3.0.13, gawk and
    mawk, jq 1.7.1, BIND's `nslookup`/`dig`/`host`, Go 1.27.4 and Python 3.12.3. Not installed:
    `kubectl`, Docker, kind. The full table is `docs/FIDELITY.md` §2.1, which is now the one place
    that records the workstation.
  - Restored the ignored state with `npm ci` and `npm run upstream:fetch` (v1.37.2 at `c50e5395`,
    192 MB). `npm run check` passes on Node 26: 13 test files, 73 tests. `stable-1.37.txt` still
    says v1.37.2, and all five oracle binaries answer on dl.k8s.io. `npm ci` reports 9 moderate
    advisories in development dependencies, as before.
  - Changed: `PLAN.md` §11 runtime says Node 24 or later; D-004 wording; `docs/FIDELITY.md` §1
    (kubectl note, recheck) and §2 (rank 3 row, new §2.1); prompts 01, 02, 17, 22a, 22b, 25a and
    25b name what is really installed here; `CLAUDE.md` gains `npm ci`, reads `memory/MEMORY.md`
    at the start of a session, points rank 3 at §2.1, and has the fix-freely rule.
  - Surprises: in the agent's shell, `grep` runs ugrep and `find` runs bfs (Claude Code shims), and
    oh-my-zsh aliases `ls`, `grep` and `diff`. Capture ground truth in the clean bash from
    `docs/FIDELITY.md` §2.1. Pop!_OS pins its own apt repository at priority 1001, so
    `apt-cache policy` priorities here are not a stock Ubuntu server's. Installing `gawk` made it
    the system `awk`; a stock Ubuntu server's `awk` is mawk (`/usr/bin/mawk`) (later corrected: the
    cloud image has gawk as `awk` too, D-032), so phase 22b calls
    each by name. No rank 3 reference was captured on the old machine, so nothing needs recapturing.
  - The old machine (`ssh colcv-thinkpad-t440p`, Ubuntu 26.04.1) was checked read-only. Its
    checkout, `~/projects/learning-platform`, is at the same commit `baaf61e`, clean and in sync
    with `origin/main`; its only ignored contents are `node_modules/`, `.upstream/` and `.tsbuild/`.
    Nothing was left behind.
  - Memory: the old machine's local Claude memory held only a redirect to the repository's
    `memory/` (in place since 2026-11-04); the same redirect now exists in this machine's local
    memory, and `CLAUDE.md` says to read `memory/MEMORY.md`. Two memories from the earlier Go
    version of the project were lost in the 2026-11-13 restart and are restored: the standing
    permission to fix wrong or stale things without asking (owner confirmed; also in `CLAUDE.md`
    under "During") and the zsh glob pitfall (rechecked here). Not restored: the owner profile
    (`PLAN.md` §1 covers it, and its "Vietnamese docs" part was superseded on 2026-11-13) and a
    `/tmp` quota note (the old machine's `/tmp` was a 7.5 GB tmpfs; here it is on the root disk).
- 2026-11-13 — **Phase 00 done.** Repository, gate, pin, upstream fetch and the specs exist.
  - Built: npm workspaces (`packages/*`, `apps/*`, `tools`) with TypeScript 6.0.3 strict and
    project references, Vitest 5, ESLint 10. `npm run check` = typecheck + lint + tests.
    Two lint rules in `tools/eslint/plugin.js` with 15 fixtures. `npm run upstream:fetch`.
    `docs/ARCHITECTURE.md`, `docs/SCENARIO_FORMAT.md`, `docs/FIDELITY.md`, `docs/decisions.md`,
    `docs/curriculum/`, `docs/schema/`.
  - The pin is **v1.37.2** (not 1.37.1 as the plan said; 1.37.2 was released since). Constant:
    `packages/k8s/src/version.ts`. Phase 04 downloads 1.37.2 binaries; they answer on dl.k8s.io.
  - Read `docs/decisions.md` before phase 01. The ones that shape code: no build step, packages
    export `.ts` and relative imports end in `.ts` (D-004); world state is containers plus
    frozen values, fork shares values (D-008); programs are synchronous generators, actors are
    event handlers, no `async` in the engine (D-009); extension contracts live in `kernel` (D-010).
  - Check syntax in items is `assert: <name>` + `with: {…}`; the one-line form in the plan was
    not valid YAML (D-002).
  - Surprises: TypeScript 7 is `latest` on npm but `typescript-eslint` does not support it yet.
    Engine sources compile with `types: []` and `lib: ES2024`, so `console`, `setTimeout` and Node
    APIs fail the type check as well as lint; tests have their own `tsconfig.test.json` with Node
    types. `.upstream/` is about 190 MB.
  - Known gaps: `docs/schema/item.schema.json` is maintained by hand until phase 09 generates the
    check, fault and step catalogs from the registry. `docs/ARCHITECTURE.md` §6 lists what each
    phase still decides. The pipeline stage order in §4.2 restates the plan and must be verified
    against upstream in phase 05a. The worked examples are validated for structure only; nothing
    runs them until the engine exists.
  - `npm install` reports moderate advisories in development dependencies (lint and test
    tooling); nothing ships to a runtime. Not acted on.
- 2026-11-13 — Plan, phase prompts and CLAUDE.md written. No code exists. The folder is not a git
  repository yet; phase 00 initializes it. (This describes the previous workstation; see
  2026-11-15.) The workstation is Ubuntu 26.04 on x86_64 with Node 24,
  npm, Python 3.14, git, make, bash 5.3, OpenSSL 3.5, vim and kubectl 1.36.3. It has no Docker,
  kind, Go or pnpm. The v1.37.1 release binaries on dl.k8s.io are reachable (checked for
  kube-apiserver and kube-scheduler), which phase 04 relies on.

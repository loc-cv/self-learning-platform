# Fidelity

How Simlab stays honest about what it simulates. This document holds the version pin, the order
in which sources are trusted, the provenance tags, the contract for `[sim]` notices and the gap
log, and the register of known divergences. `PLAN.md` §9 is the policy; this is the contract code
is written against.

## 1. Version pin

| | |
|---|---|
| Kubernetes version | **v1.37.2** |
| Constant | `KUBERNETES_VERSION` in `packages/k8s/src/version.ts` (the only place it is written in code) |
| Git tag | `v1.37.2` → commit `c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32` in `kubernetes/kubernetes` |
| Date checked | 2026-11-13 |
| Exam version | CKA and CKAD: "The exam is based on Kubernetes v1.37." |
| Curricula | v1.37 for both, recorded in `docs/curriculum/` |

Sources, all read on the date above:

- CKA exam page: <https://training.linuxfoundation.org/certification/certified-kubernetes-administrator-cka/>
- CKAD exam page: <https://training.linuxfoundation.org/certification/certified-kubernetes-application-developer-ckad/>
- Latest patch of the minor: <https://dl.k8s.io/release/stable-1.37.txt> returned `v1.37.2`; the
  tag list of <https://github.com/kubernetes/kubernetes> shows `v1.37.2` as the newest `v1.37.*`
  tag. Release overview: <https://kubernetes.io/releases/>.
- Release binaries for the oracle (phase 04): `https://dl.k8s.io/release/v1.37.2/bin/linux/amd64/`
  answered for `kube-apiserver`, `kubectl` and `kubeadm`.
- Rechecked on 2026-11-15 from the current workstation (§2.1): `stable-1.37.txt` still returned
  `v1.37.2`, and `kube-apiserver`, `kube-controller-manager`, `kube-scheduler`, `kubectl` and
  `kubeadm` all answered at that URL.

The exams name a minor, not a patch. The pin is the latest patch of that minor on the day it was
checked. `PLAN.md` §4.1 was written when 1.37.1 was the latest; 1.37.2 appeared since
(`docs/decisions.md` D-001).

Rules:

- Data derived from upstream (processed OpenAPI, golden fixtures) is stored in a directory named
  after the version, for example `fixtures/golden/v1.37.2/`.
- Nothing else in the code states a version. Tools import the constant.
- Moving the pin is `prompts/R5-version-bump.md`: refetch upstream, recapture goldens, diff, fix,
  update this section and `docs/curriculum/`.
- A `kubectl` installed on the workstation is not a reference for anything (the current one has
  none; the previous one had 1.36.3). The reference `kubectl` is the v1.37.2 release binary that
  phase 04 downloads.

### Upstream checkout

`npm run upstream:fetch` makes a sparse, blob-less, depth-1 clone of the pinned tag in
`.upstream/kubernetes/` (git-ignored, about 190 MB) and writes `.upstream/kubernetes.json` with
the tag, commit and directory list. The directories are listed, with the phases that read them,
in `tools/src/upstream/paths.ts`. A phase that needs another directory adds it there and reruns
the command; it is incremental.

## 2. Source hierarchy

Every user-visible string and format has a source. When two sources disagree, the higher one wins
and the disagreement is worth a note next to the code.

| Rank | Source | Used for | How it is cited |
|---|---|---|---|
| 1 | **Golden capture** of the real binaries at the pin: the local oracle (API server, etcd, controller manager, scheduler, `kubectl`, `kubeadm`; phase 04) and, optionally, a kind cluster (tier 2, phase 32) | Everything those binaries print or store: tables, `describe`, errors, events, defaulted objects | The fixture path: `fixtures/golden/v1.37.2/<case>` |
| 2 | **Upstream source** at the pinned tag in `.upstream/` | Formats and strings the oracle cannot produce (kubelet and node output), and the logic behind any output | `// upstream: <path> <symbol>` |
| 3 | **The real tool on this workstation** (§2.1): bash, GNU coreutils, systemd, OpenSSL, vim | Shell, coreutils, `systemctl`, `journalctl`, `openssl` output | `// reference: <tool> <version>, captured <date>` and a transcript fixture |
| 4 | **Official documentation**: kubernetes.io, man pages, project docs for etcd, containerd, Helm, CoreDNS | Behavior and formats not covered above | `// docs: <URL>` |
| — | Memory, blog posts, answers from an LLM | Nothing | — |

For a tool whose source is not in `kubernetes/kubernetes` (etcd, containerd and `crictl`, Helm,
CoreDNS, kustomize as a standalone binary), the phase that introduces it records its pinned
version here and fetches or captures its sources the same way.

### 2.1 The workstation

Rank 3 is whatever this machine has, so its versions are recorded here. A provenance comment names
the version it was captured from (`// reference: bash 5.2.21, captured <date>`), which keeps it
meaningful if the work moves to another machine. When the workstation changes, update this section
and add a handoff note in `STATUS.md`.

Recorded 2026-11-15, after the move from the machine phase 00 ran on. Only phase 00 ran there, so
no rank 3 reference comes from the previous machine.

| | |
|---|---|
| System | Pop!_OS 24.04 LTS, a desktop derivative of Ubuntu 24.04 ("noble"); x86_64, 16 CPUs, 31 GiB RAM |
| Development runtime | Node 26.13.1 (through nvm), npm 11.20.0, git 2.43.0 |
| Shell and text tools | bash 5.2.21, GNU coreutils 9.4, GNU grep 3.11, GNU sed 4.9, GNU findutils 4.9.0, GNU diffutils 3.10, jq 1.7.1 (`jq --version` prints `jq-1.7`), less 590, vim 9.1, GNU tar 1.35, gzip 1.12 |
| awk | GNU Awk 5.2.1 is what `awk` runs here (installing it moved the `awk` alternative to it). mawk 1.3.4, the `awk` of a stock Ubuntu server, is `/usr/bin/mawk`. Call each by its full name when capturing |
| System tools | systemd 255, procps-ng 4.0.4, iproute2 6.1.0, util-linux 2.39.3, sudo 1.9.15p5, apt 2.8.4, OpenSSH 9.6p1, OpenSSL 3.0.13 |
| Network clients | curl 8.5.0, GNU Wget 1.21.4, OpenBSD netcat 1.226, iputils ping, `nslookup`, `dig` and `host` from BIND 9.18.39 |
| Browsers | Firefox 160.0; a Playwright headless Chromium (build 1248) is in `~/.cache/ms-playwright` |
| Not installed | `kubectl`, Docker, Podman, kind, Helm, `crictl`, pnpm |
| Installed, unused by the plan | Go 1.27.4, Python 3.12.3 |

**Capture in a clean bash, never in the agent's shell.** The shell Claude Code runs commands in is
the owner's zsh with oh-my-zsh. There, `grep` is a function that runs ugrep and `find` one that
runs bfs (both bundled with Claude Code), and `ls`, `grep` and `diff` are aliases that add color
and exclude options. What they print is not GNU output. Run the real tool in a temporary directory
like this:

```sh
env -i HOME="$HOME" PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 TERM=xterm-256color \
  /bin/bash --noprofile --norc -c '<commands>'
```

`type grep find ls diff` inside it shows `/usr/bin/…` for each. Choose the locale on purpose and
record it with the transcript: `sort`, `ls` and some messages depend on it. The owner's login
locale is `en_US.UTF-8`; `C.UTF-8` is also available. The simulated machine's locale is decided by
the phase that sets environment defaults (01 or 02), and captures use that one.

**Take formats from this machine, not contents.** Simulated hosts are Ubuntu servers; this is a
desktop with Pop!_OS changes. Layouts, message formats, exit statuses and error texts transfer.
These do not: `/etc/os-release` and other identity files, which units, users and services exist,
the apt sources and their priorities (Pop!_OS pins its own repository at priority 1001 in
`/etc/apt/preferences.d/pop-default-settings`; there are also Tailscale and Ubuntu Pro entries),
the motd. Take those from Ubuntu server documentation (rank 4) and say so.

**Missing tools.** When a phase needs real output from a tool listed as not installed, ask the
owner to install it (`CLAUDE.md` forbids changing the workstation yourself), or use rank 2 or 4
and tag the unit by what could be verified.

## 3. Provenance tags

An **output unit** is one piece of user-visible output with one origin: a table printer for a
kind, a describer, one family of error messages, one program's help text, one event reason with
its message format. Every unit is registered with one tag.

| Tag | Meaning | Requirement |
|---|---|---|
| `golden-verified` | A differential test compares the simulator's output with a committed capture of the real tool, after normalizing volatile fields | The fixture exists and the differential test passes in the gate |
| `source-derived` | Written from upstream source or official docs at the pin, not yet compared with real output | The code cites the source |
| `approximate` | Known to differ from the real tool, or grounded in no source | An entry in the divergence register (§5) that the unit links to |

Registration is data next to the code that renders the unit:

```ts
interface ProvenanceEntry {
  /** Stable dotted id: `<program>.<verb>.<what>`, e.g. `kubectl.get.pods.table`. */
  unit: string;
  tag: 'golden-verified' | 'source-derived' | 'approximate';
  /** Fixture paths, upstream paths with symbol, tool and version, or URLs. At least one unless approximate. */
  sources: string[];
  /** Divergence register id, required when tag is `approximate`. */
  divergence?: string;
  note?: string;
}
```

- The registry rejects a unit registered twice and a unit with no source.
- `npm run fidelity:report` (phase 07a) prints every unit with its tag and sources, and the counts
  per tag. A unit that code renders but nobody registered is a test failure, not a report line.
- A unit moves up, never silently down: `source-derived` becomes `golden-verified` when its
  differential test lands. A unit found wrong becomes `approximate` with a register entry until fixed.
- Normalization replaces volatile fields with tokens before comparison (ages, UIDs, IPs,
  timestamps, resource versions, generated name suffixes). The token set is defined in phase 04
  with the first fixtures and documented here.

## 4. The `[sim]` notice and the gap log

Three outcomes exist for any input (`PLAN.md` §3.2): it works as the real tool would; it fails with
the real tool's real error; or the simulator says, in its own voice, that it does not simulate
this. The third outcome is the `[sim]` notice.

### 4.1 When a notice is printed

| Situation | Outcome |
|---|---|
| A program the real machine would have, not simulated yet (say `awk` before phase 22b) | Notice. The executable exists in the VFS and points at a stub, so `which` and tab completion behave. |
| A program the real machine would not have | The shell's real `command not found` error, exit 127. Also written to the gap log as kind `unknown-command`, because the list of what a machine "would have" is itself curated. |
| A supported program with an unsupported subcommand, flag, flag value, resource type, output format or field | Notice. The program does nothing else: no partial effect, no output. |
| Shell syntax outside the documented subset | Notice from the shell. The whole command line is not executed. |
| An input that hits a simulator bug (an uncaught exception in a program) | Notice of kind `internal`, with a short id that matches the gap log record. |
| A flag that is parsed and has no observable effect in a simulated world (for example `--request-timeout`) | Accepted silently only if it is on the program's documented no-effect list, each with a reason. Otherwise notice. |

What is never done: printing an error the real tool would not print; accepting a flag and ignoring
it; printing plausible output for something that was not computed from world state.

### 4.2 Format

One line on standard error:

```
[sim] <program>: <what> is not simulated yet
```

`<what>` names the unsupported thing in the user's terms: `the flag --server-side`,
`the resource type "podtemplates"`, `the subcommand "debug"`, `the "select" statement`. An
optional second line starting with `[sim] ` may point to what is supported instead. Examples of
the shape (the wording of `<what>` is fixed by the program that prints it):

```
[sim] kubectl: the flag --server-side is not simulated yet
[sim] bash: the "select" statement is not simulated yet
[sim] awk: this program is not simulated yet
[sim] kubectl: internal simulator error (gap 7f3a9c1e)
```

- The prefix `[sim] ` appears at the start of every line of a notice and nowhere in simulated
  output. No real tool prints it, which is the point.
- When standard error is a terminal the line is written in a distinct style, with SGR sequences
  that the web UI and the terminal player render the same way. When it is a pipe or a file the
  line is plain.
- The exit status is **250**. The value is the simulator's own and is reserved: no simulated
  program returns it for any other reason.
- All notices are printed through one function in the host package. Programs never format the
  prefix themselves.

### 4.3 Consequences for content

- A reference solution that triggers a notice fails content validation. Solutions use only what is simulated.
- A setup step that triggers a notice fails content validation.
- A check never passes or fails because of a notice: `shell.exec` reports a notice as an error of
  the check, not as a result.

### 4.4 The gap log

Every notice, and every `unknown-command`, produces one gap record. Engine packages do no I/O:
the engine hands the record to the kernel's gap port (`docs/ARCHITECTURE.md` §2.10) and the app
appends it to `data/gaps.jsonl`, one JSON object per line.

```ts
interface GapRecord {
  /** Schema version of this record. */
  v: 1;
  /** Wall-clock time, added by the sink, ISO 8601. The engine does not know it. */
  at: string;
  kind: 'command' | 'unknown-command' | 'subcommand' | 'flag' | 'flag-value' | 'resource'
      | 'output-format' | 'field' | 'syntax' | 'behavior' | 'internal';
  program: string;
  /** The unsupported thing, as printed in the notice. */
  what: string;
  /** The command line as typed, after alias expansion. */
  commandLine: string;
  /** Stable key for grouping: kind, program and the normalized thing. */
  key: string;
  /** Where it happened. */
  context: { item?: string; seed?: number; machine: string; virtualTime: number };
  /** For `internal`: error message and stack. */
  error?: { message: string; stack?: string };
  engine: { version: string; kubernetes: string };
}
```

- The sink writes every occurrence. Grouping by `key` and counting is done when reading.
  `prompts/R3` works from the grouped view, most frequent first.
- Headless content validation and tests collect gap records in memory and fail on any.
- The file is append-only and local. It contains command lines I typed; it is under `data/`,
  which is git-ignored.
- `kind: 'behavior'` is for gaps found by code that knows it is not modeling something a scenario
  asked for (an image with no behavior model, a kubelet flag that is parsed but not acted on).

## 5. Divergence register

Places where the simulator knowingly differs from the real system. An entry is added by the phase
that introduces the divergence; debriefs link to entries by id ("in reality" notes). An entry is
removed only when the divergence is gone.

Entry format:

| Field | Content |
|---|---|
| Id | `DIV-NNN`, never reused |
| Area | Program or subsystem |
| Real behavior | What the real system does, with a source |
| Simulated behavior | What Simlab does instead |
| Why | The reason the divergence is accepted |
| Learner impact | What habit or expectation could be affected, and what the debrief should say |
| Since | Phase that introduced it |

### Register

| Id | Area | Real behavior | Simulated behavior | Why | Learner impact | Since |
|---|---|---|---|---|---|---|
| | | | | | | |

No entries yet. The non-goals in `PLAN.md` §4.3 (no packets, no real cryptography, a bash subset,
an editor overlay instead of a terminal vi, a curated image catalog) become entries when the phase
that builds each area lands, worded for what was actually built.

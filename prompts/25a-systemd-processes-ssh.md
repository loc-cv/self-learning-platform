# Phase 25a — Node substrate I: systemd, journal, processes, users, SSH

**Milestone** M4 · **Needs** 22a · Follow the session protocol in `CLAUDE.md`.

## Goal

Turn the simulated machines into servers an administrator can operate: services, logs, processes
and remote login. All CKA node work, and every later Linux-based domain, stands on this. Nothing
here may know about Kubernetes: this is `packages/host`.

## Read first

`PLAN.md` §6.2, §6.3. `docs/BEHAVIOR_MODELS.md`. `docs/ARCHITECTURE.md` host sections.

## Build

- **Behavior models for host services**: move the model format so `packages/host` owns the generic
  part (lifecycle, logs, listeners, reaction to signals and to configuration) and domains add
  models. A service's process is a model looked up from its `ExecStart` binary.
- **systemd**: unit files parsed from the VFS (`[Unit]`, `[Service]`, `[Install]`, drop-in
  directories, `Environment`, `EnvironmentFile`), a unit state machine (inactive, activating,
  active, failed, auto-restart with `Restart=` and `RestartSec=`, start limits), enablement through
  symlinks, ordering and requirement dependencies in simple form, boot and `reboot`. A missing
  binary, a bad flag or a failing model gives the real unit states and result codes.
- **`systemctl`**: `status` in the real layout with recent log lines, `start`, `stop`, `restart`,
  `reload`, `enable` (with `--now`), `disable`, `mask`, `is-active`, `is-enabled`, `is-failed`,
  `cat`, `edit` through the editor protocol, `daemon-reload` (and the real warning when a unit file
  changed on disk without it), `list-units`, `list-unit-files`, `show`, `reset-failed`.
- **Journal**: per-unit logs from behavior models with priorities; `journalctl -u`, `-f`, `-n`,
  `-e`, `-r`, `--since`, `--until`, `-p`, `-b`, `-g`, `--no-pager`, `-o cat|short-iso`, `-x`
  accepted, `-k` in simple form; paging through the pager from phase 22b when it exists. Plain log
  files under `/var/log` where real systems have them.
- **Processes**: a process table fed by units, containers and the shell; `ps` (`aux`, `-ef`, `-p`,
  `-o`, `--forest` optional), `pgrep`, `pkill`, `kill` with signals that models react to, `top` as a
  snapshot, `uptime`, `free`, `nproc`, a `/proc` with the entries tools and learners commonly read.
- **Users and privilege**: `sudo` (including `-i`, `-u`, `-E`), `su`, `useradd`, `usermod`, `id`,
  `groups`, permission enforcement for non-root users, `/etc/passwd`, `/etc/group`, `/etc/sudoers`
  in simple form.
- **Remote access**: `ssh <host>` between machines of a topology (key-based, names from
  `/etc/hosts`), nested sessions ended by `exit`, `ssh host command`, `scp`. Prompt, TTY and
  completion follow the session.
- **Host networking view**: `ip addr`, `ip route`, `ip link`, `ss -tlnp`, `netstat -tlnp`,
  `hostname -I`, `/etc/hosts`, `/etc/resolv.conf`; `curl`, `nc`, `ping` and `nslookup` between
  machines through a host-level reachability hook that domains extend.
- **Checks and faults** registered by the host plugin: unit active, enabled or failed; process
  running; port listening; faults to stop, disable or break a unit.

**Ground truth.** This workstation runs Pop!_OS 24.04, an Ubuntu 24.04 derivative, with systemd
255: verify layouts and messages against the real tools (`systemctl status`, `systemctl cat`,
`journalctl`, `ps`, `ss`, `ip`). It is a desktop, so take formats from it, not which units, users
or services exist (`docs/FIDELITY.md` §2.1).

## Not in this phase

Packages, sysctl, kernel modules, swap, PKI and `openssl` (phase 25b). Anything Kubernetes.

## Exit criteria

- Transcripts verified against the real tools for each command family above.
- A sample service defined only by a unit file and a behavior model can be started, crash, restart
  by policy, hit its start limit, be broken by a bad `ExecStart`, be repaired with `daemon-reload`
  and `restart`, and shows consistent state in `systemctl`, `journalctl`, `ps` and `ss`.
- `ssh node01` and back works with correct prompts; `ssh node01 systemctl is-active <unit>` works;
  a session two hops deep unwinds correctly.
- A non-root user is refused where a real one would be, and `sudo` lifts it.
- `packages/host` imports nothing from `packages/k8s`. `docs/COVERAGE.md` regenerated.

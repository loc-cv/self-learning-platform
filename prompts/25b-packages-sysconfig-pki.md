# Phase 25b — Node substrate II: packages, system configuration, PKI

**Milestone** M4 · **Needs** 25a · Follow the session protocol in `CLAUDE.md`.

## Goal

The rest of what an administrator touches on a server before and around Kubernetes: installing
and pinning packages, kernel and system settings, and certificates. kubeadm's preflight checks,
upgrades and every certificate task depend on it. Still nothing Kubernetes-specific in `packages/host`.

## Read first

`PLAN.md` §6.2, §7 (PKI model, read for the requirements only). `docs/ARCHITECTURE.md` host sections.

## Build

- **Packages**: a package catalog that domains extend (name, versions, files, binaries, units,
  dependencies); repositories from `/etc/apt/sources.list.d` and keyrings, so a package is visible
  only when its repository is configured and `update` has run; `apt-get` and `apt` `update`,
  `install` (with `=version`, `-y`, `--allow-change-held-packages`), `remove`, `purge`, `upgrade`,
  `list --installed`; `apt-cache policy|madison|show|search`; `apt-mark hold|unhold|showhold`;
  `dpkg -l|-L|-s`. Installing places files, binaries and units; upgrading a package whose service is
  running leaves the old process until restart, as in reality. Output resembles the real tools' and
  is tagged by what could be verified.
- **System configuration**: `sysctl` (read, `-w`, `-p`, `--system`, files under `/etc/sysctl.d`,
  runtime versus persistent values), `modprobe`, `lsmod`, `/etc/modules-load.d`, `swapon --show`,
  `swapoff -a`, `/etc/fstab` and what survives `reboot`, `mount`, `umount`, `lsblk` and `df` in
  simple form, `timedatectl`, `hostnamectl`, `date -s` against the virtual clock, `uname`,
  `/etc/os-release`, `ulimit` in simple form.
- **PKI stand-in**: keys, certificate requests and certificates as structured data inside
  PEM-shaped files (subject, issuer, SANs, key usages, validity, key identity, CA flag); signing,
  chain verification, key and certificate matching, expiry against the virtual clock. A library in
  `packages/host` that domains use to mint and verify.
- **`openssl`**: `genrsa`, `genpkey` in simple form, `req -new` (with `-subj`, `-key`, `-out`,
  `-config` in simple form), `req -text`, `x509 -req` signing with `-CA`, `-CAkey`, `-days`,
  `x509 -in … -text -noout` in the real layout, `-dates`, `-enddate`, `-startdate`, `-subject`,
  `-issuer`, `-ext subjectAltName`, `-checkend`, `verify -CAfile`, `s_client -connect` in simple
  form against listeners that declare a certificate, `base64` interplay for kubeconfig data.
- **Checks and faults**: file content, mode and owner; package installed, version and hold state;
  sysctl and module state; certificate valid, expiring and issued by; faults to corrupt or remove a
  file, expire or replace a certificate, fill a disk, re-enable swap.

**Ground truth.** Verify against the real tools on this workstation (`apt-cache policy`,
`apt-mark`, `sysctl`, `lsmod`, `openssl x509 -text`). Don't run anything that changes this
workstation's packages or kernel settings; read-only commands only.

## Not in this phase

Kubernetes packages, units and certificates (phases 26a onward register theirs). Firewalls, LVM,
cron, SELinux and AppArmor: later Linux content decides (phase 34).

## Exit criteria

- Transcripts verified against the real tools for each read-only command family above.
- A package from a repository that isn't configured can't be found; after adding the repository
  and `apt-get update` it installs at a chosen version, can be held, and refuses upgrade while held.
- A sysctl set with `-w` is gone after `reboot` unless written to a file; the same for swap and modules.
- A certificate chain verifies; it fails after the clock passes its end date; a key that doesn't
  match its certificate is detected; `openssl x509 -text` output for a stand-in certificate has the
  real layout.
- `packages/host` imports nothing from `packages/k8s`. `docs/COVERAGE.md` and the divergence
  register (no real cryptography) are current.

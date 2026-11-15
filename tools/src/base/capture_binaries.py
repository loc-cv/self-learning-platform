#!/usr/bin/env python3
"""Writes packages/host/src/base/binaries.ts: the executables an Ubuntu 24.04 server's base
packages install, with their sizes, modes and symlink targets, and the update-alternatives links
their maintainer scripts create.

PACKAGES pins each package to the version in the Ubuntu 24.04 server cloud image manifest
(MANIFEST). An installed package is read from this workstation (docs/FIDELITY.md §2.1): its files
from the file system, its postinst from /var/lib/dpkg/info; the script fails if the installed
version differs from the manifest's. A package this workstation does not have installed (vim: it
has vim-gtk3) is read from the .deb of exactly that version in the directory given with --debs:

  mkdir <dir> && cd <dir> && apt-get download vim=2:9.1.0016-1ubuntu7.20

Pop!_OS changes none of these packages. Alternatives are computed as a stock server has them, from
the postinsts of PACKAGES alone (automatic mode: the highest priority wins), not read from this
workstation's /etc/alternatives (awk -> gawk, vi -> vim.gtk3 here).

Run: python3 -I tools/src/base/capture_binaries.py [--debs <dir>] > packages/host/src/base/binaries.ts
"""

import argparse
import glob
import io
import json
import os
import shlex
import subprocess
import sys
import tarfile

MANIFEST = "https://cloud-images.ubuntu.com/releases/noble/release/ubuntu-24.04-server-cloudimg-amd64.manifest"
PACKAGES = {
    "bash": "5.2.21-2ubuntu4",
    "coreutils": "9.4-3ubuntu6.3",
    "dash": "0.5.12-6ubuntu5",
    "debianutils": "5.17build1",
    "diffutils": "1:3.10-1ubuntu0.1",
    "findutils": "4.9.0-5build1",
    "grep": "3.11-4build1",
    "gzip": "1.12-1ubuntu3.2",
    "hostname": "3.23+nmu2ubuntu2",
    "less": "590-2ubuntu2.1",
    "mawk": "1.3.4.20240123-1build1",
    "nano": "7.2-2ubuntu0.2",
    "ncurses-bin": "6.4+20240113-1ubuntu2.2",
    "sed": "4.9-2ubuntu0.24.04.1",
    "sensible-utils": "0.0.22",
    "tar": "1.35+dfsg-3ubuntu0.4",
    "vim": "2:9.1.0016-1ubuntu7.20",
    "vim-common": "2:9.1.0016-1ubuntu7.20",
    "vim-runtime": "2:9.1.0016-1ubuntu7.20",
    "vim-tiny": "2:9.1.0016-1ubuntu7.20",
}
BIN_DIRS = ("/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/")
# Stubs whose program has another registry name. which.debianutils is a /bin/sh script; it is
# simulated as the program `which` (docs/FIDELITY.md DIV-001). vim.basic (vim) and vim.tiny
# (vim-tiny) are both simulated by the program `vim`. Other scripts keep their text.
PROGRAM_NAME = {"which.debianutils": "which", "vim.basic": "vim", "vim.tiny": "vim"}


def fail(msg):
    sys.exit("capture_binaries: " + msg)


def usr_path(f):
    """The usr-merged path of a package file, or None if it is not directly in a bin directory."""
    if not f.startswith(BIN_DIRS):
        return None
    path = "/usr" + f if f.startswith(("/bin/", "/sbin/")) else f
    return path if path.count("/") == 3 else None


def entry(base, head, size, mode, read_text):
    if head == b"#!" and base not in PROGRAM_NAME:
        return ("script", (read_text(), mode))
    return ("file", (size, mode))


def from_workstation(pkg):
    """Bin entries and postinst text of an installed package."""
    entries = {}
    files = subprocess.run(["dpkg", "-L", pkg], capture_output=True, text=True, check=True).stdout.split("\n")
    for f in files:
        path = usr_path(f)
        if path is None or not os.path.lexists(path):
            continue
        st = os.lstat(path)
        if os.path.islink(path):
            entries[path] = ("link", os.readlink(path))
            continue
        with open(path, "rb") as fh:
            head = fh.read(2)

        def read_text(p=path):
            with open(p, encoding="utf-8") as fh:
                return fh.read()

        entries[path] = entry(os.path.basename(path), head, st.st_size, st.st_mode & 0o7777, read_text)
    postinst = ""
    for name in (pkg, pkg + ":amd64"):
        p = "/var/lib/dpkg/info/%s.postinst" % name
        if os.path.exists(p):
            with open(p, encoding="utf-8") as fh:
                postinst = fh.read()
    return entries, postinst


def find_deb(pkg, version, debs):
    if debs is not None:
        for deb in sorted(glob.glob(os.path.join(debs, glob.escape(pkg) + "_*.deb"))):
            fields = subprocess.run(["dpkg-deb", "-f", deb, "Package", "Version"], capture_output=True, text=True, check=True).stdout
            if fields.split("\n")[:2] == ["Package: " + pkg, "Version: " + version]:
                return deb
    fail("%s is not installed here; pass --debs <dir> with the .deb from `apt-get download %s=%s`" % (pkg, pkg, version))


def from_deb(deb):
    """Bin entries and postinst text of a .deb, read without unpacking it."""
    entries = {}
    data = subprocess.run(["dpkg-deb", "--fsys-tarfile", deb], capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        for m in tar.getmembers():
            path = usr_path(m.name[1:] if m.name.startswith("./") else m.name)
            if path is None or m.isdir():
                continue
            if m.issym():
                entries[path] = ("link", m.linkname)
            elif m.isfile():
                raw = tar.extractfile(m).read()
                entries[path] = entry(os.path.basename(path), raw[:2], m.size, m.mode & 0o7777, lambda r=raw: r.decode("utf-8"))
            else:
                fail("%s: unexpected member type for %s" % (deb, m.name))
    ctrl = subprocess.run(["dpkg-deb", "--ctrl-tarfile", deb], capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(ctrl)) as tar:
        names = {m.name.lstrip("./"): m for m in tar.getmembers()}
        postinst = tar.extractfile(names["postinst"]).read().decode("utf-8") if "postinst" in names else ""
    return entries, postinst


def alternatives_of(postinst):
    """The `update-alternatives --install` calls of a maintainer script: (link, name, path, priority, slaves)."""
    calls = []
    for line in postinst.replace("\\\n", " ").split("\n"):
        if "update-alternatives" not in line:
            continue
        words = shlex.split(line, comments=True)
        i = words.index("update-alternatives") + 1
        current = None
        while i < len(words) and words[i] not in ("||", "&&", ";"):
            w = words[i]
            if w == "--install":
                link, name, path, prio = words[i + 1:i + 5]
                current = (link, name, path, int(prio), [])
                calls.append(current)
                i += 5
            elif w == "--slave":
                current[4].append(tuple(words[i + 1:i + 4]))
                i += 4
            elif w == "--quiet":
                i += 1
            else:
                fail("unexpected update-alternatives argument %r in: %s" % (w, line.strip()))
    return calls


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--debs", help="directory with the .deb of each package not installed here")
    args = parser.parse_args()

    entries = {}
    sources = {}
    candidates = {}  # alternative name -> [(priority, link, path, slaves, pkg)]
    for pkg, version in PACKAGES.items():
        q = subprocess.run(["dpkg-query", "-W", "-f=${db:Status-Status} ${Version}", pkg], capture_output=True, text=True)
        status, _, installed = q.stdout.partition(" ")
        if q.returncode == 0 and status == "installed":
            if installed != version:
                fail("%s %s is installed, but the manifest (%s) has %s" % (pkg, installed, MANIFEST, version))
            pkg_entries, postinst = from_workstation(pkg)
            sources[pkg] = "%s %s" % (pkg, version)
        else:
            deb = find_deb(pkg, version, args.debs)
            pkg_entries, postinst = from_deb(deb)
            sources[pkg] = "%s %s (.deb)" % (pkg, version)
        for path, e in pkg_entries.items():
            if path in entries:
                fail("%s is in two packages" % path)
            entries[path] = e
        for link, name, path, prio, slaves in alternatives_of(postinst):
            candidates.setdefault(name, []).append((prio, link, path, slaves, pkg))

    # Automatic mode: the candidate with the highest priority is selected (update-alternatives(1)).
    # Only links in bin directories matter; man-page masters and slaves are left out.
    alternatives = {}
    for name, cands in candidates.items():
        cands.sort(key=lambda c: -c[0])
        if len(cands) > 1 and cands[0][0] == cands[1][0]:
            fail("alternative %s: tie between %s and %s" % (name, cands[0][4], cands[1][4]))
        prio, link, path, slaves, _ = cands[0]
        for l, n, p in [(link, name, path)] + slaves:
            if usr_path(l) is None:
                continue
            if l in entries:
                fail("%s is both a package file and an alternatives link" % l)
            entries[l] = ("link", "/etc/alternatives/" + n)
            alternatives[n] = p

    out = []
    out.append("// Executables of an Ubuntu 24.04 server's base packages: stubs naming a program, and symlinks.")
    out.append("// Generated by tools/src/base/capture_binaries.py from the workstation's packages and, for")
    out.append("// packages not installed there, their .deb files; do not edit.")
    out.append("// reference: " + ", ".join(sources[p] for p in PACKAGES))
    out.append("")
    out.append("/** path, then [size, mode, program] for a stub, {script, mode} for a script, or the target of a symlink. */")
    out.append("export const BINARIES: [string, [number, number, string] | { script: string; mode: number } | string][] = [")
    for path in sorted(entries):
        kind, data = entries[path]
        if kind == "file":
            size, mode = data
            base = os.path.basename(path)
            out.append("  [%s, [%d, 0o%o, %s]]," % (json.dumps(path), size, mode, json.dumps(PROGRAM_NAME.get(base, base))))
        elif kind == "script":
            text, mode = data
            out.append("  [%s, { script: %s, mode: 0o%o }]," % (json.dumps(path), json.dumps(text), mode))
        else:
            out.append("  [%s, %s]," % (json.dumps(path), json.dumps(data)))
    out.append("];")
    out.append("")
    out.append("/** /etc/alternatives links: name -> target, as update-alternatives selects them in automatic mode. */")
    out.append("export const ALTERNATIVES: [string, string][] = [")
    for name in sorted(alternatives):
        out.append("  [%s, %s]," % (json.dumps(name), json.dumps(alternatives[name])))
    out.append("];")
    print("\n".join(out))


if __name__ == "__main__":
    main()

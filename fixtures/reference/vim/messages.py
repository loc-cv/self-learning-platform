# Ground truth for the web editor overlay's vim messages (apps/web, phase 10): the message line the
# real vim shows when a file opens, after :w, and when :q, :w or an unknown command is refused.
# Capture (from the repository root):
#   python3 -I fixtures/reference/vim/messages.py > fixtures/reference/vim/messages.json
# Recorded with VIM - Vi IMproved 9.1 (included patches 1-16, 647, 678, 697; /usr/bin/vim),
# Python 3.12.3, Linux 7.2.15-76070215-generic, locale C.UTF-8 (docs/FIDELITY.md §2.1).
#
# Each case starts `vim -u NONE -N -i NONE --noplugin FILE` (no vimrc, nocompatible, no viminfo)
# on a pseudo-terminal in a fresh temporary directory, environment exactly TERM=xterm-256color
# HOME=<that directory> PATH=/usr/bin:/bin LANG=C.UTF-8. It waits 0.8 s for the first screen, then
# writes each key chunk in one write() and collects output until 0.4 s pass. Escape sequences are
# replaced by line breaks; the case keeps the non-empty lines that contain its expected message,
# so the JSON holds the message text exactly as vim drew it on the command line. `exCommands` is
# getcompletion('', 'command') from `vim -es` started the same way: every Ex command name.
import json, os, pty, re, select, subprocess, sys, tempfile, time

VIM = "/usr/bin/vim"


def run(cwd, args, keys):
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        env = {"TERM": "xterm-256color", "HOME": cwd, "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
        os.execve(VIM, ["vim", "-u", "NONE", "-N", "-i", "NONE", "--noplugin"] + args, env)
    out = b""

    def drain(t):
        nonlocal out
        end = time.time() + t
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try:
                    out += os.read(fd, 65536)
                except OSError:
                    return

    drain(0.8)
    for k in keys:
        os.write(fd, k.encode())
        drain(0.4)
    os.waitpid(pid, 0)
    text = re.sub(rb"\x1b\[[0-9;?>=%]*[a-zA-Z]|\x1bP[^\x1b]*\x1b\\|\x1b[()][AB0]|\x1b[=>]|\x1b\][^\x07]*\x07|[\x07\r]", b"\n", out)
    return [l.strip() for l in text.decode("utf8", "replace").split("\n") if l.strip()]


def pick(lines, pattern):
    found = [l for l in lines if re.search(pattern, l)]
    if not found:
        sys.exit(f"no line matches {pattern!r} in {lines!r}")
    return found[0]


def main():
    cases = {}
    with tempfile.TemporaryDirectory() as d:
        def write(name, text, mode=0o644):
            p = os.path.join(d, name)
            if os.path.exists(p):
                os.chmod(p, 0o644)
            with open(p, "w") as f:
                f.write(text)
            os.chmod(p, mode)

        write("f.yaml", "a: 1\nb: 2\n")
        cases["open"] = pick(run(d, ["f.yaml"], [":q\r"]), r'^"f\.yaml"')
        cases["openNew"] = pick(run(d, ["new.yaml"], [":q\r"]), r'^"new\.yaml"')
        write("ro.yaml", "a: 1\n", 0o444)
        cases["openReadonly"] = pick(run(d, ["ro.yaml"], [":q\r"]), r'^"ro\.yaml"')
        write("nonl.yaml", "a\nb")
        cases["openNoEol"] = pick(run(d, ["nonl.yaml"], [":q\r"]), r'^"nonl\.yaml"')
        cases["written"] = pick(run(d, ["f.yaml"], ["x", ":w\r", ":q\r"]), r"written$")
        write("f.yaml", "a: 1\nb: 2\n")
        cases["writtenNew"] = pick(run(d, ["n2.yaml"], ["ihello\x1b", ":w\r", ":q\r"]), r"written$")
        cases["writtenEmpty"] = pick(run(d, ["f.yaml"], ["ggdG", ":w\r", ":q\r"]), r"written$")
        write("f.yaml", "a: 1\nb: 2\n")
        cases["E37"] = pick(run(d, ["f.yaml"], ["x", ":q\r", ":q!\r"]), r"^E37")
        cases["E45"] = pick(run(d, ["ro.yaml"], ["x", ":w\r", ":q!\r"]), r"^E45")
        cases["E492"] = pick(run(d, ["f.yaml"], [":foo\r", "\x1b", ":q\r"]), r"^E492")
        cases["modeInsert"] = pick(run(d, ["f.yaml"], ["i", "\x1b", ":q\r"]), r"^-- INSERT")
        cases["modeReplace"] = pick(run(d, ["f.yaml"], ["R", "\x1b", ":q\r"]), r"^-- REPLACE")
        cases["modeVisual"] = pick(run(d, ["f.yaml"], ["v", "\x1b", ":q\r"]), r"^-- VISUAL --")
        cases["modeVisualLine"] = pick(run(d, ["f.yaml"], ["V", "\x1b", ":q\r"]), r"^-- VISUAL LINE")
        cases["modeVisualBlock"] = pick(run(d, ["f.yaml"], ["\x16", "\x1b", ":q\r"]), r"^-- VISUAL BLOCK")
        # Every Ex command name vim knows (no user commands exist with -u NONE).
        out = os.path.join(d, "ex.txt")
        subprocess.run([VIM, "-u", "NONE", "-N", "-i", "NONE", "--noplugin", "-es", "-c", f"call writefile(getcompletion('', 'command'), '{out}')", "-c", "qa!"], check=True, env={"HOME": d, "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
        with open(out) as f:
            cases["exCommands"] = sorted(l for l in f.read().split("\n") if l)
    cases["_note"] = "f.yaml holds 'a: 1\\nb: 2\\n'; written after x (one character deleted); n2.yaml after ihello<Esc>; writtenEmpty after ggdG"
    print(json.dumps(cases, indent=2, sort_keys=True))


main()

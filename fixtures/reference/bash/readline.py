# Ground truth for the line editor (packages/host, phase 03): the exact bytes the real bash and
# readline write to a terminal for given key sequences, plus readline's default bindings and
# variables and bash's builtin and keyword lists.
# Capture (from the repository root):
#   python3 -I fixtures/reference/bash/readline.py fixtures/reference/bash > fixtures/reference/bash/readline.json
# It writes readline.json to stdout and bind-p.txt, bind-v.txt, compgen-b.txt and compgen-k.txt
# into the directory given as its argument.
# Recorded with bash 5.2.21 (readline as built into it), Python 3.12.3, Linux 7.2.15-76070215-generic,
# locale C.UTF-8 (docs/FIDELITY.md §2.1).
#
# Each case starts a fresh `-bash --noprofile --norc -i` (a login shell name, no startup files,
# line editing on) on a pseudo-terminal sized with TIOCSWINSZ before exec, cwd a fresh temporary
# home, umask 022, SIGPIPE and SIGXFSZ restored to SIG_DFL. The environment is exactly
# HOME PATH LANG=C.UTF-8 TERM=xterm-256color INPUTRC=/dev/null USER LOGNAME SHELL TZ=UTC:
# INPUTRC=/dev/null keeps the owner's ~/.inputrc and /etc/inputrc out, so readline runs with its
# compiled-in emacs-mode defaults. The bind/compgen listings come from a shell started the same way.
#
# A case waits for bash's first prompt, types its setup line and Enter, and waits for the prompt
# `student@node01:~$ ` that follows `clear`; the setup line ends with PATH=$HOME/bin so command-name
# completion only sees the files the setup put there. Then each key chunk is written in one write();
# the bytes that arrive until 200 ms pass with no output are that chunk's output. A chunk written
# W(key, seconds) collects output for at least that many seconds first (the case's note says so).
# The setup line itself is history entry 1 in every case, so history keys can reach it.
# Bytes are decoded as UTF-8 with errors="backslashreplace" (everything captured is ASCII/UTF-8).
# The temporary directory's path, if it ever appears, is rewritten so the home reads /home/student.
# Shells are killed with SIGHUP then SIGKILL after the last chunk, unless the case ends the shell.
import datetime, fcntl, json, os, pty, select, signal, struct, subprocess, sys, tempfile, termios, time

ENV_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
PROMPT = b"student@node01:~$ "
SETUP_PREFIX = ("mkdir -p bin dir1 dir2 'my dir' && touch file.txt alpha1 alpha2 'my file' beta && "
                "printf '#!/bin/sh\\n' > bin/kubectl && chmod +x bin/kubectl && cp bin/kubectl bin/kubeadm")
# Commands a case executes for real must be in $HOME/bin once PATH is narrowed.
LINK_CAT = "ln -s /usr/bin/cat bin/cat"
LINK_SLEEP = "ln -s /usr/bin/sleep bin/sleep"
LEFT, RIGHT, UP, DOWN = "\x1b[D", "\x1b[C", "\x1b[A", "\x1b[B"


def W(key, wait):
    """A chunk whose output is collected for at least `wait` seconds."""
    return (key, wait)


CASES = [
    dict(name="insert-and-move",
         keys=["echo hello world"] + [LEFT] * 5 + ["X", "\x01", "#", "\x05", "!", "\x02", "\x06"]),
    dict(name="kill-and-yank",
         note="Second part (from 'abc def ghi') is on the same line: Ctrl-U before it left the line empty.",
         keys=["echo one two three", "\x17", "\x17", "\x19", "\x01", "\x0b", "\x19", "\x15",
               "abc def ghi"] + [LEFT] * 4 + ["\x15", "\x05", "\x0b"]),
    dict(name="word-moves",
         keys=["alpha beta gamma", "\x1bb", "\x1bb", "\x1bf", "\x1bd", "\x1b\x7f"]),
    dict(name="delete-keys",
         note="Without an inputrc, \\e[1~ and \\e[4~ are unbound (bind-p.txt): each rings the bell; after \\e[4~ "
              "the ~ is inserted, after \\e[1~ it is not.",
         keys=["abcdef", "\x7f", "\x01", "\x1b[3~", "\x04", "\x08", "\x1b[F", "\x1b[H", "\x1bOF", "\x1bOH",
               "\x1b[4~", "\x1b[1~"]),
    dict(name="clear-screen", keys=["echo hi", "\r", "ls", "\x0c"]),
    dict(name="ctrl-c-at-prompt", keys=["echo abc", "\x03", "echo ok", "\r"]),
    dict(name="ctrl-c-mid-line-status", note="Ctrl-C with the cursor inside the line: ^C is echoed where the cursor is; $? is 130 afterwards.",
         keys=["echo abc", "\x1b[D", "\x1b[D", "\x03", "echo $?", "\r"]),
    dict(name="ctrl-c-blocking", setup=LINK_SLEEP,
         note="Ctrl-C is sent at least 0.5 s after Enter (the Enter chunk's output is collected for 0.5 s). "
              "The setup links sleep into $HOME/bin so it runs.",
         keys=["sleep 5", W("\r", 0.5), "\x03", "echo $?", "\r"]),
    dict(name="ctrl-d-logout", note="Ctrl-D on an empty line: the login shell prints logout and exits; read to EOF.",
         keys=["\x04"], exits=True),
    dict(name="ctrl-d-cat", setup=LINK_CAT,
         note="While cat reads, the tty driver (canonical mode) echoes the input. The setup links cat into $HOME/bin.",
         keys=["cat", "\r", "abc", "\r", "\x04", "echo $?", "\r"]),
    dict(name="ctrl-c-cat", setup=LINK_CAT, note="The setup links cat into $HOME/bin.",
         keys=["cat", "\r", "abc", "\x03", "\r"]),
    dict(name="history-up-down", note="The third Up recalls history entry 1, the setup line (it wraps over three rows).",
         keys=["echo one", "\r", "echo two", "\r", UP, UP, UP, DOWN, DOWN, DOWN, "\x10", "\x0e", UP, "\r"]),
    dict(name="history-edit-then-move", note="Whether an edit to a recalled line survives moving away and back.",
         keys=["echo one", "\r", "echo two", "\r", UP, "X", UP, DOWN, DOWN, UP, "\r"]),
    dict(name="reverse-search",
         note="`ls` is not found: PATH is $HOME/bin; it only serves as a history entry. The second Ctrl-R finds "
              "'al' in history entry 1, the setup line (its last occurrence in that line first), and Enter runs it again.",
         keys=["echo alpha", "\r", "echo beta", "\r", "ls", "\r", "\x12", "a", "l", "\x12", "\r"]),
    dict(name="reverse-search-again",
         keys=["echo abc1", "\r", "echo abc2", "\r", "\x12", "abc", "\x12", "\x12", "\x07"]),
    dict(name="reverse-search-failed",
         keys=["echo alpha", "\r", "\x12", "z", "z", "\x7f", "\x7f", "a", RIGHT, "X"]),
    dict(name="reverse-search-ctrl-c", keys=["echo alpha", "\r", "\x12", "al", "\x03"]),
    dict(name="reverse-search-ctrl-e", keys=["echo alpha", "\r", "\x12", "ph", "\x05", "Z", "\r"]),
    dict(name="multiline-quote", note="The last key shows how a recalled multi-line entry is displayed.",
         keys=["echo 'a", "\r", "b'", "\r", UP]),
    dict(name="multiline-heredoc", setup=LINK_CAT, note="The setup links cat into $HOME/bin.",
         keys=["cat <<EOF", "\r", "x", "\r", "EOF", "\r", UP]),
    dict(name="wrap-long-line",
         keys=["echo " + "a" * 90, "\x01", "ZZ", "\x05"] + ["\x7f"] * 4 + ["\x15"]),
    dict(name="wrap-exact", note="Prompt (18) + 'echo ' (5) + 57 b's fills the 80-column row exactly.",
         keys=["echo " + "b" * 57, "c", "\x7f", "\x7f", "\x01", "\x05"]),
    dict(name="complete-unique-file", setup=LINK_CAT,
         note="The setup links cat into $HOME/bin so the accepted line runs (file.txt is empty).",
         keys=["cat fi", "\t", "\r"]),
    dict(name="complete-dir",
         note="dir1/dir2 are ambiguous: the first Tab inserts the common prefix with a bell; because that Tab changed "
              "the line, the second Tab only rings the bell again and the third lists.",
         keys=["cd di", "\t", "\t", "\t", "1", "\t"]),
    dict(name="complete-ambiguous-list",
         note="The first Tab inserts the common prefix 'pha' with a bell; the second only rings the bell (no list, "
              "because the first Tab changed the line).",
         keys=["cat al", "\t", "\t", "1", "\t"]),
    dict(name="complete-none", keys=["cat zz", "\t", "\t"]),
    dict(name="complete-space-in-name",
         note="The first Tab inserts the common prefix of 'my dir' and 'my file', a quoted space, so the typed "
              "backslash-space makes the word 'my  f' (two spaces) and the last Tab finds nothing.",
         keys=["cat my", "\t", "\t", "\\ f", "\t"]),
    dict(name="complete-variable",
         note="$HO is ambiguous (HOME, HOSTNAME, HOSTTYPE) and HO is already their common prefix: only a bell.",
         keys=["echo $HO", "\t", " $LO", "\t"]),
    dict(name="complete-command", keys=["kubec", "\t", "\x15", "kube", "\t", "\t", "\x15", "un", "\t", "\t"]),
    dict(name="complete-mid-line", keys=["cat fi foo"] + [LEFT] * 4 + ["\t"]),
    dict(name="complete-tilde",
         note="As in complete-dir: the first Tab inserts 'r' with a bell, the second only rings the bell.",
         keys=["ls ~/di", "\t", "\t"]),
    dict(name="complete-many", setup="mkdir many && cd many && touch $(seq -f 'f%03g' 1 150) && cd ..",
         note="f is already the common prefix: the first Tab rings the bell, the second asks. After 'n' the next "
              "Tab asks again at once, the Tab after it is an invalid answer (bell), 'y' lists. The 12-row listing "
              "fits the 24-row screen, so there is no --More-- and the space and q are inserted into the line "
              "(complete-many-paged shows the pager).",
         keys=["ls many/f", "\t", "\t", "n", "\t", "\t", "y", " ", "q"]),
    dict(name="complete-many-paged", rows=10, setup="mkdir many && cd many && touch $(seq -f 'f%03g' 1 150) && cd ..",
         note="Added to complete-many: a 10-row screen, so the 12-row listing goes through the --More-- pager. "
              "Enter shows one more line, space a page, q quits.",
         keys=["ls many/f", "\t", "\t", "y", "\r", " "]),
    dict(name="complete-many-paged-quit", rows=10, setup="mkdir many && cd many && touch $(seq -f 'f%03g' 1 150) && cd ..",
         note="Added to complete-many: q at the first --More--.",
         keys=["ls many/f", "\t", "\t", "y", "q"]),
    dict(name="complete-narrow", cols=40,
         note="The first Tab rings the bell (nothing to insert), the second lists in a 40-column screen.", keys=["ls ", "\t", "\t"]),
    dict(name="complete-empty-command",
         note="85 candidates (builtins, keywords, kubeadm, kubectl, ./) are fewer than completion-query-items (100): "
              "the second Tab lists without asking and the 'n' is inserted into the line.",
         keys=["\t", "\t", "n"]),
    dict(name="unbound-and-unsupported-keys",
         note="Reference only. Alt-. (yank-last-arg), Ctrl-T (transpose-chars) after typing 'ab'. PageUp is "
              "history-search-backward (no entry starts with 'ba': bell) and Insert is overwrite-mode (toggles, "
              "prints nothing) in readline's defaults (bind-p.txt).",
         keys=["echo a b", "\r", "x", "\x1b.", "\x15", "ab", "\x14", "\x1b[5~", "\x1b[2~"]),
    dict(name="ctrl-c-pending-input-blocking", setup=LINK_SLEEP,
         note="Typeahead during a blocking command: the line is typed while sleep 2 runs; the final empty chunk "
              "sends nothing and collects output for 2.5 s. The setup links sleep into $HOME/bin.",
         keys=["sleep 2", "\r", "echo typed-ahead", "\r", W("", 2.5)]),
]


def read_some(fd, timeout):
    """One read with a timeout: bytes, b"" on timeout, None at EOF."""
    r, _, _ = select.select([fd], [], [], timeout)
    if not r:
        return b""
    try:
        data = os.read(fd, 65536)
    except OSError:  # EIO: the slave side is closed
        return None
    return data if data else None


def read_quiet(fd, quiet=0.2, at_least=0.0, limit=30.0):
    """Bytes until `quiet` seconds pass without output (after at least `at_least` seconds)."""
    buf, start = b"", time.monotonic()
    last = start
    while True:
        now = time.monotonic()
        if now - start > limit:
            raise SystemExit("output never went quiet: %r" % buf[-200:])
        wait = max(quiet - (now - last), at_least - (now - start), 0.001)
        data = read_some(fd, wait)
        if data is None:
            return buf, True
        if data:
            buf += data
            last = time.monotonic()
        elif time.monotonic() - last >= quiet and time.monotonic() - start >= at_least:
            return buf, False


def read_until(fd, suffix, timeout=10.0):
    buf, deadline = b"", time.monotonic() + timeout
    while not buf.endswith(suffix):
        left = deadline - time.monotonic()
        if left <= 0:
            raise SystemExit("timed out waiting for %r; got %r" % (suffix, buf[-300:]))
        data = read_some(fd, left)
        if data is None:
            raise SystemExit("EOF waiting for %r; got %r" % (suffix, buf[-300:]))
        buf += data
    return buf


def read_eof(fd, timeout=10.0):
    buf, deadline = b"", time.monotonic() + timeout
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            raise SystemExit("no EOF; got %r" % buf[-300:])
        data = read_some(fd, left)
        if data is None:
            return buf
        buf += data


def spawn(home, cols, rows):
    env = {"HOME": home, "PATH": ENV_PATH, "LANG": "C.UTF-8", "TERM": "xterm-256color", "INPUTRC": "/dev/null",
           "USER": "student", "LOGNAME": "student", "SHELL": "/bin/bash", "TZ": "UTC"}
    pid, fd = pty.fork()
    if pid == 0:
        # Python ignores SIGPIPE and SIGXFSZ and an ignored signal stays ignored across exec.
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
        signal.signal(signal.SIGXFSZ, signal.SIG_DFL)
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.chdir(home)
        os.umask(0o022)
        os.execve("/bin/bash", ["-bash", "--noprofile", "--norc", "-i"], env)
    return pid, fd


def finish(pid, fd, exited):
    if not exited:
        for sig in (signal.SIGHUP, signal.SIGKILL):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                break
            time.sleep(0.1)
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    os.close(fd)


def run_case(case):
    cols, rows = case.get("cols", 80), case.get("rows", 24)
    extra = case.get("setup")
    cmds = SETUP_PREFIX + (" && " + extra if extra else "")
    setup = "PS1='student@node01:\\w\\$ '; %s; clear; PATH=$HOME/bin" % cmds
    with tempfile.TemporaryDirectory(prefix="simlab-readline-") as tmp:
        home = os.path.join(tmp, "home", "student")
        os.makedirs(home)

        def text(b):
            return b.decode("utf-8", "backslashreplace").replace(tmp, "")

        pid, fd = spawn(home, cols, rows)
        exited = False
        try:
            out = read_until(fd, b"$ ")  # bash's own first prompt
            os.write(fd, setup.encode() + b"\r")
            out += read_until(fd, PROMPT)
            more, _ = read_quiet(fd)
            if more:
                raise SystemExit("%s: output after the prompt: %r" % (case["name"], more))
            keys, outputs = [], []
            for k in case["keys"]:
                key, wait = k if isinstance(k, tuple) else (k, 0.0)
                if exited:
                    raise SystemExit("%s: key after the shell exited" % case["name"])
                if key:
                    os.write(fd, key.encode())
                if case.get("exits"):
                    got, exited = read_eof(fd), True
                else:
                    got, exited = read_quiet(fd, at_least=wait)
                keys.append(key)
                outputs.append(text(got))
        finally:
            finish(pid, fd, exited)
    res = {"name": case["name"]}
    if case.get("note"):
        res["note"] = case["note"]
    res.update(cols=cols, rows=rows, setup=setup, setupOutput=text(out), keys=keys, outputs=outputs)
    if exited:
        res["exited"] = True
    return res


def capture_listings(outdir):
    """bind -p, bind -v, compgen -b, compgen -k from an interactive shell started like the cases."""
    with tempfile.TemporaryDirectory(prefix="simlab-readline-") as tmp:
        home = os.path.join(tmp, "home", "student")
        os.makedirs(home)
        pid, fd = spawn(home, 80, 24)
        try:
            read_until(fd, b"$ ")
            os.write(fd, b"bind -p > bind-p.txt; bind -v > bind-v.txt; compgen -b > compgen-b.txt; "
                         b"compgen -k > compgen-k.txt; exit\r")
            read_eof(fd)
        finally:
            finish(pid, fd, True)
        for name in ("bind-p.txt", "bind-v.txt", "compgen-b.txt", "compgen-k.txt"):
            with open(os.path.join(home, name), "rb") as src, open(os.path.join(outdir, name), "wb") as dst:
                dst.write(src.read())


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 -I readline.py <dir for the .txt listings> > readline.json")
    capture_listings(sys.argv[1])
    version = subprocess.run(["/bin/bash", "--version"], capture_output=True, text=True,
                             env={"LANG": "C.UTF-8"}).stdout.splitlines()[0]
    fixture = {"captured": datetime.date.today().isoformat(), "bash": version, "setupPrefix": SETUP_PREFIX,
               "cases": [run_case(c) for c in CASES]}
    json.dump(fixture, sys.stdout, indent=2, ensure_ascii=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()

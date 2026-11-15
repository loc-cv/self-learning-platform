#!/usr/bin/env python3
"""Runs commands in a real interactive bash on a pseudo-terminal and records what each prints.

Rank 3 ground truth for transcripts (docs/FIDELITY.md §2, §2.1). Called by capture.ts; reads one
JSON request on stdin and writes one JSON result on stdout.

The shell is started the way a login on the simulated host starts it, minus startup files:
argv[0] is `-bash` (a login shell, so its messages begin with `-bash:`), `--noprofile --norc`
because the simulator does not read startup files yet, and `--noediting` because readline would
redraw the line. The environment is cleared (`env -i` style) and rebuilt as the simulated login's.
Echo is turned off, PS1 and PS2 are empty, and PROMPT_COMMAND prints a sentinel carrying `$?`
before each prompt, so the output between two sentinels is exactly what one command printed.

Paths under the temporary directory are rewritten to the simulated ones, the workstation's user,
group and host names to the simulated ones. Line endings come back as the terminal sent them
(CR LF); the caller normalizes.

Request:  {"commands": [str], "setup": [str], "cols": int, "rows": int,
           "user": str, "hostname": str, "timeout": float}
Result:   {"setup": [{"output": str, "status": int}], "results": [{"output": str, "status": int}],
           "versions": {...}}
"""

import fcntl
import grp
import json
import os
import pty
import pwd
import re
import select
import signal
import socket
import struct
import sys
import tempfile
import termios
import time

SENTINEL = re.compile(rb"\x01(\d+)\x02")
PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin"


def read_until_sentinel(fd, timeout):
    buf = b""
    deadline = time.monotonic() + timeout
    while True:
        m = SENTINEL.search(buf)
        if m:
            return buf[: m.start()], int(m.group(1)), buf[m.end():]
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError(buf.decode("utf-8", "replace"))
        r, _, _ = select.select([fd], [], [], left)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                raise EOFError(buf.decode("utf-8", "replace"))
            buf += chunk


def main():
    req = json.load(sys.stdin)
    user = req.get("user", "student")
    hostname = req.get("hostname", "node01")
    cols, rows = req.get("cols", 80), req.get("rows", 24)
    timeout = req.get("timeout", 10.0)
    real_user = pwd.getpwuid(os.getuid()).pw_name
    real_group = grp.getgrgid(os.getgid()).gr_name
    real_host = socket.gethostname()

    with tempfile.TemporaryDirectory(prefix="simlab-capture-") as tmp:
        home = os.path.join(tmp, "home", user)
        os.makedirs(home)
        os.chmod(home, 0o750)
        env = {
            "HOME": home,
            "PATH": PATH,
            "LANG": "C.UTF-8",
            "TERM": "xterm-256color",
            "USER": user,
            "LOGNAME": user,
            "SHELL": "/bin/bash",
            "MAIL": "/var/mail/" + user,
            "TZ": "UTC",
        }
        pid, fd = pty.fork()
        if pid == 0:
            # Python ignores SIGPIPE and SIGXFSZ, and an ignored signal stays ignored across exec:
            # restore the defaults a login shell starts with.
            signal.signal(signal.SIGPIPE, signal.SIG_DFL)
            signal.signal(signal.SIGXFSZ, signal.SIG_DFL)
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            os.chdir(home)
            os.umask(0o022)
            os.execve("/bin/bash", ["-bash", "--noprofile", "--norc", "--noediting", "-i"], env)
        try:
            os.write(fd, b"stty -echo; PS1=; PS2=; PROMPT_COMMAND='printf \"\\001%s\\002\" \"$?\"'\n")
            _, _, rest = read_until_sentinel(fd, timeout)

            ended = False

            def run(cmd):
                nonlocal rest, ended
                if ended:
                    raise SystemExit("command %r comes after the shell exited" % cmd)
                os.write(fd, cmd.encode() + b"\n")
                try:
                    out, status, rest = read_until_sentinel(fd, timeout)
                except EOFError as e:
                    # The shell exited (`exit`, end of input): its status is the command's.
                    _, ws = os.waitpid(pid, 0)
                    ended = True
                    out, status = str(e).encode(), os.waitstatus_to_exitcode(ws)
                except TimeoutError as e:
                    raise SystemExit("no prompt after %r (incomplete input or a command that waits?); got %r" % (cmd, str(e)))
                text = out.decode("utf-8", "replace")
                text = text.replace(tmp, "")
                # The host name first: it may contain the user name.
                text = re.sub(r"\b%s\b" % re.escape(real_host), hostname, text)
                text = re.sub(r"\b%s\b" % re.escape(real_user), user, text)
                if real_group != real_user:
                    text = re.sub(r"\b%s\b" % re.escape(real_group), user, text)
                return {"output": text, "status": status}

            setup = [run(c) for c in req.get("setup", [])]
            results = [run(c) for c in req["commands"]]
        finally:
            try:
                os.kill(pid, 9)
                os.waitpid(pid, 0)
            except (OSError, ChildProcessError):
                pass
    json.dump({"setup": setup, "results": results}, sys.stdout)


if __name__ == "__main__":
    main()

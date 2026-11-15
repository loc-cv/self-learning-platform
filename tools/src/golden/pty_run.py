#!/usr/bin/env python3
"""Run one command on a pseudo-terminal of a given size and report what the terminal showed.

Used by tools/src/golden/capture.ts for golden steps marked `tty`: kubectl wraps help text to the
terminal's width only when standard output is a terminal (upstream:
staging/src/k8s.io/kubectl/pkg/util/term/term_writer.go GetWordWrapperLimit).

Input on stdin (JSON): {"argv": [...], "cwd": "...", "env": {...}, "cols": 80, "rows": 24}
Output on stdout (JSON): {"output": "...", "status": N}; output has the terminal's CRLF turned into LF.
"""

import fcntl
import json
import os
import pty
import select
import struct
import sys
import termios


def main() -> None:
    req = json.load(sys.stdin)
    pid, fd = pty.fork()
    if pid == 0:
        # Size the terminal before exec, so the program sees it at start.
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", req["rows"], req["cols"], 0, 0))
        os.chdir(req["cwd"])
        os.execve(req["argv"][0], req["argv"], req["env"])
    chunks = []
    while True:
        r, _, _ = select.select([fd], [], [], 30)
        if not r:
            break
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        chunks.append(data)
    _, st = os.waitpid(pid, 0)
    status = os.waitstatus_to_exitcode(st)
    out = b"".join(chunks).decode("utf-8", "replace").replace("\r\n", "\n")
    json.dump({"output": out, "status": status}, sys.stdout)


main()

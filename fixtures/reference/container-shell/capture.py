#!/usr/bin/env python3
# Captures how the shells a container's `sh` can be (dash, BusyBox ash, bash) run `sh -c` scripts:
# stdout, stderr and the exit status, in the clean environment a container has.
#   python3 fixtures/reference/container-shell/capture.py > fixtures/reference/container-shell/cases.json
# Used by packages/host/src/models/sh/reference.test.ts. Read-only on the workstation.
import json, subprocess, shutil, sys

SHELLS = {
    'dash': (shutil.which('dash'), 'sh'),
    'busybox': (shutil.which('busybox'), 'sh'),
    'bash': (shutil.which('bash'), 'bash'),
}
ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'TZ': 'UTC', 'LC_ALL': 'C', 'HOSTNAME': 'web'}

CASES = [
    'echo hello world',
    'echo "a  b"   c',
    "echo 'single $HOME' \"double $HOSTNAME\"",
    'foo',
    'echo a\nfoo bar',
    '/x/y',
    'exit 3',
    'exit 300',
    'exit x',
    'false; echo $?',
    'true && echo yes || echo no',
    'false && echo yes || echo no',
    'false || false && echo x; echo $?',
    '! false; echo $?',
    'i=0; while [ $i -lt 3 ]; do echo $i; i=$((i+1)); done',
    'i=5; until [ $i -le 2 ]; do echo $i; i=$((i - 1)); done',
    'for x in a b "c d"; do echo "<$x>"; done',
    'for x in; do echo never; done; echo after',
    'if [ 1 -eq 1 ]; then echo one; elif true; then echo two; else echo three; fi',
    'if false; then echo a; elif [ x = y ]; then echo b; else echo c; fi',
    'if false; then echo a; fi; echo $?',
    '[ 1 -lt x ]; echo $?',
    '[ 1 -lt 2; echo $?',
    '[ -z "" ] && [ -n x ] && echo ok',
    'test a != b -a 3 -ge 3; echo $?',
    'echo $((7/2)) $((7%3)) $((2*3+4)) $((1<2)) $((-5+2))',
    'x=abc; echo ${x}def $x',
    'echo $0 $1 $2 $#',
    'printf "%s-%d\\n" a 5 b 6',
    'printf "%5s|%-5s|%03d\\n" ab cd 7',
    'printf "%x %X %o\\n" 255 255 8',
    'echo -n x; echo y',
    'echo -e "a\\tb"',
    'echo "a\\tb"',
    'echo out; echo err >&2',
    'echo hidden >/dev/null; echo shown',
    'foo 2>/dev/null; echo $?',
    'echo $(echo inner) "$(printf "%s" q)"',
    'v=$(echo hi); echo "[$v]"',
    'exec foo',
    'set -e; echo a; false; echo b',
    'set -e; false || echo handled; echo end',
    'sleep 0; echo slept',
    'sleep x; echo $?',
    'sleep; echo $?',
    'printenv HOSTNAME; printenv NOPE; echo $?',
    'unset HOSTNAME; echo "[$HOSTNAME]"',
    'export A=1; printenv A',
    '(x=1); echo "[$x]"',
    '{ echo g1; echo g2; }',
    'while true; do echo',
    'if true; then echo',
    'echo "abc',
    'fi',
    'echo (a)',
    'echo $((1+))',
    '# only a comment',
    'echo a # trailing comment',
    'echo a\\\nb',
]

def run(sh, script, args=()):
    exe, argv0 = SHELLS[sh]
    p = subprocess.run([argv0, '-c', script, *args], executable=exe, env=ENV, capture_output=True, timeout=10, cwd='/')
    return {'stdout': p.stdout.decode(), 'stderr': p.stderr.decode(), 'status': p.returncode}

versions = {
    'dash': subprocess.run(['dpkg-query', '-W', '-f=${Version}', 'dash'], capture_output=True, text=True).stdout,
    'busybox': subprocess.run(['busybox'], capture_output=True, text=True).stdout.splitlines()[0],
    'bash': subprocess.run(['bash', '--version'], capture_output=True, text=True).stdout.splitlines()[0],
}
out = {'env': ENV, 'versions': versions, 'cases': []}
for script in CASES:
    case = {'script': script, 'args': ['a1', 'a2'] if '$1' in script else []}
    for sh in SHELLS:
        case[sh] = run(sh, script, case['args'])
    out['cases'].append(case)
json.dump(out, sys.stdout, indent=1, ensure_ascii=False)
print()

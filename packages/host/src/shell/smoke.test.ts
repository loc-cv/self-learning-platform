import { describe, expect, test } from 'vitest';
import { captureOutput, openSession } from '../transcript/session.ts';
import { defaultTranscriptWorld } from '../transcript/runner.ts';

describe('shell smoke', () => {
  test('builtins, variables, quoting', () => {
    const cap = captureOutput();
    const w = defaultTranscriptWorld(cap.ports);
    const s = openSession(w.kernel, cap, { machine: w.machine, user: w.user });
    const r = (c: string) => s.run(c);
    expect(r('echo hi')).toMatchObject({ output: 'hi\n', status: 0 });
    expect(r('x="a  b"; echo $x "$x"')).toMatchObject({ output: 'a b a  b\n' });
    expect(r('false; echo $?')).toMatchObject({ output: '1\n' });
    expect(r('foo')).toMatchObject({ output: '-bash: foo: command not found\n', status: 127 });
    expect(r('echo )')).toMatchObject({ output: "-bash: syntax error near unexpected token `)'\n", status: 2 });
    expect(r('pwd')).toMatchObject({ output: '/home/student\n' });
    expect(r('cd /tmp && pwd; cd -')).toMatchObject({ output: '/tmp\n/home/student\n' });
    expect(r('echo a{b,c}d {1..3}')).toMatchObject({ output: 'abd acd 1 2 3\n' });
    expect(r('alias hi="echo hello"')).toMatchObject({ output: '' });
    expect(r('hi there')).toMatchObject({ output: 'hello there\n' });
    expect(r('printf "%s-%03d\\n" a 7')).toMatchObject({ output: 'a-007\n' });
    expect(r('[ 1 -eq a ]; echo $?')).toMatchObject({ output: '-bash: [: a: integer expression expected\n2\n' });
    expect(r('for x in a; do echo; done')).toMatchObject({ output: '[sim] bash: the "for" loop is not simulated yet\n', status: 250 });
    expect(r('echo $(echo sub) `echo bt`')).toMatchObject({ output: 'sub bt\n' });
    expect(r('echo hi > f; echo there >> f; type cd')).toMatchObject({ output: 'cd is a shell builtin\n' });
    expect(r('bash -c "echo \\$0 \\$1" a b')).toMatchObject({ output: 'a b\n' });
    expect(r('x=1; bash -c "echo [\\$x]"; export x; bash -c "echo [\\$x]"')).toMatchObject({ output: '[]\n[1]\n' });
    expect(r('echo a | bash -c "echo piped"')).toMatchObject({ output: 'piped\n' });
    expect(r('exit 3')).toMatchObject({ output: 'logout\n', status: 3 });
  });
});

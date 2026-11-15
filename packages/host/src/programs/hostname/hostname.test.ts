// hostname forms that depend on the machine's own name, and root-only behavior, which a golden
// transcript cannot capture. docs: hostname(1) of hostname 3.23 (-s cuts the name at the first
// dot); sethostname(2) (EPERM without CAP_SYS_ADMIN). Units tagged source-derived.

import { describe, expect, test } from 'vitest';
import { getMachine } from '../../machine.ts';
import { defaultTranscriptWorld } from '../../transcript/runner.ts';
import { captureOutput, openSession } from '../../transcript/session.ts';

function session(user = 'student', hostname?: string) {
  const capture = captureOutput();
  const w = defaultTranscriptWorld(capture.ports);
  if (hostname !== undefined) {
    w.kernel.act('rename', (ctx) => {
      getMachine(ctx, w.machine).hostname = hostname;
    });
  }
  return openSession(w.kernel, capture, { machine: w.machine, user });
}

describe('hostname', () => {
  test('prints the kernel host name; -s cuts it at the first dot', () => {
    const s = session('student', 'web1.example.com');
    expect(s.run('hostname').output).toBe('web1.example.com\n');
    expect(s.run('hostname -s').output).toBe('web1\n');
    expect(s.run('hostname --short').output).toBe('web1\n');
    expect(session().run('hostname -s').output).toBe('node01\n');
  });

  test('forms that need the resolver print the notice', () => {
    const s = session();
    for (const cmd of ['hostname -f', 'hostname -d', 'hostname -i', 'hostname -I', 'hostname -A', 'hostname -a', 'dnsdomainname']) {
      const r = s.run(cmd);
      expect(r.status, cmd).toBe(250);
      expect(r.output, cmd).toMatch(/^\[sim\] (hostname|dnsdomainname): /);
    }
  });

  test('root gets the notice for setting the name', () => {
    const r = session('root').run('hostname newname');
    expect(r.status).toBe(250);
    expect(r.output).toContain('[sim] hostname: setting the host name is not simulated yet');
  });
});

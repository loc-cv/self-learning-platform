import { describe, expect, test } from 'vitest';
import type { Json } from '@simlab/kernel';
import type { ModelStep } from '../types.ts';
import { httpdForegroundModel, httpdModel } from './httpd.ts';
import { T0, lines, processInput, type FakeImage } from './testing.ts';

const HOSTS = '# Kubernetes-managed hosts file.\n127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n10.244.1.5\tweb-0\n';
const IMG: FakeImage = {
  path: ['/usr/local/apache2/bin', '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'],
  files: {
    '/usr/local/bin/httpd-foreground': { model: 'httpd-foreground', variant: 'script' },
    '/usr/local/apache2/bin/httpd': { model: 'httpd', variant: 'httpd' },
    '/bin/sh': { model: 'sh', variant: 'dash' },
  },
  etc: { '/etc/hosts': HOSTS },
};
const ENV: [string, string][] = [
  ['PATH', '/usr/local/apache2/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
  ['HTTPD_PREFIX', '/usr/local/apache2'],
  ['HTTPD_VERSION', '2.4.71'],
];
const ARGV = ['httpd', '-DFOREGROUND'];

const run = (img = IMG, argv = ARGV, over = {}): ModelStep => httpdModel.start(processInput(img, '/usr/local/apache2/bin/httpd', argv, ENV, over));

function state(step: ModelStep): Json {
  const n = step.next;
  if (!('state' in n)) throw new Error('no state');
  return n.state;
}

/** Replace the volatile fields (microseconds, tid) so the format itself is compared. */
const norm = (l: string): string => l.replace(/\.\d{6} /, '.uuuuuu ').replace(/tid \d+\]/, 'tid T]');

describe('httpd-foreground', () => {
  test('execs httpd -DFOREGROUND with its arguments', () => {
    const step = httpdForegroundModel.start(processInput(IMG, '/usr/local/bin/httpd-foreground', ['httpd-foreground', '-X'], ENV));
    expect(step.next).toEqual({ exec: { exe: { path: '/usr/local/apache2/bin/httpd', model: 'httpd', variant: 'httpd' }, argv: ['httpd', '-DFOREGROUND', '-X'] } });
  });

  test('without httpd: the shell’s exec error on line 7', () => {
    const img: FakeImage = { files: { '/usr/local/bin/httpd-foreground': { model: 'httpd-foreground', variant: 'script' }, '/bin/sh': { model: 'sh', variant: 'busybox' } } };
    const step = httpdForegroundModel.start(processInput(img, '/usr/local/bin/httpd-foreground', ['httpd-foreground'], ENV));
    expect(lines(step)).toEqual(['E +0 /usr/local/bin/httpd-foreground: exec: line 7: httpd: not found']);
    expect(step.next).toEqual({ exit: 127 });
  });
});

describe('httpd', () => {
  test('startup: AH00558 twice, then AH00489 and AH00094 in the error log format', () => {
    const step = run();
    expect(lines(step).map(norm)).toEqual([
      "E +0 AH00558: httpd: Could not reliably determine the server's fully qualified domain name, using 10.244.1.5. Set the 'ServerName' directive globally to suppress this message",
      "E +4 AH00558: httpd: Could not reliably determine the server's fully qualified domain name, using 10.244.1.5. Set the 'ServerName' directive globally to suppress this message",
      'E +10 [Mon Nov 16 05:47:37.uuuuuu 2026] [mpm_event:notice] [pid 1:tid T] AH00489: Apache/2.4.71 (Unix) configured -- resuming normal operations',
      "E +10 [Mon Nov 16 05:47:37.uuuuuu 2026] [core:notice] [pid 1:tid T] AH00094: Command line: 'httpd -D FOREGROUND'",
    ]);
    expect(lines(step)[2]).toMatch(/\[Mon Nov 16 05:47:37\.260\d{3} 2026\] \[mpm_event:notice\] \[pid 1:tid 1\d{14}\]/);
    expect(step.listen).toEqual([{ port: 80, protocol: 'tcp' }]);
    // Deterministic.
    expect(run()).toEqual(step);
  });

  test('a Pod with a subdomain has an FQDN in /etc/hosts: no AH00558', () => {
    const img = { ...IMG, etc: { '/etc/hosts': '10.244.1.5\tweb-0.web.default.svc.cluster.local\tweb-0\n' } };
    expect(lines(run(img)).filter((l) => l.includes('AH00558'))).toEqual([]);
  });

  test('/etc/hosts unreadable: the lines are left out and the gap says so', () => {
    const step = run({ ...IMG, etc: {} });
    expect(lines(step)).toHaveLength(2);
    expect(step.gaps?.[0]?.what).toBe('httpd: ServerName lookup');
  });

  test('SIGWINCH: graceful stop, exit 0 after the one-second wait', () => {
    const s0 = run();
    const p = processInput(IMG, '/usr/local/apache2/bin/httpd', ARGV, ENV, { now: T0 + 5_000 });
    const step = httpdModel.signal?.(p, state(s0), 'SIGWINCH') as ModelStep;
    expect(lines(step).map(norm)).toEqual(['E +0 [Mon Nov 16 05:47:42.uuuuuu 2026] [mpm_event:notice] [pid 1:tid T] AH00492: caught SIGWINCH, shutting down gracefully']);
    expect(step.next).toMatchObject({ wake: 1010 });
    expect(step.listen).toEqual([]);
    expect(httpdModel.resume(p, state(step))).toEqual({ next: { exit: 0 } });
  });

  test('SIGTERM: children reaped, then AH00491', () => {
    const step = httpdModel.signal?.(processInput(IMG, '/usr/local/apache2/bin/httpd', ARGV, ENV), state(run()), 'SIGTERM') as ModelStep;
    expect(lines(step).map(norm)).toEqual(['E +16 [Mon Nov 16 05:47:37.uuuuuu 2026] [mpm_event:notice] [pid 1:tid T] AH00491: caught SIGTERM, shutting down']);
    expect(step.next).toMatchObject({ wake: 26 });
  });

  test('options other than -D FOREGROUND are gaps', () => {
    expect(run(IMG, ['httpd', '-v'])).toMatchObject({ next: { exit: 0 }, gaps: [{ what: 'httpd -v' }] });
    expect(run(IMG, ['httpd'])).toMatchObject({ next: { exit: 0 } });
  });
});

// chown as root, which a capture on the workstation cannot show (it runs as an ordinary user).
// source-derived: the messages follow coreutils 9.4 src/chown-core.c describe_change (old spec
// from the file's ids, new spec from the names given, numbers when looked up by number, an empty
// user for ":GROUP" given by name); the effects follow chown(2): root may give files away, and
// changing the owner of a non-directory clears its set-user-ID bit.
import { describe, expect, test } from 'vitest';
import { captureOutput, openSession } from '../../transcript/session.ts';
import { defaultTranscriptWorld } from '../../transcript/runner.ts';

describe('chown as root', () => {
  test('gives files away, recursively and by reference', () => {
    const cap = captureOutput();
    const w = defaultTranscriptWorld(cap.ports);
    const s = openSession(w.kernel, cap, { machine: w.machine, user: 'root' });
    const r = (c: string) => s.run(c);
    r('cd /tmp; touch f; chmod 4755 f; mkdir -p d/e; touch d/e/x');
    expect(r('chown -v student:student f')).toMatchObject({ output: "changed ownership of 'f' from root:root to student:student\n", status: 0 });
    expect(r('chmod -v u+ f')).toMatchObject({ output: "mode of 'f' retained as 0755 (rwxr-xr-x)\n" });
    expect(r('chown -Rv 1000:sudo d')).toMatchObject({
      output: "changed ownership of 'd/e/x' from root:root to :sudo\nchanged ownership of 'd/e' from root:root to :sudo\nchanged ownership of 'd' from root:root to :sudo\n",
      status: 0,
    });
    expect(r('chown -v --from=student:sudo root d')).toMatchObject({ output: "changed ownership of 'd' from student to root\n", status: 0 });
    expect(r('chown -v --from=student:sudo root d')).toMatchObject({ output: "ownership of 'd' retained as root\n", status: 0 });
    expect(r('chown -c daemon: f')).toMatchObject({ output: "changed ownership of 'f' from student:student to daemon:daemon\n" });
    expect(r('chown -v :0 f')).toMatchObject({ output: "changed group of 'f' from daemon to 0\n" });
    expect(r('chown -v 4242:4242 f')).toMatchObject({ output: "changed ownership of 'f' from daemon:root to 4242:4242\n" });
    expect(r('chown -v --reference=/etc f')).toMatchObject({ output: "changed ownership of 'f' from 4242:4242 to root:root\n" });
  });
});

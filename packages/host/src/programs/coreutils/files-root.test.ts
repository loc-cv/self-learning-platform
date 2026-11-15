// mkdir, touch, rm, chmod, ln, cp and mv as root, which a capture on the workstation cannot show
// (it runs as an ordinary user).
// source-derived: root has CAP_DAC_OVERRIDE, CAP_FOWNER and CAP_CHOWN (capabilities(7)), so
// permission bits and ownership do not stop it; rm never asks about write-protected files for
// root (coreutils 9.4 src/remove.c write_protected_non_symlink, can_write_any_file); cp -p keeps
// the owner when it can (src/copy.c set_owner); protected_hardlinks exempts CAP_FOWNER
// (proc_sys_fs(5)).
import { describe, expect, test } from 'vitest';
import { captureOutput, openSession } from '../../transcript/session.ts';
import { defaultTranscriptWorld } from '../../transcript/runner.ts';

function rootSession() {
  const cap = captureOutput();
  const w = defaultTranscriptWorld(cap.ports);
  const s = openSession(w.kernel, cap, { machine: w.machine, user: 'root' });
  return (c: string) => s.run(c);
}

describe('file programs as root', () => {
  test('permission bits do not stop root', () => {
    const r = rootSession();
    r('cd /tmp; mkdir ro; touch ro/f; chmod 000 ro ro/f');
    expect(r('touch ro/g; echo $?')).toMatchObject({ output: '0\n' });
    expect(r('cp ro/f ro/h; mv ro/h ro/i; ln ro/i ro/j; echo $?')).toMatchObject({ output: '0\n' });
    // A write-protected file is removed without a question, even from a terminal.
    expect(r('rm ro/f; echo $?')).toMatchObject({ output: '0\n' });
    expect(r('rm -r ro; echo $?')).toMatchObject({ output: '0\n' });
  });

  test("root changes other users' files and keeps their owner with cp -p", () => {
    const r = rootSession();
    r('cd /home/student');
    expect(r('chmod -v 600 .profile')).toMatchObject({ output: "mode of '.profile' changed from 0644 (rw-r--r--) to 0600 (rw-------)\n", status: 0 });
    expect(r('touch -d 2026-01-01 .profile; echo $?')).toMatchObject({ output: '0\n' });
    expect(r('cp -p .profile /tmp/p; cp .profile /tmp/q; [ -O /tmp/p ] || echo not-root; [ -O /tmp/q ] && echo root')).toMatchObject({ output: 'not-root\nroot\n' });
    expect(r('ln .profile /tmp/hl; echo $?')).toMatchObject({ output: '0\n' });
  });

  test('rm still refuses / without --no-preserve-root', () => {
    const r = rootSession();
    expect(r('rm -rf /')).toMatchObject({
      output: "rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n",
      status: 1,
    });
    expect(r('[ -d /etc ] && echo intact')).toMatchObject({ output: 'intact\n' });
  });
});

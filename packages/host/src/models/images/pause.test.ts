import { expect, test } from 'vitest';
import { componentModel } from './component.ts';
import { pauseModel } from './pause.ts';
import { lines, processInput, type FakeImage } from './testing.ts';

const PAUSE: FakeImage = { files: { '/pause': { model: 'pause', variant: 'pause' } } };
const COREDNS: FakeImage = { files: { '/coredns': { model: 'component', variant: 'coredns' } } };

test('pause: silent until SIGTERM or SIGINT, then psignal’s line and exit 0', () => {
  const p = processInput(PAUSE, '/pause', ['/pause'], []);
  const s0 = pauseModel.start(p);
  expect(s0).toEqual({ next: { wait: true, state: null } });
  expect(lines(pauseModel.signal?.(p, null, 'SIGTERM') as never)).toEqual(['E +0 Shutting down, got signal: Terminated']);
  expect(pauseModel.signal?.(p, null, 'SIGINT')).toEqual({ output: [{ stream: 'stderr', text: 'Shutting down, got signal: Interrupt\n' }], next: { exit: 0 } });
  // No handler: the default action, which PID 1 does not get.
  expect(pauseModel.signal?.(p, null, 'SIGQUIT')).toBe('default');
});

test('pause: warns when it is not PID 1', () => {
  const s0 = pauseModel.start(processInput(PAUSE, '/pause', ['/pause'], [], { pid: 7, init: false }));
  expect(lines(s0)).toEqual(['E +0 Warning: pause should be the first process']);
});

test('component stand-in: runs silently, SIGTERM exits 0', () => {
  const p = processInput(COREDNS, '/coredns', ['/coredns', '-conf', '/etc/coredns/Corefile'], []);
  expect(componentModel.start(p)).toEqual({ next: { wait: true, state: null } });
  expect(componentModel.signal?.(p, null, 'SIGTERM')).toEqual({ next: { exit: 0 } });
  expect(componentModel.signal?.(p, null, 'SIGHUP')).toBe('default');
});

// A small hook on `window.__simlab` for the Playwright tests and the latency measurement
// (`npm run bench:web`): what the active terminal shows, and timed keystrokes. It reads the page;
// it changes nothing the learner could not change by typing.

import type { EngineClient } from './engine.ts';
import type { Tab, TerminalHandle } from './Terminal.tsx';

export interface Probe {
  /** The active terminal's screen rows. */
  screen(): string[];
  /** The active terminal's width in columns. */
  cols(): number;
  /** The active terminal's TTY id. */
  tty(): string | undefined;
  /** Types `text` one key at a time; resolves with each key's time from send to echo on screen (ms). */
  type(text: string): Promise<number[]>;
  /** Presses Enter; resolves with the time until the prompt is back on the cursor line (ms). */
  enter(prompt?: RegExp): Promise<{ parsed: number; painted: number }>;
  /** Moves virtual time on (tests wait for Pods without waiting in real time). */
  advance(ms: number): void;
  /** How fast virtual time runs against real time (the protocol's speed control, phase 13's UI). */
  speed(n: number): void;
}

export function installProbe(client: EngineClient, handles: Map<number, TerminalHandle>, state: () => { tabs: Tab[]; activeTab?: number }): void {
  const active = (): { h: TerminalHandle; tty: string } | undefined => {
    const s = state();
    const t = s.tabs.find((x) => x.key === s.activeTab);
    const h = s.activeTab === undefined ? undefined : handles.get(s.activeTab);
    return t?.tty && h ? { h, tty: t.tty } : undefined;
  };
  const until = (h: TerminalHandle, ok: () => boolean): Promise<number> =>
    new Promise((resolve, reject) => {
      const t0 = performance.now();
      const timer = setTimeout(() => {
        off();
        reject(new Error(`the terminal did not reach the expected state; cursor line: ${JSON.stringify(h.beforeCursor())}`));
      }, 10_000);
      const off = h.onParsed(() => {
        if (!ok()) return;
        off();
        clearTimeout(timer);
        resolve(performance.now() - t0);
      });
    });
  const probe: Probe = {
    screen: () => active()?.h.screen() ?? [],
    cols: () => active()?.h.cols() ?? 0,
    tty: () => active()?.tty,
    async type(text) {
      const a = active();
      if (!a) throw new Error('no active terminal');
      const times: number[] = [];
      for (const ch of text) {
        const want = a.h.beforeCursor() + ch;
        const done = until(a.h, () => a.h.beforeCursor().endsWith(want.slice(-Math.min(want.length, 20))));
        client.send({ type: 'tty.bytes', tty: a.tty, data: ch });
        times.push(await done);
      }
      return times;
    },
    async enter(prompt = /[$#] $/) {
      const a = active();
      if (!a) throw new Error('no active terminal');
      const before = a.h.beforeCursor();
      let left = false;
      const parsed = until(a.h, () => {
        const now = a.h.beforeCursor();
        if (now !== before) left = true;
        return left && prompt.test(now);
      });
      client.send({ type: 'tty.bytes', tty: a.tty, data: '\r' });
      const p = await parsed;
      const t1 = performance.now();
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      return { parsed: p, painted: p + (performance.now() - t1) };
    },
    advance: (ms) => client.send({ type: 'advance', ms }),
    speed: (n) => client.send({ type: 'speed', speed: n }),
  };
  (window as unknown as { __simlab: Probe }).__simlab = probe;
}

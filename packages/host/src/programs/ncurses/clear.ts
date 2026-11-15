// clear — clear the terminal screen. ncurses-bin 6.4 (6.4+20240113).
//   docs: clear(1) of ncurses 6.4
//   reference: ncurses 6.4.20240113 clear, captured 2026-11-16 (packages/host/transcripts/ncurses/clear.t;
//              the bytes of every entry below with `clear -T NAME | od -c` and `clear -x -T NAME | od -c`)
// clear writes the terminal's `clear` capability and, unless -x, the E3 (erase scrollback)
// capability. The terminal descriptions are the ones Ubuntu's ncurses-base package installs;
// another TERM gets the notice, since the simulator has no terminfo database to search.

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { getopt, type OptionSpec } from '../lib/getopt.ts';

/** The usage text, written to standard error. reference: `clear -z`, captured 2026-11-16 */
const USAGE = 'Usage: clear [options]\n\nOptions:\n  -T TERM     use this instead of $TERM\n  -V          print curses-version\n  -x          do not try to clear scrollback\n';

const H_2J = '\x1b[H\x1b[2J';
const H_J = '\x1b[H\x1b[J';
const E3 = '\x1b[3J';
const RIS = '\x1bc';

/** clear and E3 of each ncurses-base entry ('' when the entry has none); `pad` is a $<ms> delay. */
const TERMINFO: Record<string, { clear: string; e3: string; pad?: number }> = {
  Eterm: { clear: H_2J, e3: '' },
  'Eterm-color': { clear: H_2J, e3: '' },
  ansi: { clear: H_J, e3: '' },
  cons25: { clear: H_J, e3: '' },
  cygwin: { clear: H_J, e3: '' },
  dumb: { clear: '', e3: '' },
  hurd: { clear: RIS, e3: '' },
  linux: { clear: H_J, e3: E3 },
  mach: { clear: RIS, e3: '' },
  'mach-bold': { clear: RIS, e3: '' },
  'mach-color': { clear: RIS, e3: '' },
  'mach-gnu': { clear: RIS, e3: '' },
  'mach-gnu-color': { clear: RIS, e3: '' },
  pcansi: { clear: H_J, e3: '' },
  rxvt: { clear: H_2J, e3: '' },
  'rxvt-basic': { clear: H_2J, e3: '' },
  'rxvt-m': { clear: H_2J, e3: '' },
  'rxvt-unicode': { clear: H_2J, e3: '' },
  'rxvt-unicode-256color': { clear: H_2J, e3: '' },
  screen: { clear: H_J, e3: '' },
  'screen-256color': { clear: H_J, e3: '' },
  'screen-256color-bce': { clear: H_J, e3: '' },
  'screen-bce': { clear: H_J, e3: '' },
  'screen-s': { clear: H_J, e3: '' },
  'screen-w': { clear: H_J, e3: '' },
  'screen.xterm-256color': { clear: H_2J, e3: '' },
  sun: { clear: '\f', e3: '' },
  tmux: { clear: H_J, e3: E3 },
  'tmux-256color': { clear: H_J, e3: E3 },
  vt100: { clear: H_J, e3: '', pad: 50 },
  vt102: { clear: H_J, e3: '', pad: 50 },
  vt220: { clear: H_J, e3: '' },
  vt52: { clear: '\x1bH\x1bJ', e3: '' },
  wsvt25: { clear: H_J, e3: '' },
  wsvt25m: { clear: H_J, e3: '' },
  xterm: { clear: H_2J, e3: E3 },
  'xterm-256color': { clear: H_2J, e3: E3 },
  'xterm-color': { clear: H_2J, e3: '' },
  'xterm-debian': { clear: H_2J, e3: E3 },
  'xterm-mono': { clear: H_2J, e3: '' },
  'xterm-r5': { clear: H_2J, e3: '' },
  'xterm-r6': { clear: H_2J, e3: '' },
  'xterm-vt220': { clear: H_2J, e3: E3 },
  'xterm-xfree86': { clear: H_2J, e3: '' },
};

/**
 * A $<ms> delay is sent as NUL bytes at the terminal's speed: ms * baud / (9 * 1000), the 9 being
 * ncurses' bits per byte (213 NULs for vt100's $<50> at 38400 baud, captured 2026-11-16). The
 * speed comes from whichever of stdout, stderr and stdin is a terminal; simulated terminals run
 * at a pseudo-terminal's default, B38400. Without a terminal the speed is 0 and nothing is padded.
 */
function padding(p: ProcApi, ms: number): string {
  if (ms === 0 || ![1, 2, 0].some((fd) => p.isatty(fd))) return '';
  return '\0'.repeat(Math.floor((ms * 38400) / 9000));
}

const OPTIONS: OptionSpec[] = [{ short: 'T', arg: 'required' }, { short: 'V' }, { short: 'x' }];

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const r = getopt(p.argv.slice(1), { options: OPTIONS });
  if (!r.ok) {
    if ('error' in r) yield* p.write(2, `${p.name}: ${r.error}\n`);
    yield* p.write(2, USAGE);
    return 1;
  }
  // Operands are a usage error, without a message of their own.
  if (r.operands.length > 0) {
    yield* p.write(2, USAGE);
    return 1;
  }
  let term = p.env['TERM'];
  let scrollback = true;
  for (const o of r.options) {
    if (o.id === 'V') {
      yield* p.write(1, 'ncurses 6.4.20240113\n');
      return 0;
    }
    if (o.id === 'T') term = o.value;
    if (o.id === 'x') scrollback = false;
  }
  if (term === undefined) {
    yield* p.write(2, 'TERM environment variable not set.\n');
    return 1;
  }
  if (term === '') {
    yield* p.write(2, "'': unknown terminal type.\n");
    return 1;
  }
  const entry = Object.hasOwn(TERMINFO, term) ? TERMINFO[term] : undefined;
  if (!entry) return yield* p.unsupported({ kind: 'behavior', what: `the terminal type '${term}'`, hints: ['clear knows the terminal types of ncurses-base, such as xterm-256color, linux, screen, tmux and vt100'] });
  // A terminal without a clear capability: nothing is written and the status is 1.
  if (entry.clear === '') return 1;
  yield* p.write(1, entry.clear + padding(p, entry.pad ?? 0) + (scrollback ? entry.e3 : ''));
  return 0;
}

export const clearProgram: ProgramSpec = { name: 'clear', main };

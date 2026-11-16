// The core of `npm run lab`, without the real terminal: a content item's lab (learn/lab.ts), the
// terminal player on its session world, and the lab's own commands, which the learner reaches
// outside the simulated shell (lab.ts opens a prompt on Ctrl-]). Each command returns the text
// to show. Every attempt is recorded like a play session; a reset starts a new recording from the
// baseline (docs/ARCHITECTURE.md §2.8).

import { ENGINE_VERSION, hashNode, type Json, type Millis, type Ports, type SessionHeader, type SessionLog } from '@simlab/kernel';
import { KUBERNETES_TAG } from '@simlab/k8s';
import { competencyIds, findItem, loadPacks, skillIds } from '@simlab/content';
import { blocksText, buildBaseline, openLab, showSolution, staticProblems, variantOf, type Baseline, type Figure, type GradeReport, type Item, type Lab, type VariantBlock } from '@simlab/learn';
import { createPlayer, type Player, type PlayerIo } from './player.ts';
import { registry, UsageError } from './world.ts';

export interface LabSessionOptions {
  item: string;
  seed: number;
  startTime: Millis;
  cols: number;
  rows: number;
  speed?: number;
}

export interface LabSession {
  readonly lab: Lab;
  readonly player: Player;
  /** Runs one lab command; returns what to print. */
  command(line: string): string;
  /** The opening screen: title and ticket. */
  intro(): string;
  /** Recordings of the attempts so far, the current one finished now. */
  finish(): SessionLog[];
  readonly quit: boolean;
}

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const OFF = '\x1b[0m';

/** Light Markdown for a terminal: bold, code spans, nothing else. */
export function renderMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${OFF}`)
    .replace(/`([^`]+)`/g, `${CYAN}$1${OFF}`)
    .replace(/\n$/, '');
}

/**
 * Prose and figures for a terminal: a figure cannot be drawn here, so it shows its caption and its
 * alt text (docs/SCENARIO_FORMAT.md §11); the web app draws it.
 */
export function renderBlocks(blocks: readonly VariantBlock[]): string {
  const figure = (f: Figure): string => `${DIM}[Figure]${OFF} ${f.caption.trim()}\n${DIM}${f.alt.trim()}${OFF}`;
  return renderMarkdown(blocksText(blocks, figure));
}

export function loadItem(id: string): Item {
  const packs = loadPacks();
  const f = findItem(id, packs);
  if (!f) throw new UsageError(`no content item ${id}; known: ${packs.flatMap((p) => p.items.map((i) => i.fileId)).join(', ')}`);
  const problems = staticProblems(f.raw, { registry, skills: skillIds(packs), competencies: competencyIds(), fileId: f.fileId });
  if (problems.length > 0) throw new UsageError(`${id} is not a valid item (npm run content:check -- ${id}):\n  ${problems.join('\n  ')}`);
  return f.raw as unknown as Item;
}

/** The session header of an attempt: enough for `--replay` to rebuild the same world. */
export function labHeader(item: Item, seed: number, startTime: Millis, params: Record<string, Json>): SessionHeader {
  return { item: item.id, topology: item.world.topology, seed, params, startTime, engine: ENGINE_VERSION, versions: { kubernetes: KUBERNETES_TAG }, contentHash: hashNode(item) };
}

/** The baseline a header names, for replay. */
export function baselineFor(h: SessionHeader): Baseline {
  if (h.item === undefined) throw new UsageError('the recording names no content item');
  const item = loadItem(h.item);
  if (h.contentHash !== undefined && h.contentHash !== hashNode(item)) throw new UsageError(`${h.item} changed since this session was recorded`);
  return buildBaseline(variantOf(item, h.seed), registry, { startTime: h.startTime });
}

export function formatReport(r: GradeReport): string {
  const lines = r.checks.map((c) => {
    const mark = c.status === 'pass' ? `${GREEN}✓${OFF}` : c.status === 'fail' ? `${RED}✗${OFF}` : `${YELLOW}!${OFF}`;
    const head = `${mark} ${renderMarkdown(c.title)}${c.weight !== 1 ? `${DIM} (weight ${c.weight})${OFF}` : ''}`;
    if (c.status === 'pass') return head;
    const detail = c.status === 'error' ? `    could not be evaluated: ${c.error ?? ''}` : `    wanted: ${c.expected}\n    found:  ${c.observed}`;
    return `${head}\n${DIM}${detail}${OFF}`;
  });
  const pct = Math.round(r.score * 100);
  const verdict = r.passed ? `${GREEN}${BOLD}Solved.${OFF} Every check passes. Type ${CYAN}debrief${OFF} to read what was behind it.` : `${pct}% of the checks' weight passes. Keep going, or type ${CYAN}hint${OFF}.`;
  return `${lines.join('\n')}\n\n${verdict}`;
}

const HELP = `Lab commands (Ctrl-] opens this prompt; an empty line returns to the shell):
  ticket     show the ticket again
  hint       the next hint (hints lower the rating)
  check      grade the current state of the world
  debrief    the root cause and the mental model (asks first if the lab is not solved)
  solution   the reference solutions (asks first; viewing them is recorded)
  reset      start again from the initial state (asks first)
  quit       leave the lab
`;

export function createLabSession(opts: LabSessionOptions, io: PlayerIo): LabSession {
  const item = loadItem(opts.item);
  const variant = variantOf(item, opts.seed);
  const baseline = buildBaseline(variant, registry, { startTime: opts.startTime });
  const header = labHeader(item, opts.seed, opts.startTime, variant.params);
  const logs: SessionLog[] = [];
  let lab!: Lab;
  const newPlayer = (first: boolean): Player =>
    createPlayer(
      {
        topology: item.world.topology,
        seed: opts.seed,
        cols: opts.cols,
        rows: opts.rows,
        ...(opts.speed !== undefined ? { speed: opts.speed } : {}),
        world: {
          header,
          start: (ports: Ports) => {
            if (first) lab = openLab(baseline, registry, ports);
            else lab.reset(ports);
            return { kernel: lab.kernel, entry: baseline.entry };
          },
        },
      },
      io,
    );
  let player = newPlayer(true);
  let solved = false;
  let pending: string | undefined;
  let quit = false;

  /** True when the previous command was this one: the second time confirms. */
  const confirm = (name: string): boolean => {
    if (pending === name) {
      pending = undefined;
      return true;
    }
    pending = name;
    return false;
  };

  const command = (raw: string): string => {
    const line = raw.trim().toLowerCase();
    if (line !== pending) pending = undefined;
    switch (line) {
      case 'help':
      case '?':
        return HELP.replace(/\n$/, '');
      case 'ticket':
        return renderBlocks(lab.ticket);
      case 'hint': {
        const h = lab.nextHint();
        player.action('hint', h ? { index: h.index } : null);
        if (!h) return `No more hints: all ${lab.hintCount} are shown above. ${CYAN}solution${OFF} shows the reference solutions.`;
        return `${BOLD}Hint ${h.index + 1} of ${lab.hintCount}.${OFF} ${renderMarkdown(h.text)}`;
      }
      case 'check': {
        player.tick();
        const r = lab.check();
        player.action('check', { passed: r.passed, score: r.score });
        if (r.passed) solved = true;
        return formatReport(r);
      }
      case 'debrief':
        if (!solved && !confirm('debrief')) return `The lab is not solved yet, and the debrief gives the answer away. Type ${CYAN}debrief${OFF} again to read it anyway.`;
        player.action('debrief');
        return renderBlocks(lab.debrief);
      case 'solution':
      case 'solutions': {
        if (!confirm(line)) return `Viewing the reference solutions is recorded and lowers the rating. Type ${CYAN}${line}${OFF} again to see them.`;
        player.action('solution');
        return lab
          .solutions()
          .map((s, i) => `${BOLD}${s.name ?? `Solution ${i + 1}`}${OFF}\n${showSolution(s, registry)}`)
          .join('\n\n');
      }
      case 'reset': {
        if (!confirm('reset')) return `This throws away everything you changed and starts again from the initial state. Type ${CYAN}reset${OFF} again to do it.`;
        player.action('reset');
        logs.push(player.finish());
        player = newPlayer(false);
        return `The world is back where it started. The hints you saw stay seen.`;
      }
      case 'quit':
      case 'exit':
        quit = true;
        return '';
      default:
        return `Unknown lab command ${JSON.stringify(raw.trim())}. ${CYAN}help${OFF} lists them.`;
    }
  };

  return {
    get lab() {
      return lab;
    },
    get player() {
      return player;
    },
    command,
    intro: () => `${BOLD}${item.title}${OFF}  ${DIM}${item.id}, seed ${opts.seed}, about ${item.targetMinutes} min${OFF}\n\n${renderBlocks(lab.ticket)}\n\n${DIM}Ctrl-] opens the lab prompt: check, hint, ticket, debrief, solution, reset, quit.${OFF}`,
    finish() {
      return [...logs, player.finish()];
    },
    get quit() {
      return quit;
    },
  };
}

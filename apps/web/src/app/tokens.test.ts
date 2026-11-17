// The design tokens (docs/DESIGN.md): the stylesheets of rules (styles.css, and learning.css for
// the home screen and the content browser) hold no literal value, every variable in use is
// defined, and the pairs of text and surface in use meet WCAG AA (4.5:1) in both themes.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '.');
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const tokensCss = strip(readFileSync(join(dir, 'tokens.css'), 'utf8'));
/** The stylesheets that hold rules only. */
const RULES = ['styles.css', 'learning.css'] as const;
const rulesCss = RULES.map((f) => strip(readFileSync(join(dir, f), 'utf8')));
const stylesCss = rulesCss.join('\n');

interface Block {
  selector: string;
  vars: Map<string, string>;
}

/** The custom properties of each rule of tokens.css. */
function blocks(css: string): Block[] {
  const out: Block[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const vars = new Map<string, string>();
    for (const d of (m[2] as string).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(d[1] as string, (d[2] as string).trim());
    out.push({ selector: (m[1] as string).trim(), vars });
  }
  return out;
}

const all = blocks(tokensCss);
const THEMES = ['dark', 'light'] as const;

/** The tokens as the page resolves them for a theme: a theme's rule wins over the plain ones. */
function resolved(theme: 'dark' | 'light'): Map<string, string> {
  const vars = new Map<string, string>();
  const applies = (b: Block): boolean => {
    const t = /\[data-theme="(\w+)"\]/.exec(b.selector)?.[1];
    return t === undefined || t === theme;
  };
  for (const pass of [false, true]) for (const b of all) if (applies(b) && b.selector.includes('data-theme') === pass) for (const [k, v] of b.vars) vars.set(k, v);
  return vars;
}

type Rgba = [number, number, number, number];

/** Every color in a value: hex and rgb()/rgba(). A gradient gives each of its stops. */
function colors(value: string): Rgba[] {
  const out: Rgba[] = [];
  for (const m of value.matchAll(/#([0-9a-f]{6})\b|rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/gi)) {
    if (m[1]) out.push([parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1]);
    else out.push([Number(m[2]), Number(m[3]), Number(m[4]), m[5] === undefined ? 1 : Number(m[5])]);
  }
  return out;
}

const over = (top: Rgba, under: Rgba): Rgba => [0, 1, 2].map((i) => (top[i] as number) * top[3] + (under[i] as number) * (1 - top[3])).concat(1) as Rgba;
const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: Rgba): number => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('styles.css and learning.css hold rules, tokens.css holds values', () => {
  it('no literal color, size or duration in a rule', () => {
    const bad: string[] = [];
    for (const line of stylesCss.split('\n')) {
      const l = line.trim();
      // A media or container condition names a breakpoint, which cannot be a variable.
      if (l === '' || l.startsWith('@media') || l.startsWith('@container')) continue;
      if (/#[0-9a-f]{3,8}\b/i.test(l) || /\b(rgb|rgba|hsl|hsla)\(/.test(l) || /\d(px|rem|pt|ms|vh|vw)\b/.test(l) || /\b\d*\.?\d+s\b/.test(l)) bad.push(l);
    }
    expect(bad).toEqual([]);
  });

  it('every variable in use is defined: an unknown one fails silently in the browser', () => {
    const defined = new Set<string>([...all.flatMap((b) => [...b.vars.keys()]), ...[...stylesCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] as string)]);
    const sources = [stylesCss, tokensCss];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts')) sources.push(readFileSync(join(d, e.name), 'utf8'));
      }
    };
    walk(join(dir, '..'));
    const unknown = new Set<string>();
    for (const s of sources) for (const m of s.matchAll(/var\((--[\w-]+)/g)) if (!defined.has(m[1] as string)) unknown.add(m[1] as string);
    expect([...unknown]).toEqual([]);
  });

  it('the light theme redefines every color of the dark one, and nothing else', () => {
    const light = all.find((b) => b.selector.includes('data-theme="light"'));
    const dark = all.find((b) => b.vars.has('--bg') && !b.selector.includes('data-theme'));
    expect([...(light?.vars.keys() ?? [])].sort()).toEqual([...(dark?.vars.keys() ?? [])].filter((k) => k !== '--brand-bg' && k !== '--brand-ink').sort());
  });
});

/** Text on surface, as the stylesheet pairs them. A surface may be a stack: each layer over the one before. */
const PAIRS: [text: string, ...surface: string[]][] = [
  // Text on the panes, on what is raised inside them and on what floats above them.
  ...['--text', '--text-muted', '--text-faint', '--accent'].flatMap((t): [string, ...string[]][] => [
    [t, '--pane-bg'],
    [t, '--surface'],
    [t, '--surface-2'],
    [t, '--raised'],
    [t, '--overlay-bg'],
    [t, '--float-bg'],
  ]),
  ['--text', '--bg'],
  ['--text-muted', '--bg'],
  ['--text', '--surface-3'],
  ['--text-muted', '--surface-3'],
  ['--text', '--canvas-bg'],
  ['--text-muted', '--canvas-bg'],
  ['--text', '--term-bg'],
  ['--text-muted', '--term-bg'],
  ['--term-fg', '--term-bg'],
  ['--code-text', '--code-bg'],
  // Controls.
  ['--text', '--pane-bg', '--ctl-bg'],
  ['--text', '--pane-bg', '--ctl-bg-hover'],
  ['--accent-ink', '--accent-fill'],
  ['--accent-ink', '--accent-fill-hover'],
  ['--accent-ink', '--accent-solid'],
  ['--brand-ink', '--brand-bg'],
  ['--text', '--pane-bg', '--accent-soft'],
  ['--accent', '--pane-bg', '--accent-soft'],
  ['--tab-ink', '--pane-bg'],
  ['--tab-active-ink', '--pane-bg'],
  // States: as text on a pane and on a card, and on their own tint.
  ...['healthy', 'progressing', 'degraded', 'failed', 'unknown'].flatMap((s): [string, ...string[]][] => [
    [`--state-${s}`, '--pane-bg'],
    [`--state-${s}`, '--raised'],
    [`--state-${s}`, '--surface-2'],
    [`--state-${s}`, '--pane-bg', `--state-${s}-bg`],
    [`--state-${s}`, '--overlay-bg', `--state-${s}-bg`],
    ['--text', '--pane-bg', `--state-${s}-bg`],
  ]),
  // The learning screens (learning.css): a chosen filter in the browser over the workspace.
  ['--text', '--raised', '--accent-soft'],
  ['--text', '--bg', '--accent-soft'],
];

describe('text contrast meets WCAG AA', () => {
  for (const theme of THEMES)
    it(`${theme} theme`, () => {
      const vars = resolved(theme);
      const of = (name: string): Rgba[] => {
        const v = vars.get(name);
        if (v === undefined) throw new Error(`${name} is not defined`);
        const cs = colors(v);
        return v === 'transparent' ? [[0, 0, 0, 0]] : cs;
      };
      // Under everything lies the floor; a translucent surface is seen over what is below it.
      const floor = of('--bg')[0] as Rgba;
      const low: string[] = [];
      for (const [text, ...stack] of PAIRS) {
        let unders: Rgba[] = [floor];
        for (const layer of stack) unders = of(layer).flatMap((c) => unders.map((u) => over(c, u)));
        const worst = Math.min(...of(text).flatMap((t) => unders.map((u) => contrast(over(t, u), u))));
        if (worst < 4.5) low.push(`${text} on ${stack.join(' + ')}: ${worst.toFixed(2)}`);
      }
      expect(low).toEqual([]);
    });
});

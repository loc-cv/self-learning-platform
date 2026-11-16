import { describe, expect, test } from 'vitest';
import { formatSummary, groupGaps, parseJsonl, type GapLine, type HandledMark } from './summary.ts';

const gap = (key: string, at: string, commandLine: string, item?: string): GapLine => {
  const [kind, program, what] = key.split(':') as [string, string, string];
  return { kind, program, what, commandLine, key, at, ...(item !== undefined ? { context: { item } } : {}) };
};

const LOG: GapLine[] = [
  gap('command:less:this program', '2026-11-16T14:56:49.506Z', 'less'),
  gap('unknown-command:k:k', '2026-11-16T13:48:02.847Z', 'k get po', 'k8s.scheduling.pending-pods-01'),
  gap('unknown-command:k:k', '2026-11-16T15:00:16.143Z', 'k top nodes'),
  gap('unknown-command:k:k', '2026-11-17T08:00:00.000Z', 'k get po'),
];

describe('the gap summary', () => {
  test('groups by key, most frequent first, with distinct command lines and items', () => {
    const groups = groupGaps(LOG);
    expect(groups.map((g) => [g.key, g.count, g.open])).toEqual([
      ['unknown-command:k:k', 3, 3],
      ['command:less:this program', 1, 1],
    ]);
    expect(groups[0]).toMatchObject({ first: '2026-11-16T13:48:02.847Z', last: '2026-11-17T08:00:00.000Z', commandLines: ['k get po', 'k top nodes'], items: ['k8s.scheduling.pending-pods-01'] });
    expect(formatSummary(groups)).toBe(
      [
        '2 open gap groups, 4 records:',
        '   3  unknown-command:k:k',
        '      unknown-command · k · k · 2026-11-16 to 2026-11-17 · k8s.scheduling.pending-pods-01',
        '      $ k get po',
        '      $ k top nodes',
        '   1  command:less:this program',
        '      command · less · this program · 2026-11-16',
        '      $ less',
        '',
      ].join('\n'),
    );
  });

  test('a mark closes a group until a newer record reopens it; the latest mark counts', () => {
    const marks: HandledMark[] = [
      { key: 'command:less:this program', at: '2026-11-17T01:00:00.000Z', note: 'phase 22b' },
      { key: 'unknown-command:k:k', at: '2026-11-16T12:00:00.000Z', note: 'an older run' },
      { key: 'unknown-command:k:k', at: '2026-11-17T01:00:00.000Z', note: 'deferred to 22a' },
    ];
    const groups = groupGaps(LOG, marks);
    expect(groups.map((g) => [g.key, g.open])).toEqual([
      ['unknown-command:k:k', 1],
      ['command:less:this program', 0],
    ]);
    const text = formatSummary(groups);
    expect(text).toContain('   1  unknown-command:k:k (1 since it was handled: deferred to 22a)');
    expect(text).toContain('1 handled group not shown (--all).');
    expect(text).not.toContain('less');
    expect(formatSummary(groups, { all: true })).toContain('      handled 2026-11-17: phase 22b');
  });

  test('long pasted command lines are clipped to one line; an empty log says so', () => {
    const long = `for x in ${'word '.repeat(60)}\ndone`;
    const text = formatSummary(groupGaps([gap('syntax:bash:the "for" loop', '2026-11-16T15:10:13.838Z', long)]));
    const line = text.split('\n').find((l) => l.startsWith('      $ ')) as string;
    expect(line.length).toBe(108);
    expect(line.endsWith('…')).toBe(true);
    expect(formatSummary(groupGaps([]))).toBe('No open gap groups.\n');
  });

  test('a broken line names the file and the line', () => {
    expect(() => parseJsonl('{"a":1}\n\nnot json\n', 'data/gaps.jsonl')).toThrow('data/gaps.jsonl: line 3 is not JSON');
  });
});

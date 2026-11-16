// The transcript format's `@editor` directives (docs/TRANSCRIPTS.md): parsed onto the next step,
// kept verbatim by the capture tool's rewrite, and answering editors in order when run.

import { describe, expect, test } from 'vitest';
import { formatOutput, parseTranscript, replaceOutputs } from './format.ts';
import { runTranscript } from './runner.ts';

const TEXT = `# editors
@editor <<EOF
hello
$ not a command

EOF
$ vim notes.txt
$ cat notes.txt
hello
\\$ not a command

@editor :q!
@editor <<'END'
second
END
$ vim notes.txt
$ vim other.txt
$ cat notes.txt other.txt
hello
\\$ not a command

second
`;

describe('@editor', () => {
  test('answers attach to the next step, in order', () => {
    const t = parseTranscript(TEXT);
    expect(t.steps.map((s) => s.editors)).toEqual([['hello\n$ not a command\n\n'], undefined, [null, 'second\n'], undefined, undefined]);
    expect(t.steps[1]?.output).toBe('hello\n$ not a command\n\n');
  });

  test('an output line starting with @editor is escaped', () => {
    expect(formatOutput('@editor <<EOF\n', 0)).toEqual(['\\@editor <<EOF']);
    expect(parseTranscript('$ echo "@editor x"\n\\@editor x\n').steps[0]?.output).toBe('@editor x\n');
  });

  test('the capture rewrite keeps the directives', () => {
    const t = parseTranscript(TEXT);
    expect(replaceOutputs(TEXT, t.steps.filter((s) => s.kind === 'command'))).toBe(TEXT);
  });

  test('malformed directives are errors', () => {
    expect(() => parseTranscript('@editor nope\n$ true\n')).toThrow(/@editor <<WORD/);
    expect(() => parseTranscript('@editor <<EOF\nx\n$ true\n')).toThrow(/no closing EOF/);
    expect(() => parseTranscript('$ true\n@editor :q!\n')).toThrow(/after the last command/);
  });

  test('a run saves each answer in turn; :q! and an unanswered editor save nothing', () => {
    const t = parseTranscript(TEXT);
    const run = runTranscript(t);
    expect(run.results.map((r) => r.output)).toEqual(t.steps.map((s) => s.output));
    expect(run.results.map((r) => r.status)).toEqual([0, 0, 0, 0, 0]);
  });
});

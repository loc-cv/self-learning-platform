// Splits a case's command line into words the way bash would for the simple commands the cases
// use: quotes (and bash's `$'…'`), backslashes, and `$(...)` command substitution (whose output is supplied by the
// caller and split on whitespace, as an unquoted substitution is). Anything else of the shell
// language (pipes, lists, redirections, variables) makes the line "complex": the shim does not
// take it, and it runs only in the simulated shell.

export type Substitute = (command: string) => string | undefined;

export interface Words {
  words: string[];
}

/**
 * The words of `line`, or undefined when it uses shell syntax beyond quoting and `$(...)`, or a
 * substitution the caller cannot answer.
 */
export function splitWords(line: string, substitute?: Substitute): Words | undefined {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  let i = 0;
  const push = () => {
    if (inWord) words.push(cur);
    cur = '';
    inWord = false;
  };
  while (i < line.length) {
    const c = line[i] as string;
    if (c === ' ' || c === '\t' || c === '\n') {
      push();
      i++;
      continue;
    }
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return undefined;
      cur += line.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      inWord = true;
      for (;;) {
        if (i >= line.length) return undefined;
        const d = line[i] as string;
        if (d === '"') break;
        if (d === '$' || d === '`') return undefined;
        if (d === '\\' && i + 1 < line.length && '"\\$`\n'.includes(line[i + 1] as string)) {
          cur += line[i + 1];
          i += 2;
          continue;
        }
        cur += d;
        i++;
      }
      i++;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < line.length) cur += line[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (c === '$' && line[i + 1] === "'") {
      // ANSI-C quoting: bash's escapes (\n, \t, \r, \xHH, \uHHHH, \\, \').
      let j = i + 2;
      for (; j < line.length && line[j] !== "'"; j++) {
        const d = line[j] as string;
        if (d !== '\\') {
          cur += d;
          continue;
        }
        const e = line[++j] as string;
        const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"' };
        if (e in simple) cur += simple[e];
        else if (e === 'x' || e === 'u' || e === 'U') {
          const max = e === 'x' ? 2 : e === 'u' ? 4 : 8;
          const hex = /^[0-9a-fA-F]+/.exec(line.slice(j + 1, j + 1 + max))?.[0] ?? '';
          cur += String.fromCodePoint(parseInt(hex || '0', 16));
          j += hex.length;
        } else cur += `\\${e}`;
      }
      if (j >= line.length) return undefined;
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === '$' && line[i + 1] === '(') {
      // Find the matching parenthesis, outside quotes.
      let depth = 0;
      let j = i + 1;
      let q: string | undefined;
      for (; j < line.length; j++) {
        const d = line[j] as string;
        if (q) {
          if (d === q) q = undefined;
          continue;
        }
        if (d === "'" || d === '"') q = d;
        else if (d === '(') depth++;
        else if (d === ')' && --depth === 0) break;
      }
      if (j >= line.length || !substitute) return undefined;
      const out = substitute(line.slice(i + 2, j));
      if (out === undefined) return undefined;
      // Unquoted: field splitting of the output.
      const fields = out.split(/[ \t\n]+/).filter((f) => f !== '');
      if (fields.length > 0) {
        cur += fields[0];
        inWord = true;
        for (const f of fields.slice(1)) {
          push();
          cur = f;
          inWord = true;
        }
      }
      i = j + 1;
      continue;
    }
    if ('|&;<>()`$*?[{}#~'.includes(c)) {
      // `{` and `}` inside a word are literal to bash (jsonpath={.spec}); only a leading one matters.
      if ((c === '{' || c === '}' || c === '[' || c === '*' || c === '?') && inWord) {
        cur += c;
        i++;
        continue;
      }
      if ((c === '{' || c === '}') && !inWord && line[i + 1] !== ' ' && line[i + 1] !== undefined) {
        cur += c;
        inWord = true;
        i++;
        continue;
      }
      return undefined;
    }
    cur += c;
    inWord = true;
    i++;
  }
  push();
  return { words };
}

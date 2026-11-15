// Splitting terminal input into key sequences, the way readline reads them in emacs mode: a single
// character, ESC followed by one character (a Meta key), a CSI sequence (`ESC [` parameters and a
// final byte: arrows, Home, Delete) or an SS3 sequence (`ESC O` and one byte: arrows and Home/End in
// application cursor mode). An ESC at the end of the input waits for what follows: in emacs mode
// ESC is a prefix, not a command, so readline waits for the next key however long it takes.
//   docs: readline(3) "Key Bindings"; xterm ctlseqs "PC-Style Function Keys"

export interface KeySplit {
  keys: string[];
  /** An incomplete sequence at the end, kept for the next input. */
  rest: string;
}

export function splitKeys(data: string): KeySplit {
  const keys: string[] = [];
  const chars = Array.from(data);
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i] as string;
    if (ch !== '\x1b') {
      keys.push(ch);
      i++;
      continue;
    }
    const next = chars[i + 1];
    if (next === undefined) return { keys, rest: chars.slice(i).join('') };
    if (next === '[') {
      let j = i + 2;
      while (j < chars.length) {
        const c = (chars[j] as string).charCodeAt(0);
        if (c >= 0x40 && c <= 0x7e) break;
        j++;
      }
      if (j >= chars.length) return { keys, rest: chars.slice(i).join('') };
      keys.push(chars.slice(i, j + 1).join(''));
      i = j + 1;
      continue;
    }
    if (next === 'O') {
      const third = chars[i + 2];
      if (third === undefined) return { keys, rest: chars.slice(i).join('') };
      keys.push(`\x1bO${third}`);
      i += 3;
      continue;
    }
    keys.push(`\x1b${next}`);
    i += 2;
  }
  return { keys, rest: '' };
}

/** A key sequence in readline's notation (`\C-a`, `\e[A`), for messages. */
export function keyName(key: string): string {
  let out = '';
  for (const ch of key) {
    const c = ch.charCodeAt(0);
    if (ch === '\x1b') out += '\\e';
    else if (c === 0x7f) out += '\\C-?';
    else if (c < 0x20) out += `\\C-${String.fromCharCode(c + 0x60)}`;
    else out += ch;
  }
  return out;
}

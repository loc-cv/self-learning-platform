// Prompt strings: PS1 and PS2 are decoded (backslash escapes) and then expanded (parameter
// expansion and command substitution, as inside double quotes; `promptvars` is on by default).
//   docs: bash(1) 5.2 PROMPTING
//   reference: bash 5.2.21 on the workstation, 2026-11-16: `\s` of a login shell is `-bash`,
//              `\v` is `5.2`, `\V` is `5.2.21`, `\w` abbreviates $HOME to `~`
//
// The escapes `\[` and `\]` become readline's markers (\x01, \x02) around non-printing text when
// the line editor draws the prompt; without line editing they disappear, as in bash's
// decode_prompt_string with no_line_editing.

import type { Op } from '../proc/program.ts';
import { getMachine } from '../machine.ts';
import { strftime } from '../programs/coreutils/date-format.ts';
import { userByUid } from '../users.ts';
import { expandToString } from './expand.ts';
import { parseCommandLine } from './parse.ts';
import type { Shell } from './shell.ts';
import { getVar } from './state.ts';

const UTC = { abbrev: 'UTC', offset: 0 };

/** Backslash-quotes what an escape produced, so the expansion step leaves it alone. */
const protect = (s: string): string => s.replace(/([$`"\\])/g, '\\$1');

/** Decodes the backslash escapes of a prompt string. */
export function decodePrompt(sh: Shell, ps: string, editing: boolean): string {
  const { p, state } = sh;
  const home = getVar(state, 'HOME') ?? '';
  const pwd = getVar(state, 'PWD') ?? p.cwd;
  const tilde = (dir: string): string => (home !== '' && (dir === home || dir.startsWith(`${home}/`)) ? `~${dir.slice(home.length)}` : dir);
  const host = getMachine(p.ctx, p.machine).hostname;
  const time = (fmt: string): string => strftime(fmt, p.now, UTC);
  let out = '';
  for (let i = 0; i < ps.length; i++) {
    const ch = ps[i] as string;
    if (ch !== '\\' || i + 1 >= ps.length) {
      out += ch;
      continue;
    }
    const e = ps[++i] as string;
    switch (e) {
      case 'a':
        out += '\x07';
        break;
      case 'e':
        out += '\x1b';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 'd':
        out += time('%a %b %d');
        break;
      case 'D': {
        const close = ps.indexOf('}', i + 2);
        if (ps[i + 1] === '{' && close >= 0) {
          const fmt = ps.slice(i + 2, close);
          out += protect(time(fmt === '' ? '%X' : fmt));
          i = close;
        } else out += '\\D';
        break;
      }
      case 't':
        out += time('%H:%M:%S');
        break;
      case 'T':
        out += time('%I:%M:%S');
        break;
      case '@':
        out += time('%I:%M %p');
        break;
      case 'A':
        out += time('%H:%M');
        break;
      case 'h':
        out += protect(host.split('.')[0] as string);
        break;
      case 'H':
        out += protect(host);
        break;
      case 'u':
        out += protect(userByUid(p.ctx, p.machine, p.cred.uid)?.name ?? String(p.cred.uid));
        break;
      case 's': {
        const a0 = state.arg0;
        out += protect(a0.slice(a0.lastIndexOf('/') + 1));
        break;
      }
      case 'v':
        out += '5.2';
        break;
      case 'V':
        out += '5.2.21';
        break;
      case 'w':
        out += protect(tilde(pwd));
        break;
      case 'W': {
        const t = tilde(pwd);
        out += protect(t === '~' || t === '/' ? t : t.slice(t.lastIndexOf('/') + 1));
        break;
      }
      case 'j':
        out += '0';
        break;
      case 'l':
        out += protect(p.proc.tty ?? 'tty');
        break;
      case '!':
        out += String(state.history.length + 1);
        break;
      case '#':
        out += String(state.history.length + 1);
        break;
      case '$':
        out += p.cred.uid === 0 ? '#' : '\\$';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '[':
        if (editing) out += '\x01';
        break;
      case ']':
        if (editing) out += '\x02';
        break;
      default:
        if (/[0-7]/.test(e)) {
          const m = /^[0-7]{1,3}/.exec(ps.slice(i)) as RegExpExecArray;
          out += String.fromCharCode(parseInt(m[0], 8) & 0xff);
          i += m[0].length - 1;
        } else out += `\\${e}`;
    }
  }
  return out;
}

/** The prompt to show: decoded, then expanded as if inside double quotes. */
export function* expandPrompt(sh: Shell, ps: string, editing: boolean): Op<string> {
  const decoded = decodePrompt(sh, ps, editing);
  if (!/[$`]/.test(decoded)) return decoded.replace(/\\([$`"\\])/g, '$1');
  const src = `: "${decoded.replace(/"/g, '\\"')}"`;
  const r = parseCommandLine(src, 0, { aliases: {}, expandAliases: false, history: false, line: 1, final: true });
  const cmd = r.kind === 'ok' ? r.list?.items[0]?.first.cmds[0] : undefined;
  const word = cmd?.t === 'simple' ? cmd.words[1] : undefined;
  if (!word) return decoded;
  return yield* expandToString(word, sh.expandEnv);
}

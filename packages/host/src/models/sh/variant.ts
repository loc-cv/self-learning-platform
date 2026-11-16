// The texts that differ between the shells a container's `sh` can be: dash (Debian-based images'
// /bin/sh), BusyBox ash (busybox and Alpine images) and bash.
//
// reference: dash 0.5.12, BusyBox v1.36.1 (Ubuntu 1:1.36.1-6ubuntu3.1) and GNU bash 5.2.21 on the
// workstation, captured 2026-11-16 (fixtures/reference/container-shell/). BusyBox in the images is
// 1.36/1.37; these messages are the same in both (shell/ash.c).

export type ShellVariant = 'dash' | 'busybox' | 'bash';

export function shellVariant(variant: string): ShellVariant {
  return variant === 'busybox' || variant === 'bash' ? variant : 'dash';
}

/** A command that is neither a builtin nor a file on PATH (or a path that does not exist). */
export function notFound(v: ShellVariant, arg0: string, line: number, cmd: string): string {
  switch (v) {
    case 'dash':
      return `${arg0}: ${line}: ${cmd}: not found\n`;
    case 'busybox':
      return `${arg0}: ${cmd}: not found\n`;
    case 'bash':
      return cmd.includes('/') ? `${arg0}: line ${line}: ${cmd}: No such file or directory\n` : `${arg0}: line ${line}: ${cmd}: command not found\n`;
  }
}

/** `exec foo` when foo does not exist. */
export function execNotFound(v: ShellVariant, arg0: string, line: number, cmd: string): string {
  switch (v) {
    case 'dash':
      return `${arg0}: ${line}: exec: ${cmd}: not found\n`;
    case 'busybox':
      return `${arg0}: exec: line ${line}: ${cmd}: not found\n`;
    case 'bash':
      return `${arg0}: line ${line}: exec: ${cmd}: not found\n`;
  }
}

/** A syntax error. `token` is the unexpected token (`then`), or undefined at end of input; `expecting` the word dash and ash name. */
export function syntaxError(v: ShellVariant, arg0: string, line: number, token: string | undefined, expecting: string | undefined, source: string, text?: string): string {
  switch (v) {
    case 'dash': {
      const what = token === undefined ? 'end of file' : token === 'word' ? 'word' : `"${token}"`;
      return `${arg0}: ${line}: Syntax error: ${what} unexpected${expecting ? ` (expecting "${expecting}")` : ''}\n`;
    }
    case 'busybox': {
      const what = token === undefined ? 'end of file' : token === 'word' ? 'word' : `"${token}"`;
      return `${arg0}: syntax error: unexpected ${what}${expecting ? ` (expecting "${expecting}")` : ''}\n`;
    }
    case 'bash':
      if (token === undefined) return `${arg0}: -c: line ${line + 1}: syntax error: unexpected end of file\n`;
      return `${arg0}: -c: line ${line}: syntax error near unexpected token \`${token === 'word' ? (text ?? '') : token}'\n${arg0}: -c: line ${line}: \`${source.split('\n')[line - 1] ?? ''}'\n`;
  }
}

export function unterminatedQuote(v: ShellVariant, arg0: string, line: number, quote: string): string {
  switch (v) {
    case 'dash':
      return `${arg0}: ${line}: Syntax error: Unterminated quoted string\n`;
    case 'busybox':
      return `${arg0}: syntax error: unterminated quoted string\n`;
    case 'bash':
      return `${arg0}: -c: line ${line}: unexpected EOF while looking for matching \`${quote}'\n`;
  }
}

/** `exit x` and other builtins given a non-number. */
export function illegalNumber(v: ShellVariant, arg0: string, line: number, builtin: string, arg: string): string {
  switch (v) {
    case 'dash':
      return `${arg0}: ${line}: ${builtin}: Illegal number: ${arg}\n`;
    case 'busybox':
      return `${arg0}: ${builtin}: line ${line}: Illegal number: ${arg}\n`;
    case 'bash':
      return `${arg0}: line ${line}: ${builtin}: ${arg}: numeric argument required\n`;
  }
}

/** `[ 1 -lt x ]`. */
export function testBadNumber(v: ShellVariant, arg0: string, line: number, arg: string): string {
  switch (v) {
    case 'dash':
      return `${arg0}: ${line}: [: Illegal number: ${arg}\n`;
    case 'busybox':
      return `${arg0}: ${arg}: bad number\n`;
    case 'bash':
      return `${arg0}: line ${line}: [: ${arg}: integer expression expected\n`;
  }
}

/** `sh script` when the script does not exist. */
export function cannotOpen(v: ShellVariant, arg0: string, file: string): string {
  switch (v) {
    case 'dash':
      return `${arg0}: 0: cannot open ${file}: No such file\n`;
    case 'busybox':
      return `${arg0}: can't open '${file}': No such file or directory\n`;
    case 'bash':
      return `${arg0}: ${file}: No such file or directory\n`;
  }
}

/** Exit status for `sh missing-script`: dash and ash 2, bash 127. */
export function cannotOpenStatus(v: ShellVariant): number {
  return v === 'bash' ? 127 : 2;
}

/** An arithmetic expression ending in an operator: `$((1+))`. */
export function arithmeticError(v: ShellVariant, arg0: string, line: number, expr: string, op: string): string {
  switch (v) {
    case 'dash':
      return `${arg0}: ${line}: arithmetic expression: expecting primary: "${expr}"\n`;
    case 'busybox':
      return `${arg0}: arithmetic syntax error\n`;
    case 'bash':
      return `${arg0}: line ${line}: ${expr}: syntax error: operand expected (error token is "${op}")\n`;
  }
}

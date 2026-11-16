// How the overlay holds a file. vim keeps lines, not bytes: a file's final newline is not a line
// of its own, and a write ends every line with one ('fixendofline', on by default). CodeMirror
// holds text, so the final newline is taken off on open and put back on write.

/** The overlay's text for a file's content. */
export function toBuffer(content: string): string {
  return content.endsWith('\n') ? content.slice(0, -1) : content;
}

/** The file's content for the overlay's text, as vim writes it. */
export function toFile(buffer: string): string {
  return buffer === '' ? '' : `${buffer}\n`;
}

export interface ExCommand {
  name: string;
  bang: boolean;
  /** What followed the name and the bang, trimmed. */
  arg: string;
}

/** Splits what the vim emulation passes an Ex command (`params.argString`) into bang and argument. */
export function exArgs(name: string, argString: string | undefined): ExCommand {
  const s = argString ?? '';
  const bang = s.startsWith('!');
  return { name, bang, arg: (bang ? s.slice(1) : s).trim() };
}

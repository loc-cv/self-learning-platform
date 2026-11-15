// The shell's abstract syntax tree. Plain JSON data: a subshell receives the node it runs through
// its spawn data, and nothing here holds a function or a class instance.
// Grammar terms follow bash(1) SHELL GRAMMAR: simple commands, pipelines, lists, compound commands.

/** One piece of a word, before expansion. */
export type WordPart =
  /** Unquoted text: subject to field splitting only if it came from an expansion, and to globbing. */
  | { t: 'lit'; v: string }
  /** Text that is quoted: '…', $'…', a backslash escape, or literal text inside "…". */
  | { t: 'q'; v: string }
  /** "…": its parts are expanded but never split or globbed. */
  | { t: 'dq'; parts: WordPart[] }
  /** $name, ${name}, ${name<op>word}, ${#name}. */
  | { t: 'param'; name: string; op?: ParamOp; arg?: WordPart[]; length?: true; bad?: string }
  /** $(…) or `…`. Tilde prefixes stay in `lit` text: expansion recognizes them by position. */
  | { t: 'cmd'; body: List; src: string };

export type ParamOp = ':-' | '-' | ':=' | '=' | ':+' | '+' | ':?' | '?';

export interface Word {
  parts: WordPart[];
  /** The word as written, for messages. */
  text: string;
}

export type RedirOp = '>' | '>>' | '>|' | '<' | '<>' | '>&' | '<&' | '&>' | '&>>' | '<<' | '<<-' | '<<<';

export interface Redir {
  /** Explicit descriptor number written before the operator. */
  fd?: number;
  op: RedirOp;
  /** The target word; for a here-document, the delimiter word. */
  target: Word;
  /** Here-document body: expanded parts when the delimiter was unquoted, else literal text. */
  heredoc?: { parts: WordPart[]; quoted: boolean };
}

export interface Assign {
  name: string;
  value: Word;
  /** `name+=value` */
  append: boolean;
}

export interface SimpleCommand {
  t: 'simple';
  assigns: Assign[];
  words: Word[];
  redirs: Redir[];
  /** Line on which the command starts, for diagnostics. */
  line: number;
}

export interface Subshell {
  t: 'subshell';
  body: List;
  redirs: Redir[];
  line: number;
}

export interface Group {
  t: 'group';
  body: List;
  redirs: Redir[];
  line: number;
}

export type Command = SimpleCommand | Subshell | Group;

export interface Pipeline {
  t: 'pipeline';
  /** `! pipeline` */
  bang: boolean;
  cmds: Command[];
  /** For each `|` between cmds[i] and cmds[i+1]: true when it was `|&`. */
  stderr: boolean[];
}

export interface AndOr {
  t: 'andor';
  first: Pipeline;
  rest: { op: '&&' | '||'; pipeline: Pipeline }[];
}

export interface List {
  t: 'list';
  items: AndOr[];
}

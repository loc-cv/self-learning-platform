// The syntax tree of the container shell (a POSIX sh subset: dash, BusyBox ash and bash running
// `sh -c` scripts in containers). Plain data.

export type WordPart =
  | { t: 'lit'; v: string; q: boolean }
  | { t: 'param'; name: string; q: boolean }
  | { t: 'arith'; expr: string; q: boolean }
  | { t: 'cmdsub'; src: string; q: boolean };

export type Word = WordPart[];

export interface Redirect {
  fd: number;
  op: '>' | '>>' | '<' | '>&' | '<&';
  target: Word;
}

export interface SimpleCommand {
  kind: 'simple';
  assigns: { name: string; value: Word }[];
  words: Word[];
  redirects: Redirect[];
  line: number;
}

export interface Group {
  kind: 'group';
  subshell: boolean;
  body: List;
}

export interface Loop {
  kind: 'while';
  until: boolean;
  cond: List;
  body: List;
}

export interface ForLoop {
  kind: 'for';
  name: string;
  /** null: `for x; do` iterates over the positional parameters. */
  words: Word[] | null;
  body: List;
}

export interface IfCommand {
  kind: 'if';
  clauses: { cond: List; body: List }[];
  otherwise?: List;
}

export type Command = SimpleCommand | Group | Loop | ForLoop | IfCommand;

export interface Pipeline {
  negate: boolean;
  commands: Command[];
  line: number;
}

export interface AndOr {
  first: Pipeline;
  rest: { op: '&&' | '||'; pipeline: Pipeline }[];
}

export interface List {
  items: { andOr: AndOr; background: boolean }[];
}

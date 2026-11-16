// The libyaml event stream as go.yaml.in/yaml/v2 produces it (scannerc.go, parserc.go), the
// interface between the parser (parser.ts) and the composer (decode.ts).
//
// upstream: vendor/go.yaml.in/yaml/v2/yamlh.go yaml_mark_t, yaml_event_t, yaml_error_type_t

/** A position in the input; all three are 0-based, as in libyaml. `column` counts characters. */
export interface Mark {
  index: number;
  line: number;
  column: number;
}

export type ScalarStyle = 'plain' | 'single-quoted' | 'double-quoted' | 'literal' | 'folded';
export type CollectionStyle = 'block' | 'flow';

interface EventBase {
  start: Mark;
  end: Mark;
}

export type YamlEvent =
  | (EventBase & { type: 'stream-start' })
  | (EventBase & { type: 'stream-end' })
  | (EventBase & { type: 'document-start'; implicit: boolean })
  | (EventBase & { type: 'document-end'; implicit: boolean })
  | (EventBase & { type: 'alias'; anchor: string })
  | (EventBase & {
      type: 'scalar';
      /** Empty when the node has no anchor. */
      anchor: string;
      /** The resolved tag (`tag:yaml.org,2002:str` for `!!str`, `!local` stays), or '' when none. */
      tag: string;
      value: string;
      /** Plain scalar without a tag (or with the `!` non-specific tag handled as libyaml does). */
      implicit: boolean;
      quotedImplicit: boolean;
      style: ScalarStyle;
    })
  | (EventBase & { type: 'sequence-start'; anchor: string; tag: string; implicit: boolean; style: CollectionStyle })
  | (EventBase & { type: 'sequence-end' })
  | (EventBase & { type: 'mapping-start'; anchor: string; tag: string; implicit: boolean; style: CollectionStyle })
  | (EventBase & { type: 'mapping-end' });

export type YamlErrorKind = 'reader' | 'scanner' | 'parser';

/**
 * A reader, scanner or parser error with libyaml's fields (yaml_parser_t error, problem,
 * problem_mark, context, context_mark). decode.go turns it into `yaml: line N: <problem>`.
 */
export class YamlSyntaxError extends Error {
  readonly kind: YamlErrorKind;
  readonly problem: string;
  readonly problemMark: Mark;
  readonly context: string;
  readonly contextMark: Mark;

  constructor(kind: YamlErrorKind, problem: string, problemMark: Mark, context = '', contextMark: Mark = { index: 0, line: 0, column: 0 }) {
    super(problem);
    this.name = 'YamlSyntaxError';
    this.kind = kind;
    this.problem = problem;
    this.problemMark = problemMark;
    this.context = context;
    this.contextMark = contextMark;
  }
}

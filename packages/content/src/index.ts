// Content packs (YAML + Markdown) and topology templates. Data first; code here only reads them.
// Format in docs/SCENARIO_FORMAT.md §1. Parsing is pure; ./fs.ts reads the packs from disk with
// Node's file system, which is how the CLI, the tools and (phase 10) the server get them.

export const packageName = '@simlab/content';

export * from './parse.ts';
export * from './fs.ts';

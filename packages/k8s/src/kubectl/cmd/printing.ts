// The printers kubectl's commands use, gathered in one place: YAML and JSON (apimachinery/yaml),
// tables over server-side Tables (kubectl/printers).

import type { Json, JsonObject } from '../../apimachinery/json.ts';
import { createTablePrinter } from '../printers/tableprinter.ts';
import { yamlToJson } from '../../apimachinery/yaml/decode.ts';
import { marshalYaml } from '../../apimachinery/yaml/encode.ts';
import { printJson } from '../../apimachinery/yaml/jsonprint.ts';

export { YamlMarshalError } from '../../apimachinery/yaml/encode.ts';

export interface TablePrinterOptions {
  wide: boolean;
  noHeaders: boolean;
  showLabels: boolean;
  labelColumns: string[];
  withNamespace: boolean;
  withKind: boolean;
  groupKind: { group: string; kind: string };
}

export interface TablePrinter {
  add(table: JsonObject): void;
  flush(): string;
}

export function newTablePrinter(o: TablePrinterOptions): TablePrinter {
  const pr = createTablePrinter({
    noHeaders: o.noHeaders,
    withNamespace: o.withNamespace,
    withKind: o.withKind,
    wide: o.wide,
    showLabels: o.showLabels,
    kind: o.groupKind,
    columnLabels: o.labelColumns,
  });
  return { add: (t) => pr.add(t), flush: () => pr.flush() };
}

/** kubectl's JSONPrinter over an unstructured object: keys sorted, four-space indent. */
export function toJson(v: Json): string {
  return printJson(v, { sortKeys: true });
}

/** kubectl's YAMLPrinter: sigs.k8s.io/yaml.Marshal. Throws YamlMarshalError where kubectl fails. */
export function toYaml(v: Json): string {
  return marshalYaml(v);
}

/** sigs.k8s.io/yaml.YAMLToJSON, as clientcmd decodes a kubeconfig. */
export function parseYaml(text: string): { value: Json } | { error: string } | { unsupported: string } {
  const r = yamlToJson(text);
  if (r.ok) return { value: r.value };
  return 'error' in r ? { error: r.error } : { unsupported: r.unsupported };
}

// Label and field selectors of list and watch requests.
// upstream: staging/src/k8s.io/apiserver/pkg/endpoints/handlers/get.go (selectors parsed from the
// query; a parse or field label conversion error is a 400 with the parser's message),
// apiserver/pkg/registry/generic/matcher.go (SelectionPredicate: labels and GetAttrs fields).

import { fieldSelectorMatches, parseFieldSelector, transformFieldSelector, type FieldSelector } from '../apimachinery/fields.ts';
import { isObject, type JsonObject } from '../apimachinery/json.ts';
import { parseSelector, selectorMatches, type Selector } from '../apimachinery/labels.ts';
import { defaultFieldLabel, objectMetaFields } from '../registry/meta.ts';
import { registry } from '../discovery/registry.ts';
import { setWatchMatcher, type ApiObject } from './store.ts';
import { strategyFor } from './strategies.ts';
import type { Strategy } from './types.ts';

export function objectLabels(o: ApiObject): Record<string, string> {
  const m = o.metadata;
  return isObject(m) && isObject(m.labels) ? (m.labels as Record<string, string>) : {};
}

export interface CompiledSelectors {
  matches(o: ApiObject): boolean;
}

function fieldsOf(strategy: Strategy, o: ApiObject): Record<string, string> {
  if (strategy.fields) return strategy.fields(o);
  const res = registry().all.find((r) => r.group === strategy.group && r.resource === strategy.resource && r.subresource === undefined);
  return objectMetaFields(o, res?.namespaced ?? true);
}

export function compileSelectors(strategy: Strategy, label: string | undefined, field: string | undefined): CompiledSelectors | { error: string } {
  let ls: Selector | undefined;
  if (label !== undefined && label !== '') {
    const r = parseSelector(label);
    if ('error' in r) return { error: r.error };
    ls = r;
  }
  let fs: FieldSelector | undefined;
  if (field !== undefined && field !== '') {
    const r = parseFieldSelector(field);
    if ('error' in r) return { error: r.error };
    const convert = strategy.convertFieldLabel ?? defaultFieldLabel;
    const t = transformFieldSelector(r, (label2, value) => {
      const c = convert(label2, value);
      return 'error' in c ? c : { field: c.label, value: c.value };
    });
    if ('error' in t) return { error: t.error };
    fs = t;
  }
  return {
    matches: (o) => (ls === undefined || selectorMatches(ls, objectLabels(o))) && (fs === undefined || fieldSelectorMatches(fs, fieldsOf(strategy, o))),
  };
}

// Watches store their selector strings; matching recompiles them (a derived computation).
setWatchMatcher((sub, obj) => {
  if (!sub.labelSelector && !sub.fieldSelector) return true;
  const strategy = strategyFor(sub.group, sub.resource);
  if (!strategy) return false;
  const c = compileSelectors(strategy, sub.labelSelector, sub.fieldSelector);
  return 'error' in c ? false : c.matches(obj as JsonObject);
});

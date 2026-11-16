// The warnings of one request as the `Warning` headers carry them: each text once, and, past
// 4096 runes in all, every text cut to 256 runes and nothing added once the cut texts reach the
// limit again.
// upstream: staging/src/k8s.io/apiserver/pkg/endpoints/filters/warning.go recorder.AddWarning
// (truncateAtTotalRunes, truncateItemRunes)

const TRUNCATE_AT_TOTAL_RUNES = 4 * 1024;
const TRUNCATE_ITEM_RUNES = 256;

const runes = (s: string): number => [...s].length;
const cut = (s: string): string => (runes(s) > TRUNCATE_ITEM_RUNES ? [...s].slice(0, TRUNCATE_ITEM_RUNES).join('') : s);

/** The headers' texts for the warnings a request added, in order. */
export function recordWarnings(added: readonly string[]): string[] {
  const recorded = new Set<string>();
  const ordered: string[] = [];
  let headers: string[] = [];
  let written = 0;
  let truncating = false;
  for (const original of added) {
    if (original.length === 0) continue;
    if (written >= TRUNCATE_AT_TOTAL_RUNES && truncating) break;
    if (recorded.has(original)) continue;
    recorded.add(original);
    ordered.push(original);
    const text = truncating ? cut(original) : original;
    if (written + runes(text) <= TRUNCATE_AT_TOTAL_RUNES || truncating) {
      written += runes(text);
      headers.push(text);
      continue;
    }
    // Enable truncation and replay what was recorded, each text cut.
    truncating = true;
    headers = ordered.map(cut);
    written = headers.reduce((n, t) => n + runes(t), 0);
  }
  return headers;
}

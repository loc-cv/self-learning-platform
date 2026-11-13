# R2 — Vietnamese translation pass (repeatable)

**Needs** phase 11 · Follow the session protocol in `CLAUDE.md`.

**Scope for this run:** `<a pack, a track, or "outdated only"; blank means everything missing or outdated, most-used items first>`

## Goal

Give the learning content natural Vietnamese that a Vietnamese DevOps engineer would write to a
colleague. I read it side by side with the English, so it must carry the same meaning at the same
level of precision, without sounding translated.

## Read first

The translation rules in `docs/AUTHORING.md`. `npm run content:i18n` output. A few existing
sidecars, if any, to stay consistent. `docs/i18n-glossary.md` if it exists.

## Rules

- Translate meaning, not words. Restructure sentences where Vietnamese would say it differently.
- Keep in English: Kubernetes and Linux terms of art and resource names (Pod, Deployment, kubelet,
  rollout, taint, toleration, Service, endpoint, namespace, node), commands, flags, file paths,
  field names, code blocks, and any string that appears in terminal output. Don't add Vietnamese
  glosses for terms an engineer uses in English every day.
- Translate ordinary words fully; don't leave English filler in Vietnamese sentences.
- A ticket must stay as informative as the English and no more: don't add hints or lose constraints.
- Hints keep their ladder: the first rung stays a nudge in Vietnamese too.
- Keep Markdown structure, placeholders such as `{{ns}}`, and inline code identical.
- Use one consistent rendering for recurring non-technical terms. Maintain
  `docs/i18n-glossary.md` (term, chosen Vietnamese, note) and follow it.
- Consistent address and tone: direct, collegial, no stiff formal register.

## Do

1. List what is missing or outdated in scope. For outdated units, look at how the English changed
   and update the Vietnamese accordingly instead of retranslating from scratch.
2. Write the sidecars (`<id>.vi.yaml`) with the source hash for every unit.
3. Review pass: reread each Vietnamese unit alone, without the English, and fix anything that
   reads like a translation. Then compare with the English for meaning, constraints and placeholders.
4. Open a few items in the app in side-by-side view and confirm alignment and badges.

For a large scope, split the items among subagents with the rules and glossary, then do the review
pass yourself across all of them for consistency.

## Exit criteria

- `npm run content:i18n` reports nothing missing or outdated in scope.
- `npm run content:check` still passes (sidecars validate, placeholders intact).
- The glossary is updated with every term decision made in this run.
- `STATUS.md` records this run under R2 with its scope and counts.

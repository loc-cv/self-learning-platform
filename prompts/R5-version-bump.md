# R5 — Kubernetes version bump (repeatable)

**Needs** phase 07b; easier after phase 33 · Follow the session protocol in `CLAUDE.md`.

**Target version:** `<for example v1.38.x; blank means the version the exams currently use>`

## Goal

Move the simulator from the pinned Kubernetes version to a newer one without losing fidelity:
regenerate everything derived from upstream, find every behavior and output that changed, and
update content that depends on it.

## Read first

`docs/FIDELITY.md` (version pin and inventory). The latest `docs/update-reports/` entry if phase 33
exists; otherwise read the target release's notes on the web (urgent upgrade notes, API removals
and deprecations, kubectl and kubeadm changes, changed defaults) and write a short report first.
Confirm on the official exam pages which version the exams use.

## Do

1. **Decide the scope with me** if the target is more than one minor ahead, or if the report shows
   a change that affects many items.
2. **Bump the pin** in a branch. Re-fetch upstream sources and oracle binaries at the new tag.
3. **Regenerate derived data** into the new version's locations: OpenAPI schema data, the resource
   registry, the kubectl command and flag manifest, kubeadm manifests and package data, Gateway API
   CRDs if their supported version changed.
4. **Re-capture golden fixtures** with the oracle at the new version into the new version's folder.
   Diff old against new fixtures: that diff is the list of real output and behavior changes. Triage
   each one.
5. **Run the gate.** Fix what breaks by porting the upstream change, with its source cited. For
   each release-note item that touches simulated behavior, check the simulator explicitly even if
   no test failed, and add a test.
6. **Upgrade scenarios**: the kubeadm upgrade content needs a version pair. Keep data for the new
   minor and the one before it; retire older data.
7. **Content**: run `content:check`; fix items broken by removals, changed defaults or output
   changes; update version numbers that appear in tickets and debriefs through parameters, not by
   hand. Refresh the recorded curricula and `docs/CURRICULUM_MAP.md` if the curriculum changed;
   list new competencies that need content.
8. **Docs**: update the pin and date in `PLAN.md` §4.1, `docs/FIDELITY.md`, and the divergence
   register. Add a decision record entry.

Tier 2 fixtures (kind) can't be re-captured here; list them as stale for the new version until I
run the capture again.

## Exit criteria

- `npm run check` is green on the new version; the differential runner passes against the new
  fixtures or differences are in the divergence register.
- Every relevant release-note item is listed with what was done about it.
- No data for the old version remains outside what the upgrade scenarios need.
- `npm run fidelity:report` shows no unit silently carried over as `golden-verified` without a
  fixture of the new version.
- Your summary lists what changed for a learner: new or changed outputs, removed APIs, new content needed.

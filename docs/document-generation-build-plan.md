# Document Generation System — Build Plan

Companion to `document-generation-canon.md` (the spec — read that first).
This is the **phased build order**: what gets written, in what sequence,
and how each phase is verified before the next starts. Nothing here is
built yet as of 14 Aug 2026.

---

## Phase 0 — Dependency and library decisions (canon §10, items 1 & 3)

Before any code:

1. **docx builder**: `docx` (npm, dolanmiu) — pure JS, no native deps,
   actively maintained, builds OOXML from a declarative paragraph/run API.
   Chosen over templating-into-an-existing-file for the reason canon §7
   already gives (run-splitting corruption risk).
2. **PDF renderer**: `pdfkit` (npm) — pure JS, no native deps, no
   LibreOffice/Docker dependency (this box has neither reliably — see
   `D:\CLAUDE.md` §8's Docker-less-Windows note).
3. **Markdown renderer**: no library — the node tree is simple enough
   (headings/paragraphs/bullets/kv/tables) for direct string building,
   consistent with the rest of `scope` carrying minimal dependencies
   (`lib/chat-import.js`'s own stated design principle: "no dependency").
4. File layout (canon §10, item 3): **`scope/lib/generate/`**, not flat
   inside `lib/` — this is a multi-file addition (registry, builder, 3
   renderers, naming, style) and `lib/docs.js` (the existing read-only
   preview module) stays untouched and separate; generation is additive,
   not a rewrite.

Land as a single small commit: `package.json` deps + empty
`lib/generate/` directory with a one-line `README.md` pointing back to the
canon, so the next phase has a place to write into. Push per
[[isconl-branch-push-policy]] immediately, not batched.

---

## Phase 1 — Style spec + node-tree types (no archetypes yet)

- `scope/lib/generate/style.js` — the house-style token table (canon §2),
  as a plain exported object. No logic, just data, so it's trivially
  diffable if the look ever needs to change.
- `scope/lib/generate/node-tree.js` — small factory functions for the
  neutral node types canon §1/§3 define (`heading`, `paragraph`,
  `bullets`, `kv_list`, `checked_bullets`, `truth_check`). Each is a plain
  object shape, not a class — matches this repo's existing style
  (`lib/docs.js`, `lib/chat-import.js` are both plain functions/objects,
  no OOP).
- **Verify**: a unit test per node factory confirming the shape it emits.
  No rendering yet — this phase only fixes the vocabulary the rest of the
  system speaks.

---

## Phase 2 — `page-truth-brief` archetype + `doc-builder.js`

- `scope/lib/generate/archetypes/viva-valentia/page-truth-brief.js` —
  the schema from canon §3.1, as a validator: given a content object,
  returns `{valid, errors}` or throws with a specific missing-field
  message (canon §3, point 7).
- `scope/lib/generate/doc-builder.js` — `build(archetypeId, content) ->
  nodeTree`. Looks up the archetype by id in the (for now, single-entry)
  registry, validates content against it, merges content into the node
  tree using `style.js`. Resolves the `site_role`/`{sector_label}`
  substitution (canon §5) here — this is the exact fix for the
  `[sector-specific]` bug, so it needs its own test: a content object with
  `site_role: 'sister'` and a `sector_label` must produce a node tree with
  **zero** literal `{sector_label}`/`[sector-specific]` tokens remaining.
- **Verify**: build the node tree for both WAMCA (master) and APMA
  (sister) using content transcribed from the two dropped sample `.docx`
  files (§ below has the transcription task). Diff the resulting node
  tree by hand against the samples' actual section structure — this is
  the proof case canon §10 item 4 asks for, done at the content-tree level
  before any renderer exists.

---

## Phase 3 — Renderers, one at a time, each independently testable

Order matters: **markdown first** (simplest, no library, fastest feedback
loop on whether the node tree is even right), then **docx**, then **pdf**.

1. `scope/lib/generate/render-markdown.js` — walk the node tree, emit
   `#`/`##`/`-`/etc. Test: render the Phase 2 WAMCA tree, read the output
   by eye, confirm it says what the original `.docx` says.
2. `scope/lib/generate/render-docx.js` — walk the node tree, build with
   the `docx` library using `style.js` tokens for every heading/paragraph.
   Test: render, then run the existing `scope/lib/docs.js` `previewDocx()`
   function on the *output* — it's already a working docx-text-extractor
   in this repo, so it doubles as an independent verification path without
   writing a second XML reader. Confirm no `[sector-specific]`/
   `{sector_label}` tokens survive in the sister-site case.
3. `scope/lib/generate/render-pdf.js` — walk the node tree, `pdfkit` calls
   using the same style tokens. Test: render, confirm the file opens and
   page count/size are sane (no automated text-diff needed here — pdfkit's
   text extraction isn't worth building just to re-check what the other
   two renderers already verified).

**Verify at the end of Phase 3**: all three renderers, same content input
(WAMCA and APMA), produce visibly-the-same document in three formats. This
is the "byte-consistent across formats" claim from canon §7 — actually
checked, not assumed.

---

## Phase 4 — Naming + output location

- `scope/lib/generate/naming.js` — implements canon §5's general shape
  (`{primary_id}_{secondary_id}_v{major}_{minor}_{patch}_{YYYYMMDD}`) as a
  pure function taking the archetype's filename-field mapping + content,
  returning a filename. Unit test against Alex's own literal example
  (`wamca_members-member-services_v1_4_0_20260813`) as the golden case.
- `scope/lib/generate/output.js` — writes the four files (docx/md/pdf +
  `.content.json`) to `career/orgs/<org>/deliverables/<primary_id>/
  <secondary_id>/` (canon §6), creating the folder if absent. This is the
  first point in the pipeline that touches anything outside `scope`'s own
  tree, so it's the first place `getCareerContext`-style cross-engine
  wiring is needed — see `scope/lib/decisions.js` for the existing,
  working pattern (`getActiveOrgId`/`readCareerFile`/`writeCareerFile`
  injected fetchers into `circle`'s `career.js`); reuse that pattern
  rather than inventing a second way to reach `career/`.
- **Verify**: full pipeline, content JSON in, four files out, at the
  correct path, filename matching the golden case above.

---

## Phase 5 — Governance block (canon §9) — second archetype's proof case

Per canon §10 item 5, this is deliberately **not** bundled into
`page-truth-brief` (which doesn't need the full Document Control/Approval
apparatus). Instead:

- `scope/lib/generate/governance.js` — the shared `governance_block`
  component (document control table, approval table, operative clause,
  sensitive-content gate) as an optional mixin any archetype can declare.
- A second archetype, `scope/lib/generate/archetypes/viva-valentia/
  system-document.js`, modeled directly on Architect's own `Website Content
  Development System v1.0/v1.1` (the real evidence for the whole block) —
  this both exercises `governance_block` end-to-end and gives a second,
  structurally different archetype that proves the registry pattern
  generalizes (canon's own stated requirement — "not a page-brief
  generator").
- **Verify**: render `system-document` for a v1.0→v1.1 style bump, confirm
  the Document Control table grows a row and the operative clause/approval
  table render correctly; confirm a `sensitive: true` section without a
  `source_reference` field fails validation loudly (Phase 2's validator
  extended, not re-architected).
- **Verify Rule 1 integration**: confirm rendering a `governance: true`
  document appends one row to `career/orgs/<org>/decision_log.yaml` — via
  the same injected `writeCareerFile` pattern as Phase 4, calling into
  `scope/lib/decisions.js`'s existing `updateDecision()` rather than
  writing YAML surgery a second time.

---

## Phase 6 — Wire into `active_org` (closes the loop with the Corporate Engagements plan)

- `naming.js` and the archetype registry lookup both take the active
  org/engagement id as a parameter (never read it themselves) — the
  caller (an HTTP route, eventually) resolves it via `circle`'s
  `career.js` `load().activeOrg`, exactly how `decisions.js` already does.
- **Verify**: toggling `active_org` in `career/_active.yaml` to a
  non-Viva/prospective org and attempting to generate a `page-truth-brief`
  document fails cleanly (archetype not in that org's namespace) rather
  than silently producing a mis-labeled document — this is the concrete
  test of the Corporate Engagements plan's cascade table (§2 there) for
  `scope`'s row.

---

## What each phase produces to push

Every phase ends with a working, tested increment — per the (now standing)
push-every-update policy, each phase's commit goes to `dev`/`main`/
`staging` as its own commit with a message describing what it adds and
what still doesn't work yet, so a fresh AI session pulling mid-plan knows
exactly which phase it landed in.

## Still open (carried from canon §10)

- Output-root confirmation (item 2) — resolve before Phase 4 starts.
- Whether `system-document` (Phase 5) is really the right second archetype
  to build, versus something evidenced more recently — revisit once
  Phase 4 is done and there's a live pipeline to point at.

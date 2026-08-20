# Document Generation & Archetype System — Canon

Status: **design, not yet built**. This is the spec to review before any code lands.
Owner engine: `scope` (already owns tasks/deliverables/documents — see its
`package.json` description and `lib/docs.js`, which today only *previews*
documents read-only. This system adds the write/generate side.)

**Scope: this is a general document-generation engine, not a page-brief
generator, and not a Viva-only one.** `page-truth-brief` (§3.1) is the
*first* archetype, built out fully because it's the only document type with
two Alex-approved samples to reverse-engineer structure and style from. The
engine itself — archetype registry, content/style split, the three
renderers, the naming-profile system — is generic across **every document
type and every job**: meeting agendas, feedback/review docs, proposals,
reports, whatever a future engagement or personal project needs. Adding a
document type means adding one archetype file to the registry — never
touching `doc-builder.js` or a renderer, and never assuming "site + page" is
what identifies a document (see §5 — that's one archetype's naming shape,
not the system's).

**Archetypes are linked to a project or corporate engagement, not global.**
Per [[document-archetype-system]] and the Corporate Engagements plan
(`hub/docs/corporate-engagements-plan.md`), each engagement/project owns
which archetypes and naming profile apply to it — `page-truth-brief` is
scoped to Viva's site-content work specifically, not offered as a default
for an unrelated project. Concretely, the archetype registry is
namespaced: `scope/lib/generate/archetypes/<engagement-or-project-id>/*.js`
(or a shared `_common/` bucket for archetypes genuinely reusable across
engagements, e.g. a generic "meeting notes" shape). Which namespace(s) are
active follows the same `active_org`/active-project pointer the Corporate
Engagements plan already defines — never a hardcoded list in the generator.

---

## 0. The problem this replaces

Two documents dropped 14 Aug 2026 (`apma_..._v1_2_0_...docx`,
`wamca_..._v1_4_0_...docx`) are hand-edited instances of the same brief. The
APMA copy still has a literal, unresolved `[sector-specific]` token in its
body — proof the hand process drops things. Producing these by asking an AI
to write a fresh `.docx` each time is also non-deterministic: same inputs,
different phrasing/formatting on every run, and every run spends tokens on
work that is actually just data-filling.

**Design principle:** styling and structure are code, not model output. An
LLM (via `spark`, when wired) may be asked to draft the *prose* that fills
one field — a paragraph of "what we can say here" — but it never decides
headings, fonts, colors, spacing, section order, or the filename. That
split is what makes output consistent and keeps AI calls (and their token
cost) to the minimum: one short, scoped prompt per field that needs drafting,
never a whole-document generation or reformatting pass.

---

## 1. Architecture: content vs. style vs. render

Three things, kept strictly separate, matching how the two sample documents
actually vary (data) versus what never changes between them (structure/style):

```
   ARCHETYPE                    CONTENT                     STYLE
   (structure, per doc type)    (data, per instance)        (house look, shared)
        │                            │                            │
        └──────────────┬─────────────┴──────────────┬─────────────┘
                        ▼                             ▼
                  doc-builder.js              (validates content
                  (assembles a               against archetype's
              format-neutral node tree)         field schema)
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
     docx renderer   md renderer   pdf renderer
```

- **Archetype** = a document *type's* fixed shape: which sections exist, in
  what order, what each one's field type is (heading / paragraph / bullet
  list / table / key-value line), and which fields feed the filename.
- **Content** = one JSON object per generated document — the actual data
  (site name, dates, bullet text, version). This is the thing spark or a
  human fills in. It is saved alongside the rendered files as the source of
  truth, so **editing a document means editing this JSON and re-rendering**,
  never hand-editing the `.docx` and never re-asking an AI to regenerate
  prose that didn't change.
- **Style** = the shared house look (fonts, sizes, colors, spacing, margins,
  border rules). One style object, reused by every archetype and every
  renderer, so a WAMCA brief and a future meeting-agenda archetype render
  with the same visual DNA.

`doc-builder.js` merges content into an archetype's shape, producing one
neutral node tree (`{type: 'heading', level: 1, text, style}`,
`{type: 'bullets', items}`, `{type: 'kv', label, value}`, etc.). Each
renderer walks that same tree — nothing format-specific leaks upstream of
the renderer boundary. **No AI calls happen anywhere in this render
pipeline** (build → node tree → renderer) — that stays absolute, and
`BA26081812` doesn't touch it. What §8 below now describes (revised
20 Aug 2026, `BA26081812`) is AI proposing FIELD VALUES *before* content
ever reaches this pipeline — the render path itself remains exactly as
deterministic as this section says.

---

## 2. Style spec — extracted from Alex-approved output, not invented

The two sample `.docx` files are the only Alex-reviewed, standing artifacts
we have, so the house style is **reverse-engineered from their actual
`styles.xml`**, not guessed:

| Token | Value | Used for |
|---|---|---|
| `font.family` | Calibri | every text element |
| `font.body.size` | 9pt | body paragraphs, bullets |
| `font.h1.size` | 15pt, bold, color `#1F3864` (dark navy) | document title |
| `font.h2.size` | 8.5pt, bold, color `#2F5496` (medium blue), bottom border `#B4C6E7` 0.5pt | section headings (`THE PAGE`, numbered sections) |
| `font.meta.size` | 7.5pt, color `#808080` (gray) | the meta line under the title, footer notes |
| `page.size` | A4 (11906×16838 twips) | — |
| `page.margins` | top/bottom 0.51in, left/right 0.63in, header/footer 0.5in | — |
| `spacing.body` | 70 twips after, 1.14 line | — |
| `spacing.h2` | 140 before / 40 after | — |

This table is the **single style object** every archetype and every renderer
reads from — never hard-coded per-archetype or per-renderer. Changing the
house look means editing this table once.

**Font selection rule:** one family (Calibri) for the whole system — no
per-archetype font choice. Weight/size/color encode hierarchy (h1 > h2 >
body > meta), not typeface changes. This mirrors what Alex already approved
and avoids a stray archetype inventing its own look.

---

## 3. What every archetype must define

Every archetype, regardless of document type, declares:

1. **`id`** — kebab-case, stable (e.g. `page-truth-brief`). Used in the
   filename and as the schema/version key.
2. **`title`** — human name shown in tooling ("Sub-page Truth Brief").
3. **Header block** — always present, same shape across all archetypes:
   - `headline` — required, format-specific per archetype (for
     `page-truth-brief`: `{site_name} — {page_name}`, per Alex's 13 Aug
     correction away from the generic "Sub-page summary box" title).
   - `meta_line` — doc-type label + up to 4 key facts, rendered in the
     `meta` style, e.g. `{type_label} | {url} | {date} | v{version} | {author}`.
     `type_label` and `author` are archetype-level constants
     (`author` defaults to `content.author`); the rest come from content.
4. **Body sections** — an ordered list of `{key, heading, field_type}`.
   `field_type` is one of `paragraph`, `paragraphs` (list of paragraphs),
   `bullets`, `checked_bullets` (bullet + citation, for "must not say"
   items), `kv_list` (label/value pairs like "Site." / "Menu and sub-page.").
5. **Footer note** (optional) — a `meta`-styled closing paragraph, often
   variant-dependent (see §5, master vs. sister-site).
6. **Filename field mapping** — which content fields populate the naming
   convention's slots (§6). Declared once per archetype so naming is never
   improvised per document.
7. **Required vs. optional fields**, with the schema doubling as the
   validator `doc-builder.js` runs before rendering — a document that is
   missing a required field fails loudly at build time instead of shipping
   a page with a hole in it.

### 3.0 The fractal section shape (general principle, added 20 Aug 2026)

Per Architect's own instruction: **every document in this system, and every
major section within a document, follows the same three-part shape** —
a short identifying header, a body carrying the actual payload, and a
closing footer of secondary metadata. This is not just the top-level
document shape (§3, fields 3–5: header block / body sections / footer
note) — it recurses one level into the body itself, so a document reads
as the same pattern at two scales, not a top-level convention with an
unrelated shape inside it:

```
DOCUMENT
├── header    — title + document control/metadata (who/what/when/version)
├── body      — the message payload, itself shaped fractally in three parts:
│   ├── signal      (header-of-the-body: one-line status/orientation)
│   ├── substance    (body-of-the-body: the actual payload — what happened,
│   │                 what was decided, what's at risk)
│   └── trajectory  (footer-of-the-body: forward-looking — what's next)
└── footer    — secondary/closing metadata (distribution, links, cadence)
```

This is a **naming/shape convention for archetype authors, not a new
node type** — `signal`/`substance`/`trajectory` are just section `key`s
like any other (§3, field 4), rendered with the same `field_type`
vocabulary already defined (`kv_list`, `bullets`, `paragraphs`, etc.).
Any archetype MAY use this three-part body shape when its content
genuinely separates into "orientation / substance / what's next" (true
of most status-style documents); a document whose content doesn't
separate that way (e.g. `page-truth-brief`'s numbered content sections,
§3.1) is not required to force it. `weekly-status-brief` (§3.2) is the
first archetype built around this shape deliberately, as the concrete
proof case.

### 3.1 First archetype: `page-truth-brief`

Directly evidenced by the two sample documents plus Alex's corrections in
the WhatsApp chat (13–14 Aug 2026). Internal-only — never published on the
live page itself (Alex, 13 Aug: "for ourselves, not putting it on the page").

```yaml
id: page-truth-brief
title: Sub-page Truth Brief
header:
  headline: "{site_name} — {page_name}"
  meta_line: "Sub-page summary box | {url} | {date_readable} | v{version} | {author}"
sections:
  - key: the_page
    heading: null            # unheaded key-value block, directly under meta
    field_type: kv_list
    fields: [site, menu_subpage]     # "Alongside it." and "Layout." REMOVED
                                       # per Alex 14 Aug — dev-only, not needed
                                       # for management review
  - key: focus
    heading: "1.   FOCUS, AND WHAT KEEPS IT SEPARATE FROM ITS NEIGHBOURS"
    field_type: paragraphs
  - key: can_say
    heading: "2.   WHAT WE CAN SAY HERE"
    field_type: bullets
  - key: truth_check
    heading: "3.   CHECKED AGAINST THE TRUTH DOCUMENT"
    field_type: truth_check    # {sections_used: [str], must_not_say: [{claim, reason}]}
footer_note: variant_by_site_role   # see §5
filename_fields: [site_id, page_slug, version, date]
```

Future archetypes (meeting agenda, feedback/review doc — both seen as raw
`.doc` attachments in the same chat but not yet specced to this level of
evidence) get added the same way: a new file in the archetype registry, no
change to `doc-builder.js` or the renderers.

### 3.2 Second archetype: `weekly-status-brief`

Requested by Architect 20 Aug 2026: a single-page, weekly (Friday) status
brief for **every active team, project, supervisor, or initiative** —
not Viva-specific, and explicitly meant to apply equally to companies
Architect runs himself in future, not only engagements he works within. This
is the reason it lives in the registry's shared `_common/` bucket (§0),
not under `viva-valentia/` — the *first* archetype genuinely designed
generic from day one, rather than generalized later.

```yaml
id: weekly-status-brief
title: Weekly Status Brief
namespace: _common          # reusable across every engagement/project/company,
                             # never scoped to one org — see rationale above
header:
  headline: "{subject_name} — Week of {week_ending_readable}"
  meta_line: "{subject_type_label} | {subject_id} | {week_ending_readable} | v{major}.{minor}.{patch} | {author}"
sections:
  # --- fractal body, per §3.0 ---
  - key: signal                              # header-of-the-body
    heading: null                            # unheaded, sits directly under meta_line
    field_type: kv_list
    fields: [status, one_line_summary, headline_metric]
             # status: red/amber/green or content-defined enum, archetype validates
  - key: substance                           # body-of-the-body — the payload
    heading: "THIS WEEK"
    field_type: bullets
    subfields:                               # three payload lanes, all optional
      - key: highlights        field_type: bullets
      - key: decisions         field_type: bullets
      - key: risks_blockers    field_type: checked_bullets   # bullet + source,
                                                               # reuses page-truth-brief's type
  - key: trajectory                          # footer-of-the-body — forward-looking
    heading: "NEXT"
    field_type: kv_list
    fields: [next_actions, asks_of_sconl, next_brief_date]
footer_note: standing_metadata               # distribution list, confidentiality,
                                              # link to full detail/dashboard if one exists
filename_fields: [subject_type, subject_id]
governance: false            # opt-in per instance, not the archetype default — a
                              # weekly cadence is high-frequency/low-ceremony by design;
                              # an individual brief can still set governance: true
                              # per §9 if a specific week's content warrants it
cadence: weekly              # NEW field, first archetype to declare one — see below
```

**Naming profile**, following §5's fixed shape (two id slots, version,
date):

```
{subject_type}_{subject_id}_v{major}_{minor}_{patch}_{YYYYMMDD}.{ext}
```

`subject_type` (`team`, `project`, `supervisor`, `initiative`, `company`)
is the first slot rather than a fixed constant, because unlike
`page-truth-brief` (where "site" is the only kind of thing being
documented), a weekly brief's *subject* can be several different kinds
of thing sharing the drive's ID-slug space — the type slot disambiguates
`viva-valentia` the org from a same-named project or supervisor, and
keeps the filename mechanically sortable by kind before falling back to
name, matching Alex's own "identifying slots first, version, date last"
rule (§5) without inventing a new shape for this archetype.

**`cadence: weekly` is a new archetype-level field, not present in
`page-truth-brief`** — it does not change how `doc-builder.js` or a
renderer works (rendering is always triggered by a content JSON existing
and being handed to the builder, exactly as before); it is metadata a
*scheduler* reads to decide when to prompt for/assemble that content in
the first place. **The scheduler itself is not designed here** — see
`PA26082012` in `plan.md` for the open scoping questions this raises
(where the list of "active subjects" is enumerated from across
`career/orgs/`, `scope`'s projects, and `circle`'s people/supervisor
records; where a company Architect owns himself would live, since
`career/orgs/` per [[viva-is-one-org-instance-not-the-whole-career]] is
currently modeled as engagements-he-works-within, not
ventures-he-owns; and what actually fires the Friday trigger — a
`CronCreate` scheduled agent, a `pulse` calendar recurrence, or a
`scope` recurring-task row).

**Output location** mirrors §6's shape but is not yet confirmed the same
way §6 was for `page-truth-brief` — proposed
`career/orgs/<org_id>/weekly-briefs/<subject_type>/<subject_id>/` for
anything engagement-scoped, but a **first-party company Architect owns
himself has no home in `career/orgs/` at all today** (that tree models
engagements, not ownership) — this is one of `PA26082012`'s open
questions, not resolved here.

---

## 4. Variant handling — master vs. sister-site, without hardcoding org/site

Per [[viva-is-one-org-instance-not-the-whole-career]]: nothing in shared
code may hardcode `wamca`, `apma`, or `viva`. The `page-truth-brief`
archetype supports this by taking a **`site_role`** content field
(`"master"` or `"sister"`) rather than special-casing site IDs:

- `site_role: master` → body text is written plainly (no placeholder), and
  `footer_note` uses the master-site wording ("On the sister sites two
  lines change... Everything else is identical across all ten sites.").
- `site_role: sister` → body text carries the literal `{sector_label}`
  token exactly where Alex specified (never left as a dangling
  `[sector-specific]` string — `doc-builder.js` resolves it against the
  content's `sector_label` field at build time, which is the concrete fix
  for the bug already present in the APMA sample), and `footer_note` uses
  the sister-site wording naming the resolved sector.

All site-specific facts (name, URL, sector label) live in **content** (one
row per site in a data table), never in the archetype or in code.

---

## 5. File naming — a general shape, not a site/page scheme

Found in the dropped WhatsApp chat, 14 Aug 2026, 9:41–9:47am. Alex's own
words, given as a correction after seeing the files misnamed:

> "In naming the files, move site and subpage name first, date last, remove
> summary content as it's should be a folder name instead. Like this:
> `wamca_members-member-services_v1_4_0_20260813`"
> — Alex, confirmed by Architect ("I can have this as the consistent file naming
> convention, right?") — Alex: "sure, name them all in this order"

That instruction was about site/page documents specifically, but the
**shape** it describes generalizes cleanly and is what every naming profile
in this system follows, regardless of document type or which engagement/
project owns it:

```
{primary_id}_{secondary_id}_v{major}_{minor}_{patch}_{YYYYMMDD}.{ext}
```

- Two **identifying slots first** (whatever actually identifies *this*
  document type — see below), **version**, **date last**.
- No free-text descriptor/summary in the filename ever — "it should be a
  folder name instead." The containing folder carries that context.
- Each archetype declares what its two identifying slots *mean* (§3, field
  6, "filename field mapping") — the shape is fixed, the semantics are not:

| Archetype | `primary_id` | `secondary_id` |
|---|---|---|
| `page-truth-brief` (site content) | `site_id` (`wamca`, `apma`, …) | `page_slug` (`members-member-services`) |
| a future proposal/report archetype | `client_id` or `project_id` | `deliverable_slug` |
| a future meeting-notes archetype | `engagement_id` | `meeting_slug` |

Nothing in `doc-builder.js` or the naming code itself knows "site" or
"page" — it only knows "an archetype supplies two id slots, a version, and
a date." That keeps the file-naming system agnostic to document and job
type, per Architect's correction, while still satisfying Alex's literal
directive for the archetype it came from.

**This supersedes the general personal convention
([[file-naming-convention]] — date-first, `YYYYMMDD_class_domain_...`) for
any document produced *for* an engagement/project that has adopted this
naming shape.** The two are different conventions for different contexts,
not a conflict — Architect's own personal files stay date-first; work product
generated through this system follows the shape above. `doc-builder.js`
picks the convention by the active engagement/project (per the Corporate
Engagements plan's `active_org`/active-project pointer,
`hub/docs/corporate-engagements-plan.md`), so this is a pluggable naming
*profile* selected per engagement, never a hardcoded branch.

**`page-truth-brief`'s naming profile** (the one concrete instance
evidenced so far):

```
{site_id}_{page_slug}_v{major}_{minor}_{patch}_{YYYYMMDD}.{ext}
```

- `site_id` — lowercase, the real site code (`wamca`, `apma`, …) — Alex
  flagged `wabba` as a wrong site id in the same message, so this is
  validated against the known site table, not typed free-hand.
- `page_slug` — hyphenated path segments, e.g. `members-member-services`
  for `/members/member-services/`, `members` alone for the `/members/`
  menu page itself (Alex: "we also have a site for `/members/` when you
  click directly on the members main menu" — the slug scheme must cover
  both a menu page and its sub-pages without collision).
  **Note:** the two dropped samples were actually saved as
  `apma_members_member-services_...` (underscore between `members` and
  `member-services`) — one underscore short of Alex's own literal example
  (`members-member-services`, hyphenated). This is exactly the kind of slip
  the naming profile exists to stop; the generator emits the hyphenated
  form going forward, matching Alex's example precisely, not the
  as-typed sample.
- No date prefix, no `class`/`domain`/`descriptor` segments, and no
  free-text summary in the filename — "it should be a folder name instead."
  The containing folder (e.g. `.../wamca/members-member-services/`) carries
  that context; the file name stays purely mechanical.
- Version and date stay at the tail, in that order.

---

## 6. Where output lives

Per [[viva-is-one-org-instance-not-the-whole-career]], generated documents
are Viva work product and belong under the existing org-neutral container,
never a Viva-specific top-level path:

```
career/orgs/viva-valentia/deliverables/<site_id>/<page_slug>/
    wamca_members-member-services_v1_4_0_20260813.docx
    wamca_members-member-services_v1_4_0_20260813.md
    wamca_members-member-services_v1_4_0_20260813.pdf
    wamca_members-member-services_v1_4_0_20260813.content.json   <- source of truth
```

The `.content.json` is what gets edited and re-rendered; the three output
files are always derived, never hand-edited. Per `D:\CLAUDE.md` §2, the
`.docx` here is the deliverable of record (OneDrive-synced); a Google Docs
copy is produced only when live supervisor collaboration is needed, by
uploading this `.docx` through the browser as `sconl.vv@gmail.com` — never
generated directly against the Google Docs API, keeping the whole pipeline
auth-free and offline-reliable.

---

## 7. Renderers — one content tree, three outputs, zero AI calls

- **docx** — built programmatically with a JS OOXML-builder library (not
  regex/template substitution into a hand-edited `.docx`, which is exactly
  how the `[sector-specific]` bug happened — Word silently splits a
  sentence across multiple `<w:r>` runs, and blind text-replace on the raw
  XML can miss or corrupt a split token). Building the tree fresh from the
  style spec guarantees every heading/paragraph gets the right style
  every time.
- **markdown** — direct serialization of the same node tree (`#`/`##` for
  h1/h2, `-` for bullets, etc.) — no docx round-trip, so it can't inherit
  docx-specific bugs.
- **pdf** — rendered directly from the same node tree + style spec (a
  pure-JS PDF library, not "convert the docx" — this repo runs on a
  Docker-less Windows box with no guaranteed LibreOffice/Word install to
  shell out to, so PDF must not depend on one).

All three read the *same* content + style input, so a WAMCA brief looks
like a WAMCA brief regardless of which format someone opens.

---

## 8. Editing, and where AI actually enters (revised 20 Aug 2026, `BA26081812`)

"Document editing" in this system means editing the `.content.json` field
(or one section of it) and re-running the renderer — not asking an AI to
reproduce the whole document with one line changed. Three kinds of edit
now, not two — the third is genuinely new capability, not a rewording of
the other two:

- **Mechanical edit** (fix a date, a URL, a version bump, swap a bullet's
  wording that Architect already knows) — direct JSON edit, re-render. Zero AI
  calls, zero tokens.
- **Drafting edit, per field** (write the "what we can say here" bullets
  for a new page from the truth document) — `spark` is invoked for the
  specific field being drafted, given a brief plus the other fields
  already filled in as context, with the archetype's field description as
  the prompt scope — never "regenerate the document." Built as
  `spark/lib/writer-assist.js`'s `researchField()`, called via Writer's
  per-field ✨ affordance (`POST /api/writer/research-field`). This is the
  token-minimizing design the original §8 described: the model drafts
  sentences, the engine owns everything else.
- **Full draft** (added `BA26081812`, "for when we need work done fast") —
  one brief, one call, every field of the archetype proposed at once
  (`spark/lib/writer-assist.js`'s `fullDraft()`, `POST /api/writer/full-
  draft`). This is the one place this canon's scope genuinely widens past
  the original per-field-only design: a single call now drafts an entire
  document's content, not one field. The boundary that doesn't move: AI
  output in EITHER mode is always just field values landing in the same
  input controls manual entry uses — always reviewable/editable in the
  form before Generate, never a silent unreviewed draft, and never touches
  layout, style, or the render pipeline itself (§1 stays absolute for
  that). `spark`'s AI-calling layer (`lib/ai-provider.js`) is Groq-backed,
  Architect's own 20 Aug decision — the fleet's first real AI-model
  integration, not specific to Writer, though this is its first use.

---

## 9. Governance block — Architect's own self-protection layer, built in

Architect already designed this once, by hand, in the first document he ever
produced for Viva: `Website Content Development System v1.0/v1.1`
(the "DOC-20260713-WA0007"/"DOC-20260715-WA0002" attachments in the Alex
chat). It carries a **Document Control** table, an **Approval block** with
an explicit operative clause, and an **Appendix of standard records**
(Decision Log, Fact Sheet Confirmation, Batch Approval Record, Risk
Checklist). This is corroborated, not coincidental — the org's own doctrine
(`career/orgs/viva-valentia/doctrine.yaml`) states the operating principle
directly: *"the written record is the shield: if it is not in the
snapshot, on the board, or in a register, it did not happen"* and lists
*"Publish a claim without a Truth Document basis and an approver"* as a
standing **never**. Sam's own working style (same file) is recorded as
valuing "documents, spreadsheets and rubrics far more than verbal
commitment" — so a document that carries its own approval trail is not
paperwork for its own sake here, it is the actual protection mechanism this
specific workplace runs on.

**This becomes a reusable, shared component — `governance_block` —
available to any archetype, not rebuilt per document type:**

```yaml
governance_block:
  document_control:            # table: one row per version
    columns: [version, date, prepared_by, change]
  operative_clause: >-
    This document becomes operative when approved below. Any later change
    to the system is issued as a new version, recorded in the table above,
    and re-approved. Work is always performed against the latest approved
    version.
  approval_table:               # role/name/signature-or-written-approval/date
    roles: content-defined per archetype (e.g. "Final authority", "Supervisor")
  approval_equivalence_clause: >-
    Approval may be given by signature on this page or by written
    confirmation (e-mail or message) referencing "{document_title} v{version}
    — approved". Written confirmations are archived with this document.
  sensitive: false               # per Rule 4 (doctrine.yaml) — see below
```

- **Opt-in per archetype**, via `governance: true` in the archetype
  definition (§3) — a one-page internal brief like `page-truth-brief` may
  not need the full Appendix record set, but Document Control + Approval
  block are cheap and are the default recommendation for any Viva
  deliverable that shapes a decision, commits effort, or will be pointed to
  later ("what was approved, by whom, when").
- **Rule 4 enforcement, structural not remembered**: if an archetype's
  content sets `sensitive: true` (investor, financial, legal, regulatory,
  or named-third-party content — doctrine.yaml's own Rule 4 language),
  `doc-builder.js` refuses to render unless a `source_reference` field
  (the written management source) and `sensitive_approver` field are both
  present — turning "sensitive content needs a named source and a named
  approver" from a rule Architect has to remember into one the generator
  enforces at build time, exactly as `page-truth-brief`'s §4 field
  validation already does for required fields generally.
- **Approval detection can close the loop with `circle`'s existing chat
  importer**: `circle/lib/chat-import.js` already parses WhatsApp archives
  for dated messages per speaker. Because the approval-equivalence clause
  above defines an exact, greppable string
  (`"{document_title} v{version} — approved"`), a future pass over an
  imported chat archive can detect that exact pattern from a recognized
  approver and auto-file it as the written confirmation `governance_block`
  requires — not building this now, flagging it as a natural extension
  once both systems exist.
- **Decision-log integration**: rendering (or re-rendering with a new
  version) a `governance: true` document appends one row to that
  engagement's `decision_log.yaml` (already a real file —
  `career/orgs/viva-valentia/decision_log.yaml`) automatically — operating
  doctrine's Rule 1 ("recorded in the Decision Log... within one working
  day") as something the tool does, not something to remember to do by
  hand.
- **Archiving discipline carries over unchanged**: doctrine's "nothing is
  deleted; superseded items are marked as superseded" is already this
  system's default behavior (§6 — content JSON is the edited source,
  renders are always regenerated, never hand-edited) and needs no new
  mechanism, just a note that it was independently arrived at the same way
  for the same reason.

This section is themed on Viva specifically (its evidence is a Viva
document and Viva doctrine), but the mechanism — Document Control table,
approval trail, sensitive-content gate, decision-log append — is exactly as
generic as everything else in this canon, available to any engagement whose
doctrine calls for it, selected the same way naming profiles and archetype
namespaces are (§5, §3).

---

## 10. Open questions before build starts

1. Confirm the `docx`-builder + PDF library choices (both pure-JS, offline,
   no native/Docker dependency) before adding them as `scope` dependencies.
2. Confirm `career/orgs/viva-valentia/deliverables/...` as the output root
   (vs. some other location already in use for Viva work product).
3. Should `doc-builder.js`/renderers live in `scope/lib/` next to
   `docs.js`, or in a new `scope/lib/generate/` subfolder, given this is a
   meaningfully sized addition (archetype registry + 3 renderers + naming
   profiles)?
4. Confirm scope for v1: build out `page-truth-brief` fully (real data for
   WAMCA + APMA, matching the two dropped samples byte-for-byte in content)
   as the proof case, before generalizing to a second archetype.
5. Should `governance_block` (§9) ship in v1 alongside `page-truth-brief`,
   or land with the second archetype (a governance-heavy one, like a
   revival of the Website Content Development System itself as an
   archetype) where its Document-Control/Approval fields are actually
   exercised end-to-end?

# Resume Space — Plan

Status: **plan, build starts right after this**. Lives in `scope` (owns
document generation) and cross-references `hub` (owns the "Resume" nav
placement, alongside Corporate/Portfolio/Products/Platforms under
Projects). Built on top of `document-generation-canon.md` /
`document-generation-build-plan.md` — this is that engine's second real
consumer, not a separate system.

---

## 0. What this is

One canonical, always-current resume profile, rendered into as many
tailored **variants** as different jobs/work need — each downloadable as
Word or PDF on demand, never hand-maintained per version. The failure mode
this replaces: a resume that drifts from reality because updating it means
re-opening and re-editing N separate Word files by hand.

## 1. Person-agnostic, by construction — not multi-tenant, just not hardcoded

Per [[isconl-agent-single-user-private-by-design]], this system stays
single-user — "person-agnostic" here does **not** mean building a
multi-tenant resume service. It means the same discipline already applied
to `career/orgs/` (never hardcode "viva" — read it from `_active.yaml`):
never hardcode a user name, an email, a phone number, or any personal
fact into an archetype, a renderer, or a template. Every personal fact
lives in **data**, so the day this is open-sourced, a new user drops in
their own profile file and the code needs zero edits — same test the
Corporate Engagements plan already applies to org identity.

## 2. Data model

```
career/resume/
  profile.yaml          <- the ONE canonical source of truth
  variants/
    _template.yaml       <- copy this to make a new variant
    tech-advisory.yaml
    content-systems.yaml
    ...
```

**`profile.yaml`** — everything true about the person, exhaustively,
un-tailored: identity block (name, contact, links), every role held (dates,
org, bullets, written once each), every skill, every credential, every
project worth naming. This is the single place facts get added or
corrected — exactly the "always up to date" requirement. Shape:

```yaml
identity: { name, headline, email, phone, location, links: [...] }
roles:
  - id: role-viva-2026
    org: Viva Valentia / WABBA Global
    title: Producer / Content Systems Lead (Advisory)
    start: "2026-06"
    end: null
    bullets: [ "...", "...", "..." ]   # written once, full detail
    tags: [content-systems, advisory, association-sites]   # for variant selection
  - id: role-...
skills: [ { name, tags: [...] }, ... ]
education: [ ... ]
credentials: [ ... ]
projects: [ ... ]
```

**One variant file per target** — never a copy of the data, only a
*selection and emphasis* rule set over it:

```yaml
id: tech-advisory
title: Resume - Technical Advisory
role_filter: { include_tags: [advisory, content-systems] }   # or explicit role ids
bullet_limit_per_role: 4          # trims profile.yaml's full bullet list
skill_filter: { include_tags: [systems, ai-tooling] }
summary_override: "..."           # optional - a headline tailored to this target
section_order: [summary, roles, skills, projects, education]
```

A variant is small (it's a filter, not a fork), so profile edits
propagate to every variant automatically the next time each renders — the
concrete mechanism behind "always up to date."

This mirrors `career/orgs/_template/`'s own pattern exactly (a `_template`
to copy, one file per instance, nothing hardcoded that names an instance)
— same architecture, applied to resume variants instead of employers.

## 3. Archetype: `resume`

New entry in the document-generation engine's registry
(`scope/lib/generate/archetypes/_common/resume.js` — `_common`, not
namespaced to an engagement, since a resume isn't scoped to one employer).
Content schema: identity block, summary, ordered role entries (title, org,
dates, bullets), skills grouped, education, credentials, projects —
straightforward `paragraphs`/`bullets`/`kv_list` node types canon §3
already defines, no new field types needed.

**Naming profile** (canon §5's general shape, this archetype's instance):

```
{variant_slug}_resume_v{major}_{minor}_{patch}_{YYYYMMDD}.{ext}
```

`primary_id` = variant slug (`tech-advisory`), `secondary_id` = the fixed
token `resume` — deliberately not the other way around, so every resume
file sorts and groups by variant first when several sit in one folder.

## 4. Build step: profile + variant -> archetype content

`scope/lib/resume.js` (new, same shape as `corporate.js`/`decisions.js` —
an aggregator, not a renderer): `buildResumeContent(variantId)` reads
`profile.yaml` + the named variant file, applies the filter/limit/order
rules, and produces the exact content object the `resume` archetype's
schema expects. This is the one place selection logic lives — the
renderers (canon §7) never know a variant exists, they just render
whatever content tree they're handed, identically for every variant.

## 5. Where output lives

```
career/resume/deliverables/<variant_slug>/
    tech-advisory_resume_v1_0_0_20260814.docx
    tech-advisory_resume_v1_0_0_20260814.md
    tech-advisory_resume_v1_0_0_20260814.pdf
```

Same shape as canon §6's engagement-deliverables tree, sibling to it
under `career/` rather than under an org, since a resume isn't scoped to
one engagement.

## 6. hub wiring

- `scope`: `GET /resume/variants` (list), `GET /resume/render?variant=&format=docx|md|pdf`
  (build content, render, stream the file back with the right
  Content-Type/Content-Disposition — a real download, not a JSON blob).
- `hub`: `/api/resume/variants`, `/api/resume/render` compat routes,
  same capability-router pattern as `/api/corporate`.
- **"Resume" nav item**, `webconsole/index.html`'s PROJECTS group, beside
  Corporate/Portfolio/Products/Platforms (this session's own placement
  convention).
- View: variant cards (mirroring the Corporate card grid just built) -
  each with the profile's current summary line, last-rendered date, and
  three download buttons (Word/Markdown/PDF) that hit `/api/resume/render`
  directly - a real file download, not a page navigation.

## 7. Build order

1. `career/resume/profile.yaml` seeded from Architect's own real history
   (the Website Content Development System doc, the WABBA/Viva role
   already on record in `career/orgs/viva-valentia/org.yaml`, and
   whatever pre-Viva history he supplies) - data first, since nothing
   else can be tested without it.
2. `career/resume/variants/_template.yaml` + one real variant.
3. `resume` archetype definition.
4. `scope/lib/resume.js` (build step) - unit-testable independent of any
   renderer, since it only produces a content object.
5. Wire into whichever renderers exist by that point (markdown first,
   per the doc-gen build plan's own phase order - fastest to verify a
   variant's selection logic actually works before trusting the docx/pdf
   output).
6. `scope`/`hub` HTTP wiring, then the webconsole view.

## 8. Open questions

1. Confirm the real employment/project history to seed `profile.yaml`
   with, beyond what's already on record in `career/orgs/viva-valentia/`.
2. How many variants to start with, and what they should be tailored for
   (e.g. tech/systems roles vs. content/advisory roles vs. something
   else entirely) - one real variant proves the mechanism; more can be
   added anytime without touching code.

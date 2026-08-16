'use strict';
/**
 * page-truth-brief - the first archetype, evidenced directly by the two
 * Alex-approved sample documents (apma_..._v1_2_0...docx,
 * wamca_..._v1_4_0...docx) plus his corrections in the WhatsApp chat
 * (13-14 Aug 2026). Internal-only - never published on the live page
 * itself. Full field-by-field rationale: document-generation-canon.md §3.1.
 *
 * Namespaced under viva-valentia/ per canon §1's revision: archetypes are
 * linked to a project/engagement, not offered globally.
 */

const { heading, paragraphs, bullets, kvList, truthCheck, document } = require('../../node-tree');

const REQUIRED = [
  'site_name', 'page_name', 'url', 'date_readable', 'version', 'site_role',
  'menu_subpage', 'focus_paragraphs', 'can_say', 'sections_used', 'must_not_say',
];

function validate(content) {
  const errors = REQUIRED.filter(f => content[f] === undefined || content[f] === null || content[f] === '')
    .map(f => `missing required field: ${f}`);
  if (content.site_role === 'sister' && !content.sector_label) {
    errors.push('site_role is "sister" but sector_label is missing - this is exactly the [sector-specific] bug this archetype exists to prevent');
  }
  return { valid: errors.length === 0, errors };
}

/** Resolve the {sector_label} token wherever it appears in a sister-site
 *  string. Master sites carry no token at all - nothing to resolve. This
 *  is the concrete fix for the bug already present in the APMA sample
 *  (canon §5): the token is filled here, at build time, never left as a
 *  literal string for a human to remember to replace. */
function resolveSector(text, content) {
  if (content.site_role !== 'sister') return text;
  return String(text).replace(/\{sector_label\}|\[sector-specific\]/g, content.sector_label);
}

const FOOTER = {
  master: (content) =>
    `This is the sister-site version. Everything else is identical across all ten sites. On the sister sites two lines change.`,
  sister: (content) =>
    `This is the sister-site version. For ${content.site_name}, the sector-specific wording throughout this brief resolves to "${content.sector_label}". The same substitution carries to the remaining associations.`,
};

function build(content) {
  const { valid, errors } = validate(content);
  if (!valid) throw new Error(`page-truth-brief: ${errors.join('; ')}`);

  const author = content.author || '';
  const typeLabel = 'Sub-page summary box';

  return document({
    headline: `${content.site_name} — ${content.page_name}`,
    metaLine: `${typeLabel} | ${content.url} | ${content.date_readable} | v${content.version} | ${author}`,
    sections: [
      kvList([
        ['Site.', content.site_description || content.site_name],
        ['Menu and sub-page.', content.menu_subpage],
      ]),
      heading(2, '1.   FOCUS, AND WHAT KEEPS IT SEPARATE FROM ITS NEIGHBOURS'),
      ...paragraphs(content.focus_paragraphs.map(p => resolveSector(p, content))),
      heading(2, '2.   WHAT WE CAN SAY HERE'),
      bullets(content.can_say.map(p => resolveSector(p, content))),
      heading(2, '3.   CHECKED AGAINST THE TRUTH DOCUMENT'),
      truthCheck(content.sections_used, content.must_not_say),
    ],
    footerNote: (content.site_role === 'master' ? FOOTER.master : FOOTER.sister)(content),
  });
}

module.exports = {
  id: 'page-truth-brief',
  title: 'Sub-page Truth Brief',
  governance: false,
  filenameFields: { primary: 'site_id', secondary: 'page_slug' },
  validate,
  build,
};

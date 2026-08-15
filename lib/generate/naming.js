'use strict';
/**
 * The general filename shape (canon §5, generalized 14 Aug 2026 past the
 * original site/page-only wording): two identifying slots first, version,
 * date last, no free-text descriptor. Each archetype declares what its two
 * slots MEAN (filenameFields on the archetype module); this file only
 * knows the shape, never "site" or "page" specifically - that's what keeps
 * it usable by a resume archetype (variant/resume) as much as a page brief
 * (site/page).
 */

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** archetype = the archetype module (has .filenameFields = {primary, secondary}).
 *  content = the same content object passed to doc-builder.
 *  version = "1.4.0". date = a Date or ISO string; defaults to today.
 *  ext = 'docx' | 'md' | 'pdf' | 'content.json'. */
function filename(archetype, content, { version, date = new Date(), ext }) {
  if (!archetype.filenameFields) throw new Error(`archetype "${archetype.id}" declares no filenameFields`);
  const { primary, secondary } = archetype.filenameFields;
  const primaryVal = slugify(content[primary]);
  const secondaryVal = slugify(content[secondary]);
  if (!primaryVal || !secondaryVal) {
    throw new Error(`naming: content is missing "${primary}" or "${secondary}" (archetype "${archetype.id}"'s filename fields)`);
  }
  const [major = '0', minor = '0', patch = '0'] = String(version || '0.0.0').split('.');
  const d = date instanceof Date ? date : new Date(date);
  const yyyymmdd = d.toISOString().slice(0, 10).replace(/-/g, '');
  return `${primaryVal}_${secondaryVal}_v${major}_${minor}_${patch}_${yyyymmdd}.${ext}`;
}

module.exports = { filename, slugify };

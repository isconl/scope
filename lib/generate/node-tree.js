'use strict';
/**
 * The neutral node-tree vocabulary every archetype builds from and every
 * renderer walks. Plain object shapes, not classes - matches the rest of
 * this repo (lib/docs.js, lib/chat-import.js are both plain
 * functions/objects). Fixing this vocabulary in one small file is what
 * lets docx/markdown/pdf stay format-specific renderers over one shared
 * tree instead of three independent implementations that can drift.
 *
 * See document-generation-canon.md §1/§3 for the design this implements.
 */

const heading = (level, text) => ({ type: 'heading', level, text: String(text || '') });

const paragraph = (text) => ({ type: 'paragraph', text: String(text || '') });

/** A run of paragraphs under one section - kept as separate nodes rather
 *  than one joined string so a renderer can put a blank line/spacing
 *  between them without guessing where sentences end. */
const paragraphs = (texts) => (texts || []).filter(Boolean).map(paragraph);

const bullets = (items) => ({ type: 'bullets', items: (items || []).map(String) });

/** Bullet + citation, for "what we must not say" style content where each
 *  point needs to point at why (canon §3's `checked_bullets`). */
const checkedBullets = (items) => ({
  type: 'checked_bullets',
  items: (items || []).map(i => ({ text: String(i.text || i.claim || ''), reason: String(i.reason || '') })),
});

/** Label/value pairs, rendered as one line each ("Site.  APMA, ..."). */
const kvList = (pairs) => ({
  type: 'kv_list',
  items: (pairs || []).map(([label, value]) => ({ label: String(label || ''), value: String(value || '') })),
});

/** The one archetype-specific composite node canon §3.1 names directly:
 *  a list of "sections used" plus a list of must-not-say claims with
 *  reasons - kept as its own node type rather than generic kv/bullets so
 *  a renderer can lay it out with its own visual treatment. */
const truthCheck = (sectionsUsed, mustNotSay) => ({
  type: 'truth_check',
  sectionsUsed: (sectionsUsed || []).map(String),
  mustNotSay: (mustNotSay || []).map(m => ({ claim: String(m.claim || ''), reason: String(m.reason || '') })),
});

const table = (headerRow, rows) => ({
  type: 'table',
  header: (headerRow || []).map(String),
  rows: (rows || []).map(r => r.map(String)),
});

/** A document is a header block (headline + optional meta line) plus an
 *  ordered list of body section nodes plus an optional footer note - the
 *  shape every archetype's build() output conforms to. */
function document({ headline, metaLine, sections, footerNote }) {
  return {
    type: 'document',
    headline: String(headline || ''),
    metaLine: metaLine ? String(metaLine) : null,
    sections: sections || [],
    footerNote: footerNote ? String(footerNote) : null,
  };
}

module.exports = { heading, paragraph, paragraphs, bullets, checkedBullets, kvList, truthCheck, table, document };

'use strict';
/**
 * single-page-memo - BA26081815 starter #4, deliberately minimal per
 * Architect's own memo/single-pager pattern already seen in `WV26081801`.
 * Flat field list, no sections -- the row's own "deliberately minimal"
 * instruction means this archetype should NOT use the sectioned layout
 * even though the renderer supports it.
 */

const { paragraphs, kvList, document } = require('../../node-tree');

const REQUIRED = ['to', 'from', 'date', 're', 'body_paragraphs'];

function validate(content) {
  const errors = REQUIRED.filter(f => content[f] === undefined || content[f] === null || content[f] === '' || (Array.isArray(content[f]) && !content[f].length))
    .map(f => `missing required field: ${f}`);
  return { valid: errors.length === 0, errors };
}

function build(content) {
  const { valid, errors } = validate(content);
  if (!valid) throw new Error(`single-page-memo: ${errors.join('; ')}`);

  const sections = [
    kvList([
      ['To.', content.to],
      ['From.', content.from],
      ['Date.', content.date],
      ['Re.', content.re],
    ]),
    ...paragraphs(content.body_paragraphs),
  ];

  return document({ headline: 'MEMO', metaLine: null, sections, footerNote: null });
}

const FIELDS = [
  { name: 'to', label: 'To', type: 'text', required: true },
  { name: 'from', label: 'From', type: 'text', required: true },
  { name: 'date', label: 'Date', type: 'text', required: true },
  { name: 're', label: 'Re (subject)', type: 'text', required: true },
  { name: 'body_paragraphs', label: 'Body (one paragraph per line)', type: 'list', required: true },
];

module.exports = {
  id: 'single-page-memo',
  title: 'Single-Page Memo',
  governance: false,
  filenameFields: { primary: 're', secondary: 'date' },
  fields: FIELDS,
  validate,
  build,
};

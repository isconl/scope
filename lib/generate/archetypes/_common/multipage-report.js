'use strict';
/**
 * multipage-report - BA26081815 starter #3, the clearest real case for
 * BA26081810's sectioned layout hint: executive summary, N repeatable
 * body sections (heading | body, reasoned-list), conclusion.
 *
 * BA26082425: a body section's `type` (default 'paragraph') selects which
 * existing node-tree constructor it dispatches to -- 'table' expects
 * `body: {header: [...], rows: [[...]]}`, 'bullets' expects `body:
 * string[]`. No new node-tree node types needed; this just stops
 * hardcoding every section to paragraph(). Riley' competitive-position
 * document (the row's motivating case) is a mix of paragraph/table/bullets
 * sections in this exact shape.
 */

const { heading, paragraph, paragraphs, bullets, table, document } = require('../../node-tree');

const REQUIRED = ['title', 'date_readable', 'executive_summary', 'report_sections', 'conclusion'];

function validate(content) {
  const errors = REQUIRED.filter(f => content[f] === undefined || content[f] === null || content[f] === '' || (Array.isArray(content[f]) && !content[f].length))
    .map(f => `missing required field: ${f}`);
  return { valid: errors.length === 0, errors };
}

function build(content) {
  const { valid, errors } = validate(content);
  if (!valid) throw new Error(`multipage-report: ${errors.join('; ')}`);

  const sections = [
    heading(2, 'Executive Summary'),
    ...paragraphs([content.executive_summary]),
  ];

  for (const s of content.report_sections) {
    const label = s.heading || s.label || '';
    const body = s.body || s.detail || '';
    const type = s.type || 'paragraph';
    sections.push(heading(2, label));
    if (type === 'table') {
      sections.push(table(body.header, body.rows));
    } else if (type === 'bullets') {
      sections.push(bullets(body));
    } else {
      sections.push(paragraph(body));
    }
  }

  sections.push(heading(2, 'Conclusion'), ...paragraphs([content.conclusion]));

  return document({
    headline: content.title,
    metaLine: [content.date_readable, content.author].filter(Boolean).join(' | '),
    sections,
    footerNote: content.footer_note || null,
  });
}

const FIELDS = [
  { name: 'title', label: 'Title', type: 'text', required: true, section: 'Cover' },
  { name: 'date_readable', label: 'Date (readable)', type: 'text', required: true, section: 'Cover' },
  { name: 'author', label: 'Author', type: 'text', section: 'Cover' },
  { name: 'executive_summary', label: 'Executive summary', type: 'textarea', required: true, section: 'Summary' },
  { name: 'report_sections', label: 'Body sections (heading | type | body -- type is paragraph/table/bullets, default paragraph)', type: 'reasoned-list', keys: ['heading', 'type', 'body'], required: true, section: 'Body' },
  { name: 'conclusion', label: 'Conclusion', type: 'textarea', required: true, section: 'Conclusion' },
  { name: 'footer_note', label: 'Footer note', type: 'text', section: 'Conclusion' },
];

module.exports = {
  id: 'multipage-report',
  title: 'Multipage Report',
  governance: false,
  filenameFields: { primary: 'title', secondary: 'date_readable' },
  fields: FIELDS,
  validate,
  build,
};

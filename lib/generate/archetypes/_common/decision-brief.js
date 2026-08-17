'use strict';
/**
 * decision-brief - a general single-page, decision-first brief with an
 * approval slot, per task-backlog.md D1's "brief" gap. Namespaced under
 * _common/ (not viva-valentia/) because nothing about its shape is
 * engagement-specific - any engagement can generate one, unlike
 * page-truth-brief which encodes viva-valentia's sister-site rules.
 *
 * Deliberately narrow: one decision, one recommendation, one approval slot.
 * A brief that tries to cover multiple decisions is a different document.
 */

const { heading, paragraphs, bullets, kvList, table, document } = require('../../node-tree');

const REQUIRED = [
  'subject_id', 'audience', 'title', 'date_readable', 'version',
  'decision_ask', 'context_paragraphs', 'recommendation', 'approval_name', 'approval_role',
];

function validate(content) {
  const errors = REQUIRED.filter(f => content[f] === undefined || content[f] === null || content[f] === '')
    .map(f => `missing required field: ${f}`);
  return { valid: errors.length === 0, errors };
}

function build(content) {
  const { valid, errors } = validate(content);
  if (!valid) throw new Error(`decision-brief: ${errors.join('; ')}`);

  const author = content.author || '';
  const options = content.options || [];

  const sections = [
    kvList([
      ['Decision requested.', content.decision_ask],
    ]),
    heading(2, '1.   CONTEXT'),
    ...paragraphs(content.context_paragraphs),
  ];

  if (options.length) {
    sections.push(
      heading(2, '2.   OPTIONS CONSIDERED'),
      table(['Option', 'Detail'], options.map(o => [o.option || o.label || '', o.detail || o.note || ''])),
    );
  }

  sections.push(
    heading(2, options.length ? '3.   RECOMMENDATION' : '2.   RECOMMENDATION'),
    ...paragraphs([content.recommendation]),
  );

  if ((content.risks || []).length) {
    sections.push(
      heading(2, options.length ? '4.   RISKS AND CONSIDERATIONS' : '3.   RISKS AND CONSIDERATIONS'),
      bullets(content.risks),
    );
  }

  sections.push(
    heading(2, 'APPROVAL'),
    table(['Approver', 'Role', 'Decision', 'Date'], [[content.approval_name, content.approval_role, '', '']]),
  );

  return document({
    headline: content.title,
    metaLine: `Decision brief | ${content.audience} | ${content.date_readable} | v${content.version} | ${author}`,
    sections,
    footerNote: content.footer_note || null,
  });
}

const FIELDS = [
  { name: 'subject_id', label: 'Subject ID (for filename)', type: 'text', required: true },
  { name: 'audience', label: 'Audience (for filename, e.g. "alex")', type: 'text', required: true },
  { name: 'title', label: 'Title', type: 'text', required: true },
  { name: 'date_readable', label: 'Date (readable)', type: 'text', required: true },
  { name: 'version', label: 'Version', type: 'text', required: true },
  { name: 'author', label: 'Author', type: 'text' },
  { name: 'decision_ask', label: 'Decision requested', type: 'text', required: true },
  { name: 'context_paragraphs', label: 'Context (one paragraph per line)', type: 'list', required: true },
  { name: 'options', label: 'Options (option | detail, one per line)', type: 'reasoned-list', keys: ['option', 'detail'] },
  { name: 'recommendation', label: 'Recommendation', type: 'textarea', required: true },
  { name: 'risks', label: 'Risks and considerations (one per line)', type: 'list' },
  { name: 'approval_name', label: 'Approver name', type: 'text', required: true },
  { name: 'approval_role', label: 'Approver role', type: 'text', required: true },
  { name: 'footer_note', label: 'Footer note', type: 'text' },
];

module.exports = {
  id: 'decision-brief',
  title: 'Decision Brief',
  governance: false,
  filenameFields: { primary: 'subject_id', secondary: 'audience' },
  fields: FIELDS,
  validate,
  build,
};

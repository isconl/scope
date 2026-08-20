'use strict';
/** proposal - BA26081815's "and more" allowance. Problem/solution/
 *  timeline/cost/next-steps shape, one of the most common business
 *  document types the row's named 4 didn't cover. */

const { heading, paragraphs, bullets, kvList, document } = require('../../node-tree');

const REQUIRED = ['title', 'client', 'date', 'problem_statement', 'proposed_solution', 'next_steps'];

function validate(content) {
  const errors = REQUIRED.filter(f => content[f] === undefined || content[f] === null || content[f] === '' || (Array.isArray(content[f]) && !content[f].length))
    .map(f => `missing required field: ${f}`);
  return { valid: errors.length === 0, errors };
}

function build(content) {
  const { valid, errors } = validate(content);
  if (!valid) throw new Error(`proposal: ${errors.join('; ')}`);

  const sections = [
    kvList([['Prepared for.', content.client]]),
    heading(2, 'Problem'),
    ...paragraphs([content.problem_statement]),
    heading(2, 'Proposed Solution'),
    ...paragraphs([content.proposed_solution]),
  ];
  if ((content.timeline || []).length) sections.push(heading(2, 'Timeline'), bullets(content.timeline));
  if (content.cost) sections.push(heading(2, 'Cost'), ...paragraphs([content.cost]));
  sections.push(heading(2, 'Next Steps'), bullets(content.next_steps));

  return document({ headline: content.title, metaLine: content.date, sections, footerNote: null });
}

const FIELDS = [
  { name: 'title', label: 'Title', type: 'text', required: true },
  { name: 'client', label: 'Prepared for (client)', type: 'text', required: true },
  { name: 'date', label: 'Date', type: 'text', required: true },
  { name: 'problem_statement', label: 'Problem', type: 'textarea', required: true },
  { name: 'proposed_solution', label: 'Proposed solution', type: 'textarea', required: true },
  { name: 'timeline', label: 'Timeline (one milestone per line)', type: 'list' },
  { name: 'cost', label: 'Cost', type: 'textarea' },
  { name: 'next_steps', label: 'Next steps (one per line)', type: 'list', required: true },
];

module.exports = {
  id: 'proposal',
  title: 'Proposal',
  governance: false,
  filenameFields: { primary: 'client', secondary: 'title' },
  fields: FIELDS,
  validate,
  build,
};

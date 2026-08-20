'use strict';
/**
 * email - BA26081815's first starter archetype. `layout: 'header-block'`
 * (BA26081810's renderer hint) renders to/cc/subject as a compact header
 * row in the input form instead of a stacked list -- matches how an
 * actual email composer looks, per BA26081810's UX-north-star note that
 * the INPUT form should be shaped for what's easiest to fill, not a
 * preview of the output.
 */

const { paragraphs, document } = require('../../node-tree');

const REQUIRED = ['to', 'subject', 'body_paragraphs'];

function validate(content) {
  const errors = REQUIRED.filter(f => content[f] === undefined || content[f] === null || content[f] === '' || (Array.isArray(content[f]) && !content[f].length))
    .map(f => `missing required field: ${f}`);
  return { valid: errors.length === 0, errors };
}

function build(content) {
  const { valid, errors } = validate(content);
  if (!valid) throw new Error(`email: ${errors.join('; ')}`);

  const metaParts = [`To: ${content.to}`];
  if (content.cc) metaParts.push(`Cc: ${content.cc}`);

  return document({
    headline: content.subject,
    metaLine: metaParts.join('  |  '),
    sections: paragraphs(content.body_paragraphs),
    footerNote: content.signature || null,
  });
}

const FIELDS = [
  { name: 'to', label: 'To', type: 'text', required: true },
  { name: 'cc', label: 'Cc', type: 'text' },
  { name: 'subject', label: 'Subject', type: 'text', required: true },
  { name: 'body_paragraphs', label: 'Body (one paragraph per line)', type: 'list', required: true },
  { name: 'signature', label: 'Signature / sign-off', type: 'text' },
];

module.exports = {
  id: 'email',
  title: 'Email',
  governance: false,
  layout: 'header-block',
  filenameFields: { primary: 'to', secondary: 'subject' },
  fields: FIELDS,
  validate,
  build,
};

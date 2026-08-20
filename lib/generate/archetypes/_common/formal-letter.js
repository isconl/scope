'use strict';
/**
 * formal-letter - BA26081815 starter #2. Sectioned (BA26081810's
 * `section` field-metadata hint) into Header/Body/Closing groups so the
 * input form reads as three collapsible blocks instead of one long list.
 */

const { paragraph, paragraphs, kvList, document } = require('../../node-tree');

const REQUIRED = ['sender_name', 'recipient_name', 'date', 'salutation', 'body_paragraphs', 'closing', 'signatory_name'];

function validate(content) {
  const errors = REQUIRED.filter(f => content[f] === undefined || content[f] === null || content[f] === '' || (Array.isArray(content[f]) && !content[f].length))
    .map(f => `missing required field: ${f}`);
  return { valid: errors.length === 0, errors };
}

function build(content) {
  const { valid, errors } = validate(content);
  if (!valid) throw new Error(`formal-letter: ${errors.join('; ')}`);

  const sections = [
    kvList([
      ['From.', [content.sender_name, content.sender_address].filter(Boolean).join(', ')],
      ['To.', [content.recipient_name, content.recipient_address].filter(Boolean).join(', ')],
      ['Date.', content.date],
    ]),
    paragraph(`${content.salutation},`),
    ...paragraphs(content.body_paragraphs),
    paragraph(`${content.closing},`),
    paragraph(content.signatory_name),
  ];

  return document({
    headline: content.subject_line || 'Letter',
    metaLine: null,
    sections,
    footerNote: null,
  });
}

const FIELDS = [
  { name: 'sender_name', label: 'Sender name', type: 'text', required: true, section: 'Header' },
  { name: 'sender_address', label: 'Sender address', type: 'text', section: 'Header' },
  { name: 'recipient_name', label: 'Recipient name', type: 'text', required: true, section: 'Header' },
  { name: 'recipient_address', label: 'Recipient address', type: 'text', section: 'Header' },
  { name: 'date', label: 'Date', type: 'text', required: true, section: 'Header' },
  { name: 'subject_line', label: 'Subject line (optional, "Re: ...")', type: 'text', section: 'Header' },
  { name: 'salutation', label: 'Salutation (e.g. "Dear Mr Smith")', type: 'text', required: true, section: 'Body' },
  { name: 'body_paragraphs', label: 'Body (one paragraph per line)', type: 'list', required: true, section: 'Body' },
  { name: 'closing', label: 'Closing (e.g. "Yours sincerely")', type: 'text', required: true, section: 'Closing' },
  { name: 'signatory_name', label: 'Signatory name', type: 'text', required: true, section: 'Closing' },
];

module.exports = {
  id: 'formal-letter',
  title: 'Formal Letter',
  governance: false,
  filenameFields: { primary: 'recipient_name', secondary: 'date' },
  fields: FIELDS,
  validate,
  build,
};

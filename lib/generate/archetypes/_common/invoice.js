'use strict';
/** invoice - BA26081815's "and more" allowance. Deliberately simple
 *  (line items + totals), not a real billing system -- a document, not a
 *  ledger. */

const { heading, kvList, table, document } = require('../../node-tree');

const REQUIRED = ['invoice_number', 'date', 'bill_to', 'line_items', 'total'];

function validate(content) {
  const errors = REQUIRED.filter(f => content[f] === undefined || content[f] === null || content[f] === '' || (Array.isArray(content[f]) && !content[f].length))
    .map(f => `missing required field: ${f}`);
  return { valid: errors.length === 0, errors };
}

function build(content) {
  const { valid, errors } = validate(content);
  if (!valid) throw new Error(`invoice: ${errors.join('; ')}`);

  const sections = [
    kvList([
      ['Invoice #.', content.invoice_number],
      ['Date.', content.date],
      ['Bill to.', content.bill_to],
    ]),
    heading(2, 'Line Items'),
    table(['Description', 'Amount'], content.line_items.map(i => [i.description || i.option || '', i.amount || i.detail || ''])),
    kvList([
      ...(content.subtotal ? [['Subtotal.', content.subtotal]] : []),
      ...(content.tax ? [['Tax.', content.tax]] : []),
      ['Total.', content.total],
    ]),
  ];

  return document({
    headline: `Invoice ${content.invoice_number}`,
    metaLine: content.date,
    sections,
    footerNote: content.payment_terms || null,
  });
}

const FIELDS = [
  { name: 'invoice_number', label: 'Invoice number', type: 'text', required: true },
  { name: 'date', label: 'Date', type: 'text', required: true },
  { name: 'bill_to', label: 'Bill to', type: 'text', required: true },
  { name: 'line_items', label: 'Line items (description | amount, one per line)', type: 'reasoned-list', keys: ['description', 'amount'], required: true },
  { name: 'subtotal', label: 'Subtotal', type: 'text' },
  { name: 'tax', label: 'Tax', type: 'text' },
  { name: 'total', label: 'Total', type: 'text', required: true },
  { name: 'payment_terms', label: 'Payment terms', type: 'text' },
];

module.exports = {
  id: 'invoice',
  title: 'Invoice',
  governance: false,
  filenameFields: { primary: 'invoice_number', secondary: 'bill_to' },
  fields: FIELDS,
  validate,
  build,
};

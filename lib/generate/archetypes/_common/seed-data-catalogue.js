'use strict';
/**
 * seed-data-catalogue - a tabular reference document listing seed-data
 * entries (field/example/notes), per task-backlog.md D1's second flagged
 * gap. Namespaced under _common/ - "here is a table of sample data for a
 * use case" is a generic document shape, not specific to any one
 * engagement.
 */

const { heading, paragraphs, table, document } = require('../../node-tree');

const REQUIRED = ['catalogue_id', 'scope_name', 'title', 'date_readable', 'version', 'entries'];

function validate(content) {
  const errors = REQUIRED.filter(f => content[f] === undefined || content[f] === null || content[f] === '')
    .map(f => `missing required field: ${f}`);
  if (Array.isArray(content.entries) && content.entries.length === 0) {
    errors.push('entries must have at least one row');
  }
  return { valid: errors.length === 0, errors };
}

function build(content) {
  const { valid, errors } = validate(content);
  if (!valid) throw new Error(`seed-data-catalogue: ${errors.join('; ')}`);

  const author = content.author || '';
  const sections = [];

  if ((content.description_paragraphs || []).length) {
    sections.push(heading(2, 'SCOPE'), ...paragraphs(content.description_paragraphs));
  }

  sections.push(
    heading(2, 'SEED DATA'),
    table(
      ['Category', 'Field', 'Example value', 'Notes'],
      content.entries.map(e => [e.category || '', e.field || '', e.example_value || e.example || '', e.notes || '']),
    ),
  );

  return document({
    headline: content.title,
    metaLine: `Seed-data catalogue | ${content.scope_name} | ${content.date_readable} | v${content.version} | ${author}`,
    sections,
    footerNote: content.footer_note || null,
  });
}

const FIELDS = [
  { name: 'catalogue_id', label: 'Catalogue ID (for filename)', type: 'text', required: true },
  { name: 'scope_name', label: 'Scope name (for filename)', type: 'text', required: true },
  { name: 'title', label: 'Title', type: 'text', required: true },
  { name: 'date_readable', label: 'Date (readable)', type: 'text', required: true },
  { name: 'version', label: 'Version', type: 'text', required: true },
  { name: 'author', label: 'Author', type: 'text' },
  { name: 'description_paragraphs', label: 'Scope description (one paragraph per line)', type: 'list' },
  { name: 'entries', label: 'Seed data rows (category | field | example value | notes, one per line)', type: 'table-list', keys: ['category', 'field', 'example_value', 'notes'], required: true },
  { name: 'footer_note', label: 'Footer note', type: 'text' },
];

module.exports = {
  id: 'seed-data-catalogue',
  title: 'Seed-Data Catalogue',
  governance: false,
  filenameFields: { primary: 'catalogue_id', secondary: 'scope_name' },
  fields: FIELDS,
  validate,
  build,
};

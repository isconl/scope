'use strict';
/** BA26081815: the 7 new _common archetypes -- each must validate,
 *  build a real node tree, and render to both docx and markdown without
 *  throwing (the "only the generated doc looks like the final
 *  deliverable, not a raw field dump" bar the row set). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../lib/generate/doc-builder');
const { renderMarkdown } = require('../lib/generate/render-markdown');
const { renderDocx } = require('../lib/generate/render-docx');
const { listArchetypes, _resetCache } = require('../lib/generate/registry');

const FIXTURES = {
  email: { to: 'alex@example.com', cc: 'sconl@example.com', subject: 'Quick update', body_paragraphs: ['Here is the update you asked for.', 'Let me know if anything is unclear.'], signature: 'Architect' },
  'formal-letter': { sender_name: 'Operator', sender_address: '1 Main St', recipient_name: 'Mr Smith', recipient_address: '2 Other St', date: '20 August 2026', subject_line: 'Re: Contract', salutation: 'Dear Mr Smith', body_paragraphs: ['This letter confirms our agreement.'], closing: 'Yours sincerely', signatory_name: 'Operator' },
  'multipage-report': { title: 'Q3 Review', date_readable: '20 August 2026', author: 'Architect', executive_summary: 'Overall a strong quarter.', report_sections: [{ heading: 'Revenue', body: 'Revenue grew 12%.' }, { heading: 'Costs', body: 'Costs stayed flat.' }], conclusion: 'On track for the year.' },
  'single-page-memo': { to: 'Team', from: 'Architect', date: '20 August 2026', re: 'Office move', body_paragraphs: ['We are moving offices next month.'] },
  'meeting-notes': { meeting_title: 'Weekly Sync', date: '20 August 2026', attendees: ['Architect', 'Alex'], agenda: ['Budget', 'Timeline'], decisions: ['Approved the budget'], action_items: [{ action: 'Send report', owner: 'Architect' }], next_meeting: '27 August 2026' },
  proposal: { title: 'Website Redesign', client: 'Acme Corp', date: '20 August 2026', problem_statement: 'The current site converts poorly.', proposed_solution: 'A redesigned, mobile-first site.', timeline: ['Week 1: discovery', 'Week 4: launch'], cost: '$10,000', next_steps: ['Sign contract', 'Kickoff call'] },
  invoice: { invoice_number: 'INV-001', date: '20 August 2026', bill_to: 'Acme Corp', line_items: [{ description: 'Design work', amount: '$5,000' }], subtotal: '$5,000', tax: '$500', total: '$5,500', payment_terms: 'Net 30' },
};

for (const [id, content] of Object.entries(FIXTURES)) {
  test(`${id}: builds a valid node tree and renders to markdown + docx`, async () => {
    const { archetype, tree } = build('_common', id, content);
    assert.equal(archetype.id, id);
    assert.equal(tree.type, 'document');
    const md = renderMarkdown(tree);
    assert.ok(md.length > 20);
    const docxBuf = await renderDocx(tree);
    assert.ok(Buffer.isBuffer(docxBuf) && docxBuf.length > 1000);
  });

  test(`${id}: refuses to build with a required field missing`, () => {
    const required = require(`../lib/generate/archetypes/_common/${id}`).fields.find(f => f.required);
    const broken = { ...content, [required.name]: undefined };
    assert.throws(() => build('_common', id, broken), new RegExp(`missing required field: ${required.name}`));
  });
}

test('all 7 new archetypes appear in listArchetypes for the general (_common) namespace', () => {
  _resetCache();
  const list = listArchetypes('_common');
  const ids = list.map(a => a.id);
  for (const id of Object.keys(FIXTURES)) assert.ok(ids.includes(id), `${id} missing from listArchetypes`);
});

test('email declares layout:header-block, and listArchetypes surfaces it', () => {
  _resetCache();
  const list = listArchetypes('_common');
  const email = list.find(a => a.id === 'email');
  assert.equal(email.layout, 'header-block');
});

test('formal-letter and multipage-report fields carry section metadata, and listArchetypes surfaces it', () => {
  _resetCache();
  const list = listArchetypes('_common');
  const letter = list.find(a => a.id === 'formal-letter');
  assert.ok(letter.fields.some(f => f.section === 'Header'));
  const report = list.find(a => a.id === 'multipage-report');
  assert.ok(report.fields.some(f => f.section === 'Body'));
});

'use strict';
/** BA26082425: multipage-report's report_sections must dispatch on `type`
 *  (paragraph/table/bullets) to the matching node-tree constructor,
 *  matching Riley' competitive-position document's real shape. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../lib/generate/doc-builder');
const { renderDocx } = require('../lib/generate/render-docx');
const { renderMarkdown } = require('../lib/generate/render-markdown');
const JSZip = require('jszip');

const BASE = { title: 'Competitive Position Review', date_readable: '26 August 2026', executive_summary: 'Summary text.', conclusion: 'Closing text.' };

test('a section with no type defaults to paragraph (backward compatible)', () => {
  const { tree } = build('_common', 'multipage-report', { ...BASE, report_sections: [{ heading: 'Revenue', body: 'Revenue grew 12%.' }] });
  const body = tree.sections.find(s => s.type === 'paragraph' && s.text === 'Revenue grew 12%.');
  assert.ok(body, 'expected a plain paragraph node for the untyped section');
});

test('a table-type section dispatches to the table node-tree constructor', () => {
  const { tree } = build('_common', 'multipage-report', {
    ...BASE,
    report_sections: [{ heading: 'Vulnerabilities', type: 'table', body: { header: ['#', 'Vulnerability', 'Severity'], rows: [['1', 'Pricing opacity', 'High']] } }],
  });
  const tableNode = tree.sections.find(s => s.type === 'table');
  assert.ok(tableNode, 'expected a table node');
  assert.deepEqual(tableNode.header, ['#', 'Vulnerability', 'Severity']);
  assert.deepEqual(tableNode.rows, [['1', 'Pricing opacity', 'High']]);
});

test('a bullets-type section dispatches to the bullets node-tree constructor', () => {
  const { tree } = build('_common', 'multipage-report', {
    ...BASE,
    report_sections: [{ heading: 'Where We Are Winning', type: 'bullets', body: ['Speed: we ship faster.', 'Trust: longer track record.'] }],
  });
  const bulletsNode = tree.sections.find(s => s.type === 'bullets');
  assert.ok(bulletsNode, 'expected a bullets node');
  assert.deepEqual(bulletsNode.items, ['Speed: we ship faster.', 'Trust: longer track record.']);
});

test("Riley' document shape: mixed paragraph/table/bullets sections all build, render docx and markdown without throwing", async () => {
  const content = {
    ...BASE,
    report_sections: [
      { heading: 'Overview', body: 'Plain narrative paragraph.' },
      { heading: 'Vulnerabilities', type: 'table', body: { header: ['#', 'Vulnerability', 'Severity', 'Commercial Consequence'], rows: [['1', 'Pricing opacity', 'High', 'Lost deals']] } },
      { heading: 'Competitive Benchmark', type: 'table', body: { header: ['Competitor', 'Organising Principle', 'What They Hold That We Do Not'], rows: [['Acme', 'Speed', 'Faster onboarding']] } },
      { heading: 'Where We Are Winning', type: 'bullets', body: ['Point one.', 'Point two.'] },
    ],
  };
  const { tree } = build('_common', 'multipage-report', content);
  assert.equal(tree.sections.filter(s => s.type === 'table').length, 2);
  assert.equal(tree.sections.filter(s => s.type === 'bullets').length, 1);
  const md = renderMarkdown(tree);
  assert.ok(md.includes('Pricing opacity'));
  const docxBuf = await renderDocx(tree);
  assert.ok(Buffer.isBuffer(docxBuf) && docxBuf.length > 1000);
});

// FN26082604: a "**bold** lead-in, then plain explanation" bullet must
// render as a real bold run in the .docx, not literal asterisks.
test('a bullet item with a **bold** lead-in renders as separate bold/plain runs in the docx', async () => {
  const { tree } = build('_common', 'multipage-report', {
    ...BASE,
    report_sections: [
      { heading: 'Where We Are Winning', type: 'bullets', body: ['**Speed:** we ship faster than any competitor.'] },
    ],
  });
  const docxBuf = await renderDocx(tree);
  const zip = await JSZip.loadAsync(docxBuf);
  const documentXml = await zip.file('word/document.xml').async('string');
  assert.ok(!documentXml.includes('**Speed:**'), 'literal asterisks must not survive into the docx XML');
  assert.match(documentXml, /<w:b\/>[\s\S]*?Speed:/, 'expected a bold run wrapping the "Speed:" lead-in');
  assert.ok(documentXml.includes('we ship faster than any competitor.'), 'plain explanation text must still be present');
});

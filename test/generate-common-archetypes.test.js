'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { build } = require('../lib/generate/doc-builder');
const { renderMarkdown } = require('../lib/generate/render-markdown');
const { renderDocx } = require('../lib/generate/render-docx');
const { filename } = require('../lib/generate/naming');
const { getArchetype, listArchetypes } = require('../lib/generate/registry');

const BRIEF = {
  subject_id: 'wamca-mailbox', audience: 'alex', title: 'Mailbox Provisioning Brief',
  date_readable: '17 Aug 2026', version: '1.0.0', author: 'Architect',
  decision_ask: 'Approve the mailbox provisioning plan for WAMCA staff.',
  context_paragraphs: ['WAMCA needs provisioned mailboxes ahead of the September rollout.'],
  options: [{ option: 'Provision via M365 admin center', detail: 'Manual, ~2h for 12 mailboxes' },
            { option: 'Provision via Graph API script', detail: 'Automated, reusable for future hires' }],
  recommendation: 'Provision via Graph API script - reusable and auditable.',
  risks: ['Requires an app registration with Mail.ReadWrite scope.'],
  approval_name: 'Alex Rivera', approval_role: 'WAMCA Operations Lead',
};

const CATALOGUE = {
  catalogue_id: 'b2b-portal', scope_name: 'viva-b2b-use-case', title: 'B2B Portal Use Case Seed Data',
  date_readable: '17 Aug 2026', version: '1.0.0', author: 'Architect',
  description_paragraphs: ['Sample records for the portal deal-flow demo.'],
  entries: [
    { category: 'Company', field: 'legal_name', example_value: 'Acme Manufacturing Ltd', notes: 'Free text' },
    { category: 'Deal', field: 'stage', example_value: 'qualified', notes: 'Enum' },
  ],
};

test('decision-brief builds a valid markdown document with options, risks, and an approval table', () => {
  const { tree } = build('_common', 'decision-brief', BRIEF);
  const md = renderMarkdown(tree);
  assert.match(md, /^# Mailbox Provisioning Brief/);
  assert.match(md, /Approve the mailbox provisioning plan/);
  assert.match(md, /Provision via Graph API script/);
  assert.match(md, /Alex Rivera/);
});

test('decision-brief refuses to build with a required field missing', () => {
  const bad = { ...BRIEF, recommendation: undefined };
  assert.throws(() => build('_common', 'decision-brief', bad), /missing required field: recommendation/);
});

test('decision-brief renders a valid .docx package', async () => {
  const { tree } = build('_common', 'decision-brief', BRIEF);
  const buf = await renderDocx(tree);
  assert.equal(buf.slice(0, 2).toString(), 'PK');
});

test('decision-brief resolves from the _common namespace regardless of caller namespace', () => {
  const a = getArchetype('viva-valentia', 'decision-brief'); // falls back to _common
  assert.equal(a.id, 'decision-brief');
});

test('seed-data-catalogue builds a table of entries', () => {
  const { tree } = build('_common', 'seed-data-catalogue', CATALOGUE);
  const md = renderMarkdown(tree);
  assert.match(md, /^# B2B Portal Use Case Seed Data/);
  assert.match(md, /Acme Manufacturing Ltd/);
  assert.match(md, /qualified/);
});

test('seed-data-catalogue refuses an empty entries list', () => {
  assert.throws(() => build('_common', 'seed-data-catalogue', { ...CATALOGUE, entries: [] }), /entries must have at least one row/);
});

test('seed-data-catalogue renders a valid .docx package', async () => {
  const { tree } = build('_common', 'seed-data-catalogue', CATALOGUE);
  const buf = await renderDocx(tree);
  assert.equal(buf.slice(0, 2).toString(), 'PK');
});

test('listArchetypes includes each archetype\'s form field schema, for a UI to render a content form', () => {
  const list = listArchetypes('_common');
  const brief = list.find(a => a.id === 'decision-brief');
  assert.ok(brief);
  assert.ok(Array.isArray(brief.fields) && brief.fields.length > 0);
  assert.deepEqual(brief.filenameFields, { primary: 'subject_id', secondary: 'audience' });
  const decisionAskField = brief.fields.find(f => f.name === 'decision_ask');
  assert.equal(decisionAskField.type, 'text');
  assert.equal(decisionAskField.required, true);
});

test('filename() uses each archetype declared primary/secondary slots', () => {
  const briefArchetype = getArchetype('_common', 'decision-brief');
  const f = filename(briefArchetype, BRIEF, { version: '1.0.0', date: '2026-08-17', ext: 'docx' });
  assert.equal(f, 'wamca-mailbox_alex_v1_0_0_20260817.docx');
});

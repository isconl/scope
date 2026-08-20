'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGenerateClient } = require('../lib/generate/generate-client');

test('generate() writes to disk by default when a server-side outputRoot is configured', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-'));
  const client = createGenerateClient({ outputRoot });
  const r = await client.generate({
    namespace: '_common', archetypeId: 'decision-brief',
    content: { subject_id: 'sub', audience: 'alex', title: 'T', date_readable: 'today', version: '0.1.0',
      decision_ask: 'D', context_paragraphs: ['c'], recommendation: 'R', approval_name: 'Alex', approval_role: 'Director' },
    formats: ['md'],
  });
  assert.ok(r.written, 'expected a write to have happened without the caller passing write:true');
  assert.ok(fs.existsSync(r.written.files.md));
});

test('generate() never writes when no outputRoot is configured anywhere (existing test-style callers stay untouched)', async () => {
  const client = createGenerateClient({});
  const r = await client.generate({
    namespace: '_common', archetypeId: 'decision-brief',
    content: { subject_id: 'sub', audience: 'alex', title: 'T', date_readable: 'today', version: '0.1.0',
      decision_ask: 'D', context_paragraphs: ['c'], recommendation: 'R', approval_name: 'Alex', approval_role: 'Director' },
    formats: ['md'],
  });
  assert.equal(r.written, null);
});

test('generate() calls docsRegistry.recordGenerated with the target fields when a write happens', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-'));
  let recorded = null;
  const docsRegistry = { recordGenerated: async (p) => { recorded = p; return 'GD0001'; } };
  const client = createGenerateClient({ outputRoot, docsRegistry });
  const r = await client.generate({
    namespace: '_common', archetypeId: 'decision-brief', targetKind: 'project', targetId: 'p1', targetLabel: 'Project One',
    content: { subject_id: 'sub', audience: 'alex', title: 'T', date_readable: 'today', version: '0.1.0',
      decision_ask: 'D', context_paragraphs: ['c'], recommendation: 'R', approval_name: 'Alex', approval_role: 'Director' },
    formats: ['md'],
  });
  assert.equal(r.docId, 'GD0001');
  assert.equal(recorded.targetKind, 'project');
  assert.equal(recorded.targetId, 'p1');
  assert.equal(recorded.targetLabel, 'Project One');
});

test('generate() with write:false explicitly skips writing even when an outputRoot is configured', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-'));
  const client = createGenerateClient({ outputRoot });
  const r = await client.generate({
    namespace: '_common', archetypeId: 'decision-brief', write: false,
    content: { subject_id: 'sub', audience: 'alex', title: 'T', date_readable: 'today', version: '0.1.0',
      decision_ask: 'D', context_paragraphs: ['c'], recommendation: 'R', approval_name: 'Alex', approval_role: 'Director' },
    formats: ['md'],
  });
  assert.equal(r.written, null);
});

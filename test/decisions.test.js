'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDecisionsClient } = require('../lib/decisions');

function makeReadTSV(seed) {
  return (rel) => (seed[rel] || []).slice();
}

test('createDecisionsClient throws without readTSV', () => {
  assert.throws(() => createDecisionsClient({}));
});

test('listDecisions marks a PENDING decision stale once every citing task is delivered', async () => {
  const client = createDecisionsClient({
    readTSV: makeReadTSV({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'Ship per D-030', STATUS: 'done' }] }),
    getCareerContext: async () => ({ decisions: [{ id: 'D-030', status: 'PENDING', date: '2026-01-01' }], risks: [], orgName: 'Acme' }),
  });
  const r = await client.listDecisions();
  assert.equal(r.decisions[0].stale, true);
  assert.deepEqual(r.stale, ['D-030']);
});

test('listDecisions does not mark a PENDING decision stale while a citing task is still open', async () => {
  const client = createDecisionsClient({
    readTSV: makeReadTSV({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'Ship per D-030', STATUS: 'today' }] }),
    getCareerContext: async () => ({ decisions: [{ id: 'D-030', status: 'PENDING' }], risks: [] }),
  });
  const r = await client.listDecisions();
  assert.equal(r.decisions[0].stale, false);
});

test('listDecisions flags aging only once a PENDING decision is 5+ days old', async () => {
  const old = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
  const recent = new Date(Date.now() - 1 * 864e5).toISOString().slice(0, 10);
  const client = createDecisionsClient({
    readTSV: makeReadTSV({}),
    getCareerContext: async () => ({ decisions: [
      { id: 'D-001', status: 'PENDING', date: old },
      { id: 'D-002', status: 'PENDING', date: recent },
    ], risks: [] }),
  });
  const r = await client.listDecisions();
  assert.ok(r.decisions[0].aging >= 5);
  assert.equal(r.decisions[1].aging, null);
});

test('listDecisions passes through the risk register alongside decisions', async () => {
  const client = createDecisionsClient({
    readTSV: makeReadTSV({}),
    getCareerContext: async () => ({ decisions: [], risks: [{ id: 'R-1', title: 'Key person risk', severity: 'high' }], orgName: 'Acme' }),
  });
  const r = await client.listDecisions();
  assert.equal(r.risks[0].id, 'R-1');
  assert.equal(r.org, 'Acme');
});

test('updateDecision rejects a malformed id', async () => {
  const client = createDecisionsClient({ readTSV: makeReadTSV({}) });
  await assert.rejects(() => client.updateDecision({ id: 'not-an-id' }));
});

test('updateDecision throws when no org is active', async () => {
  const client = createDecisionsClient({ readTSV: makeReadTSV({}), getActiveOrgId: async () => null });
  await assert.rejects(() => client.updateDecision({ id: 'D-030', status: 'CLOSED' }));
});

test('updateDecision appends a new block in the file\'s own shape when the id is not found', async () => {
  let written = null;
  const client = createDecisionsClient({
    readTSV: makeReadTSV({}),
    getActiveOrgId: async () => 'acme',
    readCareerFile: async () => 'decisions:\n',
    writeCareerFile: async (rel, content) => { written = { rel, content }; },
  });
  const r = await client.updateDecision({ id: 'D-030', decision: 'Adopt rclone', status: 'OPEN', by: 'architect' });
  assert.equal(r.created, true);
  assert.equal(written.rel, 'career/orgs/acme/decision_log.yaml');
  assert.match(written.content, /id: D-030/);
  assert.match(written.content, /decision: Adopt rclone/);
});

test('updateDecision refuses to create a new block without a decision text', async () => {
  const client = createDecisionsClient({
    readTSV: makeReadTSV({}),
    getActiveOrgId: async () => 'acme',
    readCareerFile: async () => 'decisions:\n',
  });
  await assert.rejects(() => client.updateDecision({ id: 'D-030', status: 'OPEN' }));
});

test('updateDecision edits an existing block in place via line-surgery, preserving surrounding content', async () => {
  const before = [
    'decisions:',
    '  - id: D-001',
    '    date: "2026-01-01"',
    '    decision: Use rclone',
    '    status: OPEN',
    '    by: architect',
    '    note: -',
    '  - id: D-002',
    '    date: "2026-01-02"',
    '    decision: Two-tier index',
    '    status: OPEN',
    '    by: architect',
    '    note: -',
  ].join('\n');
  let written = null;
  const client = createDecisionsClient({
    readTSV: makeReadTSV({}),
    getActiveOrgId: async () => 'acme',
    readCareerFile: async () => before,
    writeCareerFile: async (rel, content) => { written = content; },
  });
  const r = await client.updateDecision({ id: 'D-001', status: 'CLOSED', appendNote: 'confirmed working' });
  assert.equal(r.created, false);
  assert.match(written, /id: D-001[\s\S]*?status: CLOSED/);
  assert.match(written, /note: - confirmed working/);
  // D-002's block must survive untouched.
  assert.match(written, /id: D-002[\s\S]*?decision: Two-tier index/);
});

test('updateDecision keeps the previous version before writing', async () => {
  let keptWith = null;
  const client = createDecisionsClient({
    readTSV: makeReadTSV({}),
    getActiveOrgId: async () => 'acme',
    readCareerFile: async () => '  - id: D-001\n    status: OPEN\n',
    writeCareerFile: async () => {},
    keepPreviousVersion: async (rel, contents, why) => { keptWith = { rel, why }; },
  });
  await client.updateDecision({ id: 'D-001', status: 'CLOSED' });
  assert.equal(keptWith.rel, 'career/orgs/acme/decision_log.yaml');
  assert.equal(keptWith.why, 'decision-update');
});

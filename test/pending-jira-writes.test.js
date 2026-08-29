'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPendingJiraWritesClient } = require('../lib/pending-jira-writes');

function makeStore() {
  const db = new Map();
  return {
    async readTSV(p) { return (db.get(p) || []).slice(); },
    async appendTSV(p, row) { const a = db.get(p) || []; db.set(p, [...a, row]); },
    async rewriteTSV(p, fn) { db.set(p, fn(db.get(p) || [])); },
    auditLog: { log() {} },
  };
}

test('createPendingJiraWritesClient throws without appendTSV/readTSV/rewriteTSV', () => {
  assert.throws(() => createPendingJiraWritesClient({}));
});

test('enqueue writes a pending row and returns {queued:true, id}', async () => {
  const store = makeStore();
  const client = createPendingJiraWritesClient(store);
  const r = await client.enqueue({ action: 'createIssue', payload: { summary: 'Ship the gate', duedate: '2026-09-01' }, requester: 'agent-test' });
  assert.ok(r.queued);
  assert.ok(r.id.startsWith('PJ'));
  assert.ok(r.pendingApproval);

  const pending = await client.listPending({ status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].action, 'createIssue');
  assert.equal(pending[0].status, 'pending');
  assert.equal(pending[0].requester, 'agent-test');
  assert.deepEqual(pending[0].payload, { summary: 'Ship the gate', duedate: '2026-09-01' });
});

test('enqueue requires an action', async () => {
  const store = makeStore();
  const client = createPendingJiraWritesClient(store);
  await assert.rejects(() => client.enqueue({ payload: {} }), /action is required/);
});

test('deny marks the row denied, no Jira call fires', async () => {
  const store = makeStore();
  const client = createPendingJiraWritesClient(store);
  const { id } = await client.enqueue({ action: 'createIssue', payload: {} });
  const r = await client.deny({ id, decidedBy: 'Architect' });
  assert.ok(r.success);
  assert.ok(r.denied);

  const allRows = await client.listPending();
  assert.equal(allRows[0].status, 'denied');
  assert.equal(allRows[0].decidedBy, 'Architect');
});

test('deny throws for an unknown id', async () => {
  const store = makeStore();
  const client = createPendingJiraWritesClient(store);
  await assert.rejects(() => client.deny({ id: 'notexist' }), /not found/);
});

test('deny throws if the row is already resolved', async () => {
  const store = makeStore();
  const client = createPendingJiraWritesClient(store);
  const { id } = await client.enqueue({ action: 'createIssue', payload: {} });
  await client.deny({ id });
  await assert.rejects(() => client.deny({ id }), /already denied/);
});

test('approve returns error gracefully when jira client is not configured', async () => {
  const store = makeStore();
  const client = createPendingJiraWritesClient({ ...store, jira: null });
  const { id } = await client.enqueue({ action: 'createIssue', payload: {} });
  const r = await client.approve({ id, decidedBy: 'Architect' });
  assert.equal(r.success, false);
  assert.match(r.error, /not configured/);

  const allRows = await client.listPending();
  assert.equal(allRows[0].status, 'error');
});

test('approve fires jira.jiraCreateIssue, marks row approved with RESULT_KEY on success', async () => {
  const store = makeStore();
  const mockJira = {
    jiraCreateIssue: async (summary) => ({ key: `WSRU-${Math.floor(Math.random() * 999)}` }),
  };
  const client = createPendingJiraWritesClient({ ...store, jira: mockJira });
  const { id } = await client.enqueue({ action: 'createIssue', payload: { summary: 'Build the approval gate' } });
  const r = await client.approve({ id, decidedBy: 'Architect' });
  assert.ok(r.success);
  assert.match(r.key, /^WSRU-/);

  const allRows = await client.listPending();
  assert.equal(allRows[0].status, 'approved');
  assert.equal(allRows[0].decidedBy, 'Architect');
  assert.match(allRows[0].resultKey, /^WSRU-/);
});

test('approve surfaces a Jira API error as success:false, marks row error', async () => {
  const store = makeStore();
  const mockJira = {
    jiraCreateIssue: async () => ({ error: 'Field validation failed' }),
  };
  const client = createPendingJiraWritesClient({ ...store, jira: mockJira });
  const { id } = await client.enqueue({ action: 'createIssue', payload: { summary: 'Bad issue' } });
  const r = await client.approve({ id });
  assert.equal(r.success, false);
  assert.match(r.error, /validation/);
  const allRows = await client.listPending();
  assert.equal(allRows[0].status, 'error');
});

test('listPending filters by status correctly', async () => {
  const store = makeStore();
  const client = createPendingJiraWritesClient(store);
  const { id: id1 } = await client.enqueue({ action: 'createIssue', payload: { summary: 'First' } });
  await client.enqueue({ action: 'createIssue', payload: { summary: 'Second' } });
  await client.deny({ id: id1 });

  const pending = await client.listPending({ status: 'pending' });
  const denied = await client.listPending({ status: 'denied' });
  assert.equal(pending.length, 1);
  assert.equal(denied.length, 1);
  assert.equal(denied[0].action, 'createIssue');
});

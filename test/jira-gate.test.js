'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createJiraGateClient, jiraReadiness } = require('../lib/jira-gate');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: async (rel) => (data[rel] || []).slice(),
    rewriteTSV: async (rel, fn) => { data[rel] = fn((data[rel] || []).slice()); return data[rel].length; },
  };
}

function fakeJira(overrides = {}) {
  return {
    jiraAssignableUsers: async () => [],
    jiraAPI: async () => ({ data: { permissions: { DELETE_ISSUES: { havePermission: false } } } }),
    jiraCreateIssue: async () => ({ key: 'WSRU-1' }),
    ...overrides,
  };
}

const cfg = () => ({ host: 'x.atlassian.net', email: 'me@x.com', token: 't', projectKey: 'WSRU' });

test('createJiraGateClient throws without readTSV/rewriteTSV/jira/getConfig', () => {
  assert.throws(() => createJiraGateClient({}));
  assert.throws(() => createJiraGateClient({ readTSV: () => [], rewriteTSV: () => {} }));
});

test('jiraReadiness flags a thin summary, missing description/date/tag/assignee', () => {
  const checks = jiraReadiness({ TAG: '-' }, { summary: 'x' }, []);
  assert.equal(checks.find(c => c.id === 'summary').ok, false);
  assert.equal(checks.find(c => c.id === 'description').ok, false);
  assert.equal(checks.find(c => c.id === 'duedate').ok, false);
  assert.equal(checks.find(c => c.id === 'tag').ok, false);
  assert.equal(checks.find(c => c.id === 'assignee').ok, false);
});

test('jiraReadiness passes a fully-specified payload', () => {
  const tags = [{ id: 'work', label: 'Work' }];
  const checks = jiraReadiness({ TAG: 'work' },
    { summary: 'Ship the release notes', description: 'x'.repeat(40), duedate: '2026-01-01', assignee: 'acc1' }, tags);
  assert.ok(checks.every(c => c.ok));
});

test('preview throws for an unknown task', async () => {
  const store = makeStore();
  const gate = createJiraGateClient({ ...store, jira: fakeJira(), getConfig: cfg });
  await assert.rejects(() => gate.preview('nope'));
});

test('preview builds a payload from the task row, falling back to medium priority', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'Fix the build', PRIORITY: '-', TAG: '-' }] });
  const gate = createJiraGateClient({ ...store, jira: fakeJira(), getConfig: cfg });
  const r = await gate.preview('T1');
  assert.equal(r.payload.priority, 'medium');
  assert.equal(r.payload.summary, 'Fix the build');
  assert.equal(r.canDelete, false);
});

test('preview picks the caller as assignee when their email matches a Jira assignable user', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'x', ASSIGNEE: '-' }] });
  const gate = createJiraGateClient({ ...store,
    jira: fakeJira({ jiraAssignableUsers: async () => [{ accountId: 'acc1', email: 'me@x.com' }] }),
    getConfig: cfg,
  });
  const r = await gate.preview('T1');
  assert.equal(r.payload.assignee, 'acc1');
});

test('preview reports alreadyPushed when the task already carries a Jira key', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'x', JIRA_KEY: 'WSRU-9' }] });
  const gate = createJiraGateClient({ ...store, jira: fakeJira(), getConfig: cfg });
  const r = await gate.preview('T1');
  assert.equal(r.alreadyPushed, 'WSRU-9');
});

test('push refuses a task already on the board', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'x', JIRA_KEY: 'WSRU-9' }] });
  const gate = createJiraGateClient({ ...store, jira: fakeJira(), getConfig: cfg });
  await assert.rejects(() => gate.push({ taskId: 'T1' }));
});

test('push is blocked (409-shaped response, not thrown) when readiness checks fail and force is not set', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'x', TAG: '-', JIRA_KEY: '-' }] });
  const gate = createJiraGateClient({ ...store, jira: fakeJira(), getConfig: cfg });
  const r = await gate.push({ taskId: 'T1', summary: 'too short' });
  assert.equal(r.blocked, true);
  assert.ok(r.ready.some(c => !c.ok));
});

test('push proceeds despite failing checks when force:true is set', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'x', TAG: '-', JIRA_KEY: '-' }] });
  const gate = createJiraGateClient({ ...store, jira: fakeJira(), getConfig: cfg });
  const r = await gate.push({ taskId: 'T1', summary: 'too short', force: true });
  assert.equal(r.success, true);
  assert.equal(r.key, 'WSRU-1');
});

test('push creates the issue and mirrors the key/summary/due/assignee back onto the local row', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'old', TAG: 'work', JIRA_KEY: '-', DUE_DATE: '-' }] });
  const gate = createJiraGateClient({ ...store, jira: fakeJira(), getConfig: cfg, tagVocabulary: () => [{ id: 'work', label: 'Work' }] });
  const r = await gate.push({
    taskId: 'T1', summary: 'Ship the release notes', description: 'x'.repeat(40),
    duedate: '2026-01-01', assignee: 'acc1', labels: ['work'],
  });
  assert.equal(r.success, true);
  const row = store.data['scope/tasks.tsv'][0];
  assert.equal(row.JIRA_KEY, 'WSRU-1');
  assert.equal(row.TITLE, 'Ship the release notes');
  assert.equal(row.DUE_DATE, '2026-01-01');
  assert.equal(row.ASSIGNEE, 'acc1');
});

test('push reports failure without throwing when Jira rejects the create', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'x', TAG: 'work', JIRA_KEY: '-' }] });
  const gate = createJiraGateClient({ ...store,
    jira: fakeJira({ jiraCreateIssue: async () => ({ error: 'project archived' }) }),
    getConfig: cfg,
  });
  const r = await gate.push({ taskId: 'T1', summary: 'Ship the release notes', description: 'x'.repeat(40), duedate: '2026-01-01', assignee: 'a', force: true });
  assert.equal(r.success, false);
  assert.match(r.error, /project archived/);
});

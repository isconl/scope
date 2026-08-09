'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTasksClient } = require('../lib/tasks');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: (rel) => (data[rel] || []).slice(),
    appendTSV: (rel, row) => { (data[rel] = data[rel] || []).push(row); },
    rewriteTSV: (rel, fn) => {
      const before = (data[rel] || []).length;
      data[rel] = fn((data[rel] || []).slice());
      return before - data[rel].length;
    },
  };
}

function fakeJira(overrides = {}) {
  return {
    jiraCreateIssue: async () => ({ key: 'WSRU-1' }),
    jiraUpdateIssue: async () => ({ success: true }),
    jiraAssignIssue: async () => ({ success: true }),
    jiraTransitionIssue: async () => ({ success: true }),
    jiraDeleteIssue: async () => ({ success: true, verified: true }),
    ...overrides,
  };
}

test('createTasksClient throws without readTSV/appendTSV/rewriteTSV', () => {
  assert.throws(() => createTasksClient({}));
});

test('createTask defaults status/priority and stores an untitled fallback', async () => {
  const store = makeStore();
  const client = createTasksClient({ ...store });
  const { task } = await client.createTask({});
  assert.equal(task.TITLE, 'Untitled');
  assert.equal(task.STATUS, 'today');
  assert.equal(task.PRIORITY, 'medium');
});

test('createTask creates a Jira issue and persists the key when jira is configured', async () => {
  const store = makeStore();
  const client = createTasksClient({ ...store, jira: fakeJira() });
  const { task, jira } = await client.createTask({ title: 'Ship it' });
  assert.equal(task.JIRA_KEY, 'WSRU-1');
  assert.equal(jira.key, 'WSRU-1');
});

test('createTask skips Jira when syncJira:false or jira is not configured', async () => {
  const store = makeStore();
  const client = createTasksClient({ ...store, jira: fakeJira() });
  const { task } = await client.createTask({ title: 'x', syncJira: false });
  assert.equal(task.JIRA_KEY, '-');

  const clientNoJira = createTasksClient({ ...makeStore() });
  const { task: t2 } = await clientNoJira.createTask({ title: 'y' });
  assert.equal(t2.JIRA_KEY, '-');
});

test('createTask with a parentId attaches as a subtask and stays local (no Jira sync)', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'Parent', PARENT_ID: '-' }] });
  const client = createTasksClient({ ...store, jira: fakeJira() });
  const { task } = await client.createTask({ title: 'Child', parentId: 'T1' });
  assert.equal(task.PARENT_ID, 'T1');
  assert.equal(task.JIRA_KEY, '-');
});

test('createTask refuses a two-level-deep subtask', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'Parent', PARENT_ID: '-' }, { ID: 'T2', TITLE: 'Child', PARENT_ID: 'T1' }] });
  const client = createTasksClient({ ...store });
  await assert.rejects(() => client.createTask({ title: 'Grandchild', parentId: 'T2' }));
});

test('createTask rejects an unknown parentId', async () => {
  const client = createTasksClient({ ...makeStore() });
  await assert.rejects(() => client.createTask({ title: 'x', parentId: 'nope' }));
});

test('updateTask validates priority/status/title and rejects bad values', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'x', STATUS: 'today', PRIORITY: 'medium' }] });
  const client = createTasksClient({ ...store });
  await assert.rejects(() => client.updateTask({ taskId: 'T1', priority: 'urgent' }));
  await assert.rejects(() => client.updateTask({ taskId: 'T1', status: 'archived' }));
  await assert.rejects(() => client.updateTask({ taskId: 'T1', title: '   ' }));
});

test('updateTask returns null for an unknown task', async () => {
  const client = createTasksClient({ ...makeStore() });
  const r = await client.updateTask({ taskId: 'nope', title: 'x' });
  assert.equal(r, null);
});

test('updateTask stamps DONE_AT on completion and clears it on reopen', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'x', STATUS: 'today', DONE_AT: '-' }] });
  const client = createTasksClient({ ...store });
  const r1 = await client.updateTask({ taskId: 'T1', status: 'done' });
  assert.notEqual(r1.task.DONE_AT, '-');
  const r2 = await client.updateTask({ taskId: 'T1', status: 'next' });
  assert.equal(r2.task.DONE_AT, '-');
});

test('updateTask mirrors a title change to a linked Jira issue', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'old', JIRA_KEY: 'WSRU-1' }] });
  let updateCalled = null;
  const client = createTasksClient({ ...store, jira: fakeJira({ jiraUpdateIssue: async (key, fields) => { updateCalled = { key, fields }; return { success: true }; } }) });
  await client.updateTask({ taskId: 'T1', title: 'new title' });
  assert.equal(updateCalled.key, 'WSRU-1');
  assert.equal(updateCalled.fields.summary, 'new title');
});

test('updateTask calls a Jira transition (not a field write) when status becomes done', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'x', JIRA_KEY: 'WSRU-1' }] });
  const transitions = [];
  const client = createTasksClient({ ...store, jira: fakeJira({ jiraTransitionIssue: async (key, name) => { transitions.push(name); return { success: true }; } }) });
  await client.updateTask({ taskId: 'T1', status: 'done' });
  assert.deepEqual(transitions, ['Done']);
});

test('deleteTask deletes the linked Jira issue first, and keeps the local row if that fails', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'x', JIRA_KEY: 'WSRU-1' }] });
  const client = createTasksClient({ ...store, jira: fakeJira({ jiraDeleteIssue: async () => ({ success: false, error: 'permission denied' }) }) });
  const r = await client.deleteTask({ taskId: 'T1' });
  assert.equal(r.failed, true);
  assert.equal(store.data['scope/tasks.tsv'].length, 1, 'local row kept when Jira delete fails');
});

test('deleteTask removes the local row when the Jira delete succeeds (or there is no linked issue)', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'x', JIRA_KEY: '-' }] });
  const client = createTasksClient({ ...store });
  const r = await client.deleteTask({ taskId: 'T1' });
  assert.equal(r.failed, false);
  assert.equal(store.data['scope/tasks.tsv'].length, 0);
});

test('deleteTask returns null for an unknown task', async () => {
  const client = createTasksClient({ ...makeStore() });
  const r = await client.deleteTask({ taskId: 'nope' });
  assert.equal(r, null);
});

test('completeTask with target:review transitions to a review-shaped Jira column, not Done', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'x', JIRA_KEY: 'WSRU-1', STATUS: 'today', DONE_AT: '-' }] });
  const transitions = [];
  const client = createTasksClient({ ...store, jira: fakeJira({ jiraTransitionIssue: async (key, name) => { transitions.push(name); return { success: name === 'In Review' }; } }) });
  const r = await client.completeTask({ taskId: 'T1', target: 'review' });
  assert.equal(r.target, 'review');
  assert.equal(transitions[0], 'In Review');
  assert.equal(store.data['scope/tasks.tsv'][0].DONE_AT, '-');
});

test('completeTask stamps DONE_AT and syncs to Done for target:done', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'x', JIRA_KEY: 'WSRU-1', STATUS: 'today', DONE_AT: '-' }] });
  const client = createTasksClient({ ...store, jira: fakeJira() });
  const r = await client.completeTask({ taskId: 'T1', target: 'done' });
  assert.notEqual(store.data['scope/tasks.tsv'][0].DONE_AT, '-');
  assert.equal(r.jira.success, true);
});

test('completeTask rejects an invalid target', async () => {
  const client = createTasksClient({ ...makeStore() });
  await assert.rejects(() => client.completeTask({ taskId: 'T1', target: 'archived' }));
});

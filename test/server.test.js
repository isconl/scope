'use strict';
/**
 * End-to-end smoke tests: start scope's real HTTP server and hit it with
 * real requests -- same purpose as vault's and pulse's own server.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpEnv() {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-e2e-memory-'));
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-e2e-logs-'));
  fs.mkdirSync(path.join(memoryDir, 'scope'), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'scope', 'tasks.tsv'),
    'ID\tTITLE\tSTATUS\tPRIORITY\tPROJECT_ID\tCARRY_FWD\tDUE_DATE\tCREATED_AT\tJIRA_KEY\tTAG\tPARENT_ID\tDONE_AT\tSTART_DATE\tASSIGNEE\n');
  return { memoryDir, logsDir };
}

async function startServer(envOverrides = {}) {
  const { memoryDir, logsDir } = tmpEnv();
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    SCOPE_PORT: '0',
    SCOPE_BIND: '127.0.0.1',
    SCOPE_MEMORY_DIR: memoryDir,
    SCOPE_LOGS_DIR: logsDir,
    SCOPE_TOKEN: 'test-static-token',
    BWS_ACCESS_TOKEN: '',
    JIRA_HOST: '', JIRA_EMAIL: '', JIRA_PROJECT: '',
    ...envOverrides,
  });
  delete require.cache[require.resolve('../src/server')];
  const { main } = require('../src/server');
  const handle = await main();
  const cleanup = () => {
    Object.keys(process.env).forEach(k => { if (!(k in savedEnv)) delete process.env[k]; });
    Object.assign(process.env, savedEnv);
  };
  return { ...handle, cleanup };
}

test('GET /health responds without auth', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).engine, 'scope');
  } finally { server.close(); cleanup(); }
});

test('GET /manifest lists scope\'s capabilities without auth', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/manifest`);
    const body = await res.json();
    assert.ok(body.capabilities.some(c => c.name === 'tasks.create'));
  } finally { server.close(); cleanup(); }
});

test('a protected route with no credential fails closed (silent 404)', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/tasks`);
    assert.equal(res.status, 404);
  } finally { server.close(); cleanup(); }
});

test('tasks: create, then list, then update, then complete', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    const create = await fetch(`http://127.0.0.1:${port}/tasks`, { method: 'POST', headers: auth,
      body: JSON.stringify({ title: 'Ship the release notes', priority: 'high' }) });
    assert.equal(create.status, 201);
    const { task } = await create.json();
    assert.equal(task.JIRA_KEY, '-', 'no Jira configured in this test env -- stays local only');

    const list = await fetch(`http://127.0.0.1:${port}/tasks`, { headers: auth });
    assert.equal((await list.json()).tasks.length, 1);

    const update = await fetch(`http://127.0.0.1:${port}/tasks/update`, { method: 'POST', headers: auth,
      body: JSON.stringify({ taskId: task.ID, priority: 'low' }) });
    const updateBody = await update.json();
    assert.equal(updateBody.task.PRIORITY, 'low');

    const done = await fetch(`http://127.0.0.1:${port}/tasks/done`, { method: 'POST', headers: auth,
      body: JSON.stringify({ taskId: task.ID, target: 'done' }) });
    const doneBody = await done.json();
    assert.equal(doneBody.success, true);

    const get = await fetch(`http://127.0.0.1:${port}/tasks/${task.ID}`, { headers: auth });
    const getBody = await get.json();
    assert.equal(getBody.task.STATUS, 'done');
  } finally { server.close(); cleanup(); }
});

test('tasks: delete removes the row and 404s on a repeat delete', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    const create = await fetch(`http://127.0.0.1:${port}/tasks`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'x' }) });
    const { task } = await create.json();

    const del = await fetch(`http://127.0.0.1:${port}/tasks/delete`, { method: 'POST', headers: auth, body: JSON.stringify({ taskId: task.ID }) });
    assert.equal(del.status, 200);

    const del2 = await fetch(`http://127.0.0.1:${port}/tasks/delete`, { method: 'POST', headers: auth, body: JSON.stringify({ taskId: task.ID }) });
    assert.equal(del2.status, 404);
  } finally { server.close(); cleanup(); }
});

test('jira/preview and jira/push degrade gracefully (not a crash) when Jira is not configured', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    const create = await fetch(`http://127.0.0.1:${port}/tasks`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Ship the release notes' }) });
    const { task } = await create.json();

    const preview = await fetch(`http://127.0.0.1:${port}/jira/preview`, { method: 'POST', headers: auth, body: JSON.stringify({ taskId: task.ID }) });
    assert.equal(preview.status, 200);
    const previewBody = await preview.json();
    assert.equal(previewBody.success, true);
    assert.equal(previewBody.host, null);

    const push = await fetch(`http://127.0.0.1:${port}/jira/push`, { method: 'POST', headers: auth,
      body: JSON.stringify({ taskId: task.ID, summary: 'x', force: true }) });
    const pushBody = await push.json();
    assert.equal(pushBody.success, false);
    assert.match(pushBody.error, /not fully configured|not set/i);
  } finally { server.close(); cleanup(); }
});

test('decisions: GET returns an empty log gracefully with no career vault configured', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token' };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/decisions`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.decisions, []);
  } finally { server.close(); cleanup(); }
});

test('decisions/update fails cleanly (400, not a crash) with no active org configured', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/decisions/update`, { method: 'POST', headers: auth,
      body: JSON.stringify({ id: 'D-001', status: 'CLOSED' }) });
    assert.equal(res.status, 400);
  } finally { server.close(); cleanup(); }
});

test('the audit log recorded requests made during this test run', async () => {
  const { server, port, auditLog, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    await fetch(`http://127.0.0.1:${port}/tasks`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'x' }) });
    const chain = auditLog.verifyChain();
    assert.equal(chain.ok, true);
  } finally { server.close(); cleanup(); }
});

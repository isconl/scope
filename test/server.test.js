'use strict';
/**
 * End-to-end smoke tests: start scope's real HTTP server, backed by a real
 * (fake, in-process) vault HTTP server for TSV data -- same shape as the
 * real GET/POST/PUT /vault/:collection contract, so this exercises the
 * actual remote-store wire format, not a shortcut.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

function startFakeVault(seed = {}) {
  const data = { ...seed };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const collection = decodeURIComponent(url.pathname.slice('/vault/'.length));
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET') {
          res.writeHead(200);
          return res.end(JSON.stringify({ collection, rows: data[collection] || [] }));
        }
        if (req.method === 'POST') {
          let row = {};
          try { row = JSON.parse(body || '{}'); } catch { /* ignore */ }
          (data[collection] = data[collection] || []).push(row);
          res.writeHead(200);
          return res.end(JSON.stringify({ ok: true, collection }));
        }
        if (req.method === 'PUT') {
          let rows = [];
          try { rows = JSON.parse(body || '{}').rows || []; } catch { /* ignore */ }
          const before = (data[collection] || []).length;
          data[collection] = rows;
          res.writeHead(200);
          return res.end(JSON.stringify({ ok: true, collection, count: rows.length, removed: before - rows.length }));
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not Found' }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, data, port: server.address().port }));
  });
}

function tmpEnv() {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-e2e-logs-'));
  return { logsDir };
}

async function startServer(envOverrides = {}, vaultSeed = {}) {
  const { logsDir } = tmpEnv();
  const vault = await startFakeVault({ 'scope/tasks.tsv': [], ...vaultSeed });
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    SCOPE_PORT: '0',
    SCOPE_BIND: '127.0.0.1',
    VAULT_URL: `http://127.0.0.1:${vault.port}`, VAULT_TOKEN: 'vault-test-token',
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
    vault.server.close();
  };
  return { ...handle, vault, cleanup };
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

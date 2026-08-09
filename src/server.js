#!/usr/bin/env node
'use strict';
/**
 * scope engine -- HTTP entry point. Same boot sequence/style as vault and pulse.
 */

const http = require('http');
const path = require('path');
const secretStore = require('../lib/secrets');
const { createAuditLog } = require('../lib/audit');
const { createStore } = require('../lib/store');
const { createJiraClient } = require('../lib/jira');
const { createTasksClient } = require('../lib/tasks');
const { createJiraGateClient } = require('../lib/jira-gate');
const { createDecisionsClient } = require('../lib/decisions');
const manifest = require('../lib/manifest');

const PORT = parseInt(process.env.SCOPE_PORT || process.env.PORT || '8083', 10);
const BIND = process.env.SCOPE_BIND || '127.0.0.1';
const VAULT_URL = process.env.VAULT_URL || '';
const LOGS_DIR = process.env.SCOPE_LOGS_DIR || path.join(__dirname, '..', 'runtime', 'logs');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function checkAuth(req) {
  const token = process.env.SCOPE_TOKEN || process.env.ISCONL_TOKEN || '';
  if (!token) return false;
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return provided.length === token.length && provided === token;
}

async function main() {
  const secretsResult = await secretStore.init();
  console.log(`  secrets: ${secretsResult.source}, ${secretsResult.count} key(s)`);

  const auditLog = createAuditLog({ logsDir: LOGS_DIR });
  if (!VAULT_URL) {
    console.error('  REFUSING TO START: VAULT_URL is not configured -- scope has no data store without it.');
    process.exit(1);
  }
  const store = createStore({
    baseUrl: VAULT_URL,
    getToken: () => process.env.VAULT_TOKEN || secretStore.get('VAULT_TOKEN') || '',
    auditLog,
  });
  const readTSV = store.read, appendTSV = store.append, rewriteTSV = store.rewrite;

  const getJiraConfig = () => ({
    host: process.env.JIRA_HOST || secretStore.get('JIRA_HOST') || '',
    email: process.env.JIRA_EMAIL || secretStore.get('JIRA_EMAIL') || '',
    token: secretStore.get('JIRA_API_TOKEN') || '',
    projectKey: process.env.JIRA_PROJECT || secretStore.get('JIRA_PROJECT') || '',
  });
  const jira = createJiraClient({ getConfig: getJiraConfig, auditLog });
  const jiraConfigured = () => { const c = getJiraConfig(); return !!(c.host && c.email && c.token); };

  // Snapshot at boot: secrets are loaded before the server starts accepting
  // requests, and a live Bitwarden refresh mid-run changing Jira's
  // configured-ness is rare enough not to chase here.
  const tasks = createTasksClient({
    readTSV, appendTSV, rewriteTSV, auditLog,
    jira: jiraConfigured() ? jira : null,
  });

  const jiraGate = createJiraGateClient({ readTSV, rewriteTSV, auditLog, jira, getConfig: getJiraConfig });

  const decisions = createDecisionsClient({ readTSV, auditLog });

  const tokenConfigured = !!(process.env.SCOPE_TOKEN || process.env.ISCONL_TOKEN);
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(BIND);
  if (!isLoopback && !tokenConfigured) {
    console.error('  REFUSING TO BIND: no SCOPE_TOKEN/ISCONL_TOKEN configured and BIND is not loopback.');
    process.exit(1);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    if (pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { status: 'ok', engine: 'scope', version: manifest.version });
    }
    if (pathname === '/manifest' && req.method === 'GET') {
      return sendJson(res, 200, manifest);
    }

    if (!checkAuth(req)) return sendJson(res, 404, { error: 'Not Found' });

    try {
      if (pathname === '/tasks' && req.method === 'GET') {
        return sendJson(res, 200, { tasks: await tasks.listTasks() });
      }
      if (pathname.startsWith('/tasks/') && req.method === 'GET' && !pathname.startsWith('/tasks/update') && !pathname.startsWith('/tasks/delete') && !pathname.startsWith('/tasks/done')) {
        const id = decodeURIComponent(pathname.slice('/tasks/'.length));
        const task = await tasks.getTask(id);
        if (!task) return sendJson(res, 404, { error: `Task ${id} not found` });
        return sendJson(res, 200, { task });
      }
      if (pathname === '/tasks' && req.method === 'POST') {
        const { task, jira: jiraResult } = await tasks.createTask(JSON.parse(await readBody(req) || '{}'));
        return sendJson(res, 201, { task, jira: jiraResult });
      }
      if (pathname === '/tasks/update' && req.method === 'POST') {
        const r = await tasks.updateTask(JSON.parse(await readBody(req) || '{}'));
        if (!r) return sendJson(res, 404, { success: false, error: 'Task not found' });
        return sendJson(res, 200, { success: true, ...r });
      }
      if (pathname === '/tasks/delete' && req.method === 'POST') {
        const r = await tasks.deleteTask(JSON.parse(await readBody(req) || '{}'));
        if (!r) return sendJson(res, 404, { success: false, error: 'Task not found' });
        if (r.failed) return sendJson(res, 502, { success: false, ...r });
        return sendJson(res, 200, { success: true, ...r });
      }
      if (pathname === '/tasks/done' && req.method === 'POST') {
        return sendJson(res, 200, { success: true, ...(await tasks.completeTask(JSON.parse(await readBody(req) || '{}'))) });
      }

      if (pathname === '/jira/preview' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await jiraGate.preview(p.taskId));
      }
      if (pathname === '/jira/push' && req.method === 'POST') {
        const r = await jiraGate.push(JSON.parse(await readBody(req) || '{}'));
        return sendJson(res, r.blocked ? 409 : (r.success ? 200 : 502), r);
      }

      if (pathname === '/decisions' && req.method === 'GET') {
        return sendJson(res, 200, await decisions.listDecisions());
      }
      if (pathname === '/decisions/update' && req.method === 'POST') {
        return sendJson(res, 200, await decisions.updateDecision(JSON.parse(await readBody(req) || '{}')));
      }
    } catch (e) {
      return sendJson(res, 400, { success: false, error: String(e.message || e) });
    }

    return sendJson(res, 404, { error: 'Not Found' });
  });

  return new Promise((resolve) => {
    server.listen(PORT, BIND, () => {
      const actualPort = server.address().port;
      console.log(`  scope listening on ${BIND}:${actualPort}`);
      resolve({ server, store, jira, tasks, jiraGate, decisions, auditLog, secretStore, port: actualPort });
    });
  });
}

if (require.main === module) {
  main().catch(e => { console.error('scope failed to start:', e); process.exit(1); });
}

module.exports = { main };

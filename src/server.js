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
const { createPlansClient } = require('../lib/plans');
const { createSurfacedTasksClient } = require('../lib/surfaced-tasks');
const { createCorporateClient } = require('../lib/corporate');
const { createGenerateClient } = require('../lib/generate/generate-client');
const { createDocsRegistryClient } = require('../lib/generate/docs-registry');
const manifest = require('../lib/manifest');
const httpLib = require('http');
const httpsLib = require('https');

const PORT = parseInt(process.env.SCOPE_PORT || process.env.PORT || '8083', 10);
const BIND = process.env.SCOPE_BIND || '127.0.0.1';
const VAULT_URL = process.env.VAULT_URL || '';
const CIRCLE_URL = process.env.CIRCLE_URL || '';
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
  const token = process.env.SCOPE_TOKEN || process.env.ISCONL_TOKEN || secretStore.get('SCOPE_TOKEN') || '';
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

  // Cross-engine: career context (org facts, decisions, risks, people,
  // doctrine) lives in circle (lib/career.js), served over HTTP at
  // GET /career -- see circle/src/server.js. Optional: if CIRCLE_URL
  // isn't configured, both decisions and corporate degrade to empty
  // rather than failing to boot, same fail-soft pattern as jiraConfigured.
  const getCareerContext = async () => {
    if (!CIRCLE_URL) return { activeOrg: null, orgName: null, orgs: [], people: [], decisions: [], risks: [], playbooks: [], doctrine: {}, available: false };
    const url = new URL('/career', CIRCLE_URL);
    const lib = url.protocol === 'https:' ? httpsLib : httpLib;
    const token = process.env.CIRCLE_TOKEN || secretStore.get('CIRCLE_TOKEN') || '';
    return new Promise((resolve) => {
      const req = lib.request(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolve(res.statusCode === 200 ? JSON.parse(raw) : { available: false, orgs: [] }); }
          catch { resolve({ available: false, orgs: [] }); }
        });
      });
      req.on('error', () => resolve({ available: false, orgs: [] }));
      req.setTimeout(5000, () => { req.destroy(); resolve({ available: false, orgs: [] }); });
      req.end();
    });
  };

  const decisions = createDecisionsClient({ readTSV, auditLog, getCareerContext });
  const plans = createPlansClient({ readTSV, appendTSV, rewriteTSV, auditLog });
  const surfacedTasks = createSurfacedTasksClient({ readTSV, appendTSV, rewriteTSV, auditLog });
  const corporate = createCorporateClient({ readTSV, auditLog, getCareerContext });
  // BA26081803: resolve an engagement's real OneDrive folder for the
  // Writer push, via the same getCareerContext() every other cross-engine
  // reach to circle already uses -- not a second HTTP client.
  const resolveEngagementFolder = async (orgId) => {
    const ctx = await getCareerContext();
    const org = (ctx.orgs || []).find(o => o.id === orgId);
    return (org && org.onedriveFolder) || orgId;
  };
  // BA26082402: resolve a venture's real OneDrive folder for the Writer
  // push, straight off pulse/finance/ventures.tsv's own FOLDER column --
  // same vault store this engine already reads everything else through,
  // no second HTTP client needed (ventures.tsv isn't scope's own file, but
  // vault serves every collection regardless of which engine owns it).
  const resolveProjectFolder = async (ventureId) => {
    const ventures = await readTSV('finance/ventures.tsv');
    const venture = ventures.find(v => v.ID === ventureId);
    const folder = venture && venture.FOLDER;
    return (folder && folder !== '-') ? folder : null;
  };
  const docsRegistry = createDocsRegistryClient({ readTSV, appendTSV, rewriteTSV, uploadFile: store.uploadFile, resolveEngagementFolder, resolveProjectFolder });
  // BA26081811: local disk root for generated documents -- independent of
  // the OneDrive root question BA26081803/BA26081813 are still blocked on
  // (corporate-engagement org-slug, project/general root); this is purely
  // where the engine's own copy lives so there's something for
  // generated_docs.tsv to index and Download to stream. GENERATED_DOCS_ROOT
  // overrides for deploys where scope's own disk isn't durable/local.
  const GENERATED_DOCS_ROOT = process.env.GENERATED_DOCS_ROOT || path.join(__dirname, '..', 'generated');
  const generate = createGenerateClient({ auditLog, docsRegistry, outputRoot: GENERATED_DOCS_ROOT });

  const tokenConfigured = !!(process.env.SCOPE_TOKEN || process.env.ISCONL_TOKEN || secretStore.get('SCOPE_TOKEN'));
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

      if (pathname === '/plans' && req.method === 'GET') {
        return sendJson(res, 200, await plans.listPlans());
      }
      if (pathname === '/plans/add' && req.method === 'POST') {
        return sendJson(res, 200, await plans.addPlan(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/plans/update' && req.method === 'POST') {
        return sendJson(res, 200, await plans.updatePlan(JSON.parse(await readBody(req) || '{}')));
      }

      if (pathname === '/surfaced-tasks' && req.method === 'GET') {
        return sendJson(res, 200, { items: await surfacedTasks.listSurfaced({ status: url.searchParams.get('status') }) });
      }
      if (pathname === '/surfaced-tasks/add' && req.method === 'POST') {
        return sendJson(res, 200, await surfacedTasks.addSurfaced(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/surfaced-tasks/update' && req.method === 'POST') {
        return sendJson(res, 200, await surfacedTasks.updateSurfaced(JSON.parse(await readBody(req) || '{}')));
      }

      if (pathname === '/corporate' && req.method === 'GET') {
        return sendJson(res, 200, await corporate.listEngagements());
      }
      if (pathname === '/corporate/detail' && req.method === 'GET') {
        const eng = await corporate.getEngagement(url.searchParams.get('id'));
        if (!eng) return sendJson(res, 404, { error: 'Engagement not found' });
        return sendJson(res, 200, eng);
      }

      if (pathname === '/generate/archetypes' && req.method === 'GET') {
        return sendJson(res, 200, { archetypes: generate.archetypes(url.searchParams.get('namespace')) });
      }
      if (pathname === '/generate/preview' && req.method === 'POST') {
        return sendJson(res, 200, await generate.preview(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/generate' && req.method === 'POST') {
        return sendJson(res, 200, await generate.generate(JSON.parse(await readBody(req) || '{}')));
      }

      // BA26081811: the generated-documents registry.
      if (pathname === '/generate/docs' && req.method === 'GET') {
        const docs = await docsRegistry.listDocs({
          archetypeId: url.searchParams.get('archetypeId') || undefined,
          targetKind: url.searchParams.get('targetKind') || undefined,
          status: url.searchParams.get('status') || undefined,
        });
        return sendJson(res, 200, { docs });
      }
      if (pathname === '/generate/docs/update' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await docsRegistry.updateDoc(p.id, { status: p.status }));
      }
      if (pathname === '/generate/docs/download' && req.method === 'GET') {
        return sendJson(res, 200, await docsRegistry.downloadDoc(url.searchParams.get('id')));
      }
      if (pathname === '/generate/docs/content' && req.method === 'GET') {
        return sendJson(res, 200, await docsRegistry.getContent(url.searchParams.get('id')));
      }
      if (pathname === '/generate/docs/tasks' && req.method === 'GET') {
        return sendJson(res, 200, { tasks: await docsRegistry.tasksForDoc(url.searchParams.get('id')) });
      }
      if (pathname === '/generate/docs/attach' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await docsRegistry.attachToTask(p.id, p.taskId));
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
      resolve({ server, store, jira, tasks, jiraGate, decisions, corporate, auditLog, secretStore, port: actualPort });
    });
  });
}

if (require.main === module) {
  main().catch(e => { console.error('scope failed to start:', e); process.exit(1); });
}

module.exports = { main };

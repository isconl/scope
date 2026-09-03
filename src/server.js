#!/usr/bin/env node
'use strict';
/**
 * scope engine -- HTTP entry point. Same boot sequence/style as vault and pulse.
 */

const http = require('http');
const path = require('path');
const secretStore = require('../lib/secrets');
const { createAuditLog } = require('../lib/audit');
const { createStore, defaultRequest } = require('../lib/store');
const { createJiraClient } = require('../lib/jira');
const { createTasksClient } = require('../lib/tasks');
const { createJiraGateClient } = require('../lib/jira-gate');
const { createDecisionsClient } = require('../lib/decisions');
const { createPlansClient } = require('../lib/plans');
const { createPlanningInsightsClient } = require('../lib/planning-insights');
const { createSurfacedTasksClient } = require('../lib/surfaced-tasks');
const { createPortalPartiesClient } = require('../lib/portal-parties');
const { createBufferClient } = require('../lib/buffer');
const { createActiveSubjectsClient } = require('../lib/active-subjects');
const { createStatusBriefClient } = require('../lib/status-brief');
const { computeAdherence } = require('../lib/time-optimization');
const { computePersonaSplit } = require('../lib/identity-persona');
const { createStyleCorpusClient } = require('../lib/style-corpus');
const { createWriterBinderClient } = require('../lib/writer-binder');
const { createCorporateClient } = require('../lib/corporate');
const { createGenerateClient } = require('../lib/generate/generate-client');
const { createDocsRegistryClient } = require('../lib/generate/docs-registry');
const { createPendingJiraWritesClient } = require('../lib/pending-jira-writes');
const manifest = require('../lib/manifest');
const httpLib = require('http');
const httpsLib = require('https');

const PORT = parseInt(process.env.SCOPE_PORT || process.env.PORT || '8083', 10);
const BIND = process.env.SCOPE_BIND || '127.0.0.1';
const VAULT_URL = process.env.VAULT_URL || '';
const CIRCLE_URL = process.env.CIRCLE_URL || '';
const SPARK_URL = process.env.SPARK_URL || '';
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
  const token = secretStore.get('SCOPE_TOKEN', process.env.ISCONL_TOKEN || '');
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
    getToken: () => secretStore.get('VAULT_TOKEN'),
    auditLog,
  });
  const readTSV = store.read, appendTSV = store.append, rewriteTSV = store.rewrite;

  const getJiraConfig = () => ({
    host: secretStore.get('JIRA_HOST'),
    email: secretStore.get('JIRA_EMAIL'),
    token: secretStore.get('JIRA_API_TOKEN'),
    projectKey: secretStore.get('JIRA_PROJECT'),
  });
  const jira = createJiraClient({ getConfig: getJiraConfig, auditLog });
  const buffer = createBufferClient({ getApiKey: () => secretStore.get('BUFFER_API_KEY_SCONL'), auditLog });
  const jiraConfigured = () => { const c = getJiraConfig(); return !!(c.host && c.email && c.token); };

  // Snapshot at boot: secrets are loaded before the server starts accepting
  // requests, and a live Bitwarden refresh mid-run changing Jira's
  // configured-ness is rare enough not to chase here.
  const tasks = createTasksClient({
    readTSV, appendTSV, rewriteTSV, auditLog,
    jira: jiraConfigured() ? jira : null,
  });

  const jiraGate = createJiraGateClient({ readTSV, rewriteTSV, auditLog, jira, getConfig: getJiraConfig });

  // BX26082801: out-of-band write-approval gate. jira is passed in so
  // approve() can fire the real call, but the client works safely (enqueue/list/deny)
  // even when Jira is not configured.
  const pendingJiraWrites = createPendingJiraWritesClient({
    readTSV, appendTSV, rewriteTSV, auditLog,
    jira: jiraConfigured() ? jira : null,
  });

  // Cross-engine: career context (org facts, decisions, risks, people,
  // doctrine) lives in circle (lib/career.js), served over HTTP at
  // GET /career -- see circle/src/server.js. Optional: if CIRCLE_URL
  // isn't configured, both decisions and corporate degrade to empty
  // rather than failing to boot, same fail-soft pattern as jiraConfigured.
  const getCareerContext = async () => {
    if (!CIRCLE_URL) return { activeOrg: null, orgName: null, orgs: [], people: [], decisions: [], risks: [], playbooks: [], doctrine: {}, available: false };
    const url = new URL('/career', CIRCLE_URL);
    const lib = url.protocol === 'https:' ? httpsLib : httpLib;
    const token = secretStore.get('CIRCLE_TOKEN');
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
  const planningInsights = createPlanningInsightsClient({ readTSV, appendTSV, auditLog });
  const surfacedTasks = createSurfacedTasksClient({ readTSV, appendTSV, rewriteTSV, auditLog });
  const portalParties = createPortalPartiesClient({ readTSV, appendTSV, auditLog });
  const styleCorpus = createStyleCorpusClient({ readTSV, appendTSV, auditLog });
  const activeSubjects = createActiveSubjectsClient({ readTSV, appendTSV, rewriteTSV, auditLog, getCareerContext });

  // BA26082420: scope -> spark (draft the brief) and scope -> vault (send
  // it via BI26082419's Mail.Send wrapper), same cross-engine pattern as
  // getCareerContext above (scope -> circle).
  const sparkRequest = SPARK_URL ? defaultRequest(SPARK_URL, () => secretStore.get('SPARK_TOKEN')) : null;
  const callSpark = async (query) => {
    if (!sparkRequest) return { ok: false, error: 'SPARK_URL not configured' };
    const r = await sparkRequest('POST', '/generate-status-brief', query);
    if (r.status !== 200) return { ok: false, error: (r.data && r.data.error) || `spark returned ${r.status}` };
    return { ok: true, data: r.data };
  };
  const vaultMailRequest = VAULT_URL ? defaultRequest(VAULT_URL, () => secretStore.get('VAULT_TOKEN')) : null;
  const sendMailCrossEngine = async ({ to, subject, body }) => {
    if (!vaultMailRequest) return { ok: false, error: 'VAULT_URL not configured' };
    const r = await vaultMailRequest('POST', '/graph/mail/send', { to, subject, body });
    if (r.status !== 200) return { ok: false, error: (r.data && r.data.error) || `vault returned ${r.status}` };
    return { ok: true };
  };
  const statusBrief = createStatusBriefClient({ readTSV, appendTSV, rewriteTSV, auditLog, callSpark, sendMail: sendMailCrossEngine });

  // BA26082403: Writer binder-tree, scope -> vault's existing OneDrive-
  // browse routes (same cross-engine pattern as sendMailCrossEngine above).
  const vaultBrowseRequest = VAULT_URL ? defaultRequest(VAULT_URL, () => secretStore.get('VAULT_TOKEN')) : null;
  const callVault = async (method, path, query) => {
    if (!vaultBrowseRequest) return { ok: false, error: 'VAULT_URL not configured' };
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    const r = await vaultBrowseRequest(method, `${path}${qs}`);
    if (r.status !== 200) return { ok: false, error: (r.data && r.data.error) || `vault returned ${r.status}` };
    return { ok: true, data: r.data };
  };
  const writerBinder = createWriterBinderClient({ callVault, auditLog });

  // Friday auto-draft. NOT built on CronCreate (a Claude Code session
  // scheduling tool -- session-only, dies when the session ends, auto-
  // expires after 7 days -- wrong mechanism entirely for a durable weekly
  // job). Same in-process setInterval pattern vault/lib/backup-loop.js
  // uses for its own periodic work: checks once a day whether
  // today is Friday and this week's batch hasn't run yet, tracked by a
  // plain in-memory "last run" week-stamp (resets on restart, which is
  // fine -- a missed Friday during a restart window just drafts on the
  // next daily check, not silently skipped forever).
  let lastFridayRun = null;
  const FRIDAY = 5;
  const fridayTimer = setInterval(async () => {
    const now = new Date();
    if (now.getDay() !== FRIDAY) return;
    const weekStamp = statusBrief.mondayOf(now);
    if (lastFridayRun === weekStamp) return;
    lastFridayRun = weekStamp;
    const r = await statusBrief.draftAllBriefs().catch(e => ({ drafted: 0, error: String(e.message || e) }));
    auditLog.log('status_brief_friday_run', r);
  }, 24 * 60 * 60 * 1000);
  if (fridayTimer.unref) fridayTimer.unref(); // never keeps the process alive on its own

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
  // BA26083107: list the live OneDrive contents of a folder via vault's
  // existing /onedrive/browse route -- same cross-engine call pattern as
  // callVault above, reused (not a second HTTP client) for docsRegistry's
  // listDocsMerged().
  const browseOnedriveFolder = async (path) => {
    const r = await callVault('GET', '/onedrive/browse', { path });
    return r.ok ? r.data : { ok: false, error: r.error };
  };
  const docsRegistry = createDocsRegistryClient({ readTSV, appendTSV, rewriteTSV, uploadFile: store.uploadFile, resolveEngagementFolder, resolveProjectFolder, browseFolder: browseOnedriveFolder });
  // BA26081811: local disk root for generated documents -- independent of
  // the OneDrive root question BA26081803/BA26081813 are still blocked on
  // (corporate-engagement org-slug, project/general root); this is purely
  // where the engine's own copy lives so there's something for
  // generated_docs.tsv to index and Download to stream. GENERATED_DOCS_ROOT
  // overrides for deploys where scope's own disk isn't durable/local.
  const GENERATED_DOCS_ROOT = process.env.GENERATED_DOCS_ROOT || path.join(__dirname, '..', 'generated');
  const generate = createGenerateClient({ auditLog, docsRegistry, outputRoot: GENERATED_DOCS_ROOT });

  const tokenConfigured = !!secretStore.get('SCOPE_TOKEN', process.env.ISCONL_TOKEN || '');
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
      // BT26082413: explicit start/stop UI action, never inferred from
      // opening the task -- see tasks.js's own comment on why.
      if (pathname === '/tasks/session/start' && req.method === 'POST') {
        const { taskId } = JSON.parse(await readBody(req) || '{}');
        try { return sendJson(res, 200, await tasks.startTaskSession(taskId)); }
        catch (e) { return sendJson(res, 400, { success: false, error: e.message }); }
      }
      if (pathname === '/tasks/session/stop' && req.method === 'POST') {
        const { taskId } = JSON.parse(await readBody(req) || '{}');
        try { return sendJson(res, 200, await tasks.stopTaskSession(taskId)); }
        catch (e) { return sendJson(res, 400, { success: false, error: e.message }); }
      }
      if (pathname === '/tasks/session/list' && req.method === 'GET') {
        const taskId = url.searchParams.get('taskId');
        return sendJson(res, 200, { sessions: await tasks.getTaskSessions(taskId) });
      }

      if (pathname === '/jira/preview' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await jiraGate.preview(p.taskId));
      }
      if (pathname === '/jira/push' && req.method === 'POST') {
        const r = await jiraGate.push(JSON.parse(await readBody(req) || '{}'));
        return sendJson(res, r.blocked ? 409 : (r.success ? 200 : 502), r);
      }

      // BX26082801: out-of-band write-approval queue.
      // GET  /jira/pending         -- list queued writes (optionally ?status=pending|approved|denied|error)
      // POST /jira/pending/enqueue -- enqueue an autonomous write for approval
      // POST /jira/pending/approve -- Architect approves, fires the real Jira call
      // POST /jira/pending/deny    -- Architect denies, discards the queued write
      if (pathname === '/jira/pending' && req.method === 'GET') {
        return sendJson(res, 200, { pending: await pendingJiraWrites.listPending({ status: url.searchParams.get('status') || undefined }) });
      }
      if (pathname === '/jira/pending/enqueue' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        try { return sendJson(res, 200, await pendingJiraWrites.enqueue(p)); }
        catch (e) { return sendJson(res, 400, { success: false, error: e.message }); }
      }
      if (pathname === '/jira/pending/approve' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        try { return sendJson(res, 200, await pendingJiraWrites.approve(p)); }
        catch (e) { return sendJson(res, 400, { success: false, error: e.message }); }
      }
      if (pathname === '/jira/pending/deny' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        try { return sendJson(res, 200, await pendingJiraWrites.deny(p)); }
        catch (e) { return sendJson(res, 400, { success: false, error: e.message }); }
      }

      if (pathname === '/jira/issues' && req.method === 'GET') {
        return sendJson(res, 200, { issues: await jira.jiraListMyIssues() });
      }
      if (pathname === '/jira/transition' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        const r = await jira.jiraTransitionIssue(p.issueKey, p.transition);
        return sendJson(res, r.success ? 200 : 400, r);
      }
      if (pathname === '/jira/assignable' && req.method === 'GET') {
        const force = url.searchParams.get('refresh') === '1';
        return sendJson(res, 200, { users: await jira.jiraAssignableUsers({ force }) });
      }
      if (pathname === '/jira/assign' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        const r = await jira.jiraAssignIssue(p.issueKey, p.accountId);
        return sendJson(res, r.success ? 200 : 400, r);
      }
      if (pathname === '/jira/delete' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        const r = await jira.jiraDeleteIssue(p.issueKey);
        return sendJson(res, r.success ? 200 : 400, r);
      }
      if (pathname === '/jira/clear' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        const r = await jira.jiraTransitionIssue(p.issueKey, 'Done');
        return sendJson(res, r.success ? 200 : 400, { cleared: !!r.success, ...r });
      }

      // BX26082422 read side -- issue/comments/projects, safe (no
      // gating needed, this is read-only). Write-side gating design is
      // NOT built here -- see plan.md, needs Architect's sign-off first.
      if (pathname === '/jira/issue' && req.method === 'GET') {
        return sendJson(res, 200, await jira.jiraGetIssue(url.searchParams.get('key')));
      }
      if (pathname === '/jira/comments' && req.method === 'GET') {
        return sendJson(res, 200, { comments: await jira.jiraGetComments(url.searchParams.get('key')) });
      }
      if (pathname === '/jira/projects' && req.method === 'GET') {
        return sendJson(res, 200, { projects: await jira.jiraListProjects() });
      }

      // BX26082423: Buffer scaffolding + API wiring only -- no content
      // generation, schedules already-authored text only.
      if (pathname === '/buffer/organizations' && req.method === 'GET') {
        return sendJson(res, 200, await buffer.getOrganizations());
      }
      if (pathname === '/buffer/channels' && req.method === 'GET') {
        return sendJson(res, 200, await buffer.listChannels(url.searchParams.get('organizationId')));
      }
      if (pathname === '/buffer/queue' && req.method === 'GET') {
        return sendJson(res, 200, await buffer.listQueue({
          organizationId: url.searchParams.get('organizationId'),
          channelIds: (url.searchParams.get('channelIds') || '').split(',').filter(Boolean),
          status: url.searchParams.get('status') || undefined,
        }));
      }
      if (pathname === '/buffer/schedule' && req.method === 'POST') {
        return sendJson(res, 200, await buffer.schedulePost(JSON.parse(await readBody(req) || '{}')));
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

      // BT26082601: curated planning-insight database, one-time build+run
      // (not the ongoing daily cron PT26082003 sketches).
      if (pathname === '/planning-insights' && req.method === 'GET') {
        return sendJson(res, 200, await planningInsights.listInsights());
      }
      if (pathname === '/planning-insights/curate' && req.method === 'POST') {
        return sendJson(res, 200, await planningInsights.runCuration());
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

      // BX26082424: portal-wide user_groups vs. per-listing deal_flow_parties.
      if (pathname === '/portal/user-groups' && req.method === 'GET') {
        return sendJson(res, 200, { userGroups: await portalParties.listUserGroups({ portal: url.searchParams.get('portal') }) });
      }
      if (pathname === '/portal/user-groups/add' && req.method === 'POST') {
        return sendJson(res, 200, await portalParties.addUserGroup(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/portal/user-groups/seed' && req.method === 'POST') {
        return sendJson(res, 200, await portalParties.seedKnownUserGroups());
      }
      if (pathname === '/portal/deal-flow-parties' && req.method === 'GET') {
        return sendJson(res, 200, { dealFlowParties: await portalParties.listDealFlowParties({ portal: url.searchParams.get('portal'), listingId: url.searchParams.get('listingId') }) });
      }
      if (pathname === '/portal/deal-flow-parties/add' && req.method === 'POST') {
        return sendJson(res, 200, await portalParties.addDealFlowParty(JSON.parse(await readBody(req) || '{}')));
      }

      // BA26082420: weekly status-brief -- subject registry, drafts, send.
      if (pathname === '/active-subjects' && req.method === 'GET') {
        return sendJson(res, 200, { subjects: await activeSubjects.listSubjects() });
      }
      if (pathname === '/active-subjects/sync' && req.method === 'POST') {
        return sendJson(res, 200, await activeSubjects.syncFromCareer());
      }
      if (pathname === '/active-subjects/owner' && req.method === 'POST') {
        return sendJson(res, 200, await activeSubjects.addOwnerSubject(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/status-briefs' && req.method === 'GET') {
        return sendJson(res, 200, { briefs: await statusBrief.listBriefs({ subjectId: url.searchParams.get('subjectId') }) });
      }
      if (pathname === '/status-briefs/draft' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, p.subjectId ? await statusBrief.draftBrief(p.subjectId) : await statusBrief.draftAllBriefs());
      }
      if (pathname === '/status-briefs/send' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await statusBrief.sendBrief(p.briefId, { via: p.via, to: p.to }));
      }

      // BT26082414: block-adherence analysis, depends on BT26082413's real
      // session data. Lands in the (already decluttered, BT26082417)
      // Planning space as a new section.
      if (pathname === '/planning/adherence' && req.method === 'GET') {
        const days = parseInt(url.searchParams.get('days'), 10) || 7;
        return sendJson(res, 200, await computeAdherence({ readTSV, days }));
      }

      // BT26082415: identity-persona ring, read-only v1.
      if (pathname === '/identity/persona-split' && req.method === 'GET') {
        return sendJson(res, 200, await computePersonaSplit({ readTSV, day: url.searchParams.get('day') }));
      }

      // BM26082412 v1: style corpus + per-contact tailoring.
      if (pathname === '/style-corpus/ingest' && req.method === 'POST') {
        return sendJson(res, 200, await styleCorpus.ingestNew());
      }
      if (pathname === '/style-corpus/ingest-turns' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await styleCorpus.ingestTurns(body.turns || []));
      }
      if (pathname === '/style-corpus/profile' && req.method === 'GET') {
        return sendJson(res, 200, await styleCorpus.getStyleProfile(url.searchParams.get('personId')));
      }

      // BA26082403: Writer binder-tree first slice.
      if (pathname === '/writer/binder/episodes' && req.method === 'GET') {
        return sendJson(res, 200, await writerBinder.listEpisodes());
      }
      if (pathname === '/writer/binder/compile' && req.method === 'GET') {
        return sendJson(res, 200, await writerBinder.compileEpisode(url.searchParams.get('itemId')));
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

      // BA26081811: the generated-documents registry. BA26083107: also
      // merges in a live OneDrive folder listing for the active
      // engagement, so every real document (not just Writer-generated
      // ones) surfaces here -- an explicit targetKind/targetId query
      // still works and is respected as-is; with neither given, this
      // defaults to merging the currently active engagement (career/
      // _active.yaml), since that's what "every document ever drafted
      // for Viva" (or whichever org is active) actually means day to day.
      if (pathname === '/generate/docs' && req.method === 'GET') {
        const filter = {
          archetypeId: url.searchParams.get('archetypeId') || undefined,
          targetKind: url.searchParams.get('targetKind') || undefined,
          status: url.searchParams.get('status') || undefined,
        };
        // The engagement to merge a live OneDrive listing for -- an
        // explicit ?targetId= (with targetKind=engagement) wins; otherwise
        // default to the currently active engagement (career/_active.yaml),
        // since "surface every document" means the one Sconl is actually
        // looking at day to day, not every engagement ever on file.
        let mergeEngagement = null;
        const explicitTargetId = url.searchParams.get('targetId');
        if (filter.targetKind === 'engagement' && explicitTargetId) {
          mergeEngagement = { id: explicitTargetId };
        } else if (!filter.targetKind || filter.targetKind === 'engagement') {
          const ctx = await getCareerContext().catch(() => ({}));
          if (ctx.activeOrg) {
            const org = (ctx.orgs || []).find(o => o.id === ctx.activeOrg);
            mergeEngagement = { id: ctx.activeOrg, label: org && org.name };
          }
        }
        const docs = await docsRegistry.listDocsMerged(filter, mergeEngagement);
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

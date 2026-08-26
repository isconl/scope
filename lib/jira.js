'use strict';
/**
 * Jira REST client. Ported from isconl-agent's server.js (~4074-4380).
 *
 * `ok` is the only safe success signal throughout -- a 400/403/404 has no
 * `error` key either, so inferring success from its absence was the actual
 * original bug this port preserves the fix for.
 */

const https = require('https');

function httpsRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

// Scope priorities are lowercase words; Jira wants its own named priority scheme.
const JIRA_PRIORITY = { high: 'High', medium: 'Medium', low: 'Low' };

/** Jira's v3 API takes rich text as Atlassian Document Format, not a string. */
function adf(text) {
  const paras = String(text || '').split(/\n{2,}/).filter(p => p.trim());
  return {
    type: 'doc', version: 1,
    content: (paras.length ? paras : ['']).map(p => ({
      type: 'paragraph',
      content: p.trim() ? [{ type: 'text', text: p.trim() }] : [],
    })),
  };
}

/**
 * @param {object} opts
 * @param {() => {host:string,email:string,token:string,projectKey:string}} opts.getConfig
 * @param {{log:Function}} [opts.auditLog]
 * @param {number} [opts.deletedTtlMs] -- how long a deleted key is filtered out of list results, covering Jira's eventually-consistent search index
 */
function createJiraClient(opts) {
  const { getConfig, auditLog = { log: () => {} }, deletedTtlMs = 120000 } = opts;
  if (!getConfig) throw new Error('createJiraClient requires getConfig');

  async function jiraAPI(method, apiPath, data = null) {
    const cfg = getConfig();
    if (!cfg.host || !cfg.email || !cfg.token) return { error: 'Jira host/email/token not fully configured', ok: false, status: 0 };
    const cleanHost = cfg.host.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const auth = Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64');
    const body = data ? JSON.stringify(data) : null;
    try {
      const res = await httpsRequest({
        hostname: cleanHost,
        path: apiPath.startsWith('/rest') ? apiPath : `/rest/api/3${apiPath}`,
        method,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
      }, body);
      auditLog.log('jira_api', { method, path: apiPath, status: res.status });
      const ok = res.status >= 200 && res.status < 300;
      return { status: res.status, data: res.data, ok, error: ok ? null : jiraErrorText(res) };
    } catch (e) { return { error: e.message, ok: false, status: 0 }; }
  }

  function jiraErrorText(res) {
    const d = res.data;
    const parts = [];
    if (d && typeof d === 'object') {
      if (Array.isArray(d.errorMessages)) parts.push(...d.errorMessages);
      if (d.errors && typeof d.errors === 'object') for (const [k, v] of Object.entries(d.errors)) parts.push(`${k}: ${v}`);
    } else if (typeof d === 'string' && d.trim()) parts.push(d.trim().slice(0, 300));
    if (!parts.length) {
      const known = { 400: 'Bad request', 401: 'Authentication failed - check JIRA_EMAIL / JIRA_API_TOKEN',
        403: 'Permission denied - your Jira account lacks "Delete issues" on this project',
        404: 'Issue not found (it may already be deleted)', 429: 'Rate limited by Jira - retry shortly' };
      parts.push(known[res.status] || `Jira returned HTTP ${res.status}`);
    }
    return parts.join('; ');
  }

  // -- recently-deleted filter: Jira's search index lags a delete by a few seconds --
  const recentlyDeleted = new Map();
  function markDeleted(key) { recentlyDeleted.set(key, Date.now()); }
  function pruneDeleted() {
    const now = Date.now();
    for (const [k, t] of recentlyDeleted) if (now - t > deletedTtlMs) recentlyDeleted.delete(k);
  }
  function isRecentlyDeleted(key) { pruneDeleted(); return recentlyDeleted.has(key); }

  async function jiraListMyIssues() {
    // No hardcoded fallback: a project key is tenant-specific, and a
    // malformed JQL query ("project =  ORDER BY...") is a worse failure
    // mode than just reporting nothing configured -- config-first
    // genericization (Decision 002's pattern).
    const pKey = getConfig().projectKey;
    if (!pKey) return [];
    const res = await jiraAPI('POST', '/rest/api/3/search/jql', {
      jql: `project = ${pKey} ORDER BY created DESC`, maxResults: 30,
      fields: ['summary', 'status', 'priority', 'issuetype', 'created', 'description', 'assignee'],
    });
    if (res?.data?.issues) {
      return res.data.issues.filter(i => !isRecentlyDeleted(i.key)).map(i => ({
        key: i.key, summary: i.fields?.summary, status: i.fields?.status?.name || 'To Do',
        priority: i.fields?.priority?.name || 'Medium', type: i.fields?.issuetype?.name || 'Task',
        created: i.fields?.created,
        assignee: i.fields?.assignee ? {
          accountId: i.fields.assignee.accountId, displayName: i.fields.assignee.displayName,
          email: i.fields.assignee.emailAddress || null, avatar: i.fields.assignee.avatarUrls?.['24x24'] || null,
        } : null,
      }));
    }
    return [];
  }

  async function jiraCreateIssue(summary, description, issueType = 'Task', extra = {}) {
    if (!getConfig().projectKey) return { error: 'JIRA_PROJECT not set' };
    const base = { project: { key: getConfig().projectKey }, summary, issuetype: { name: issueType } };
    if (description) base.description = adf(description);

    const optional = {};
    if (extra.duedate && /^\d{4}-\d{2}-\d{2}$/.test(extra.duedate)) optional.duedate = extra.duedate;
    if (Array.isArray(extra.labels) && extra.labels.length) optional.labels = extra.labels.map(l => String(l).replace(/\s+/g, '-')).filter(Boolean);
    if (extra.priority && JIRA_PRIORITY[extra.priority]) optional.priority = { name: JIRA_PRIORITY[extra.priority] };
    if (extra.assignee) optional.assignee = { accountId: extra.assignee };

    let dropped = [];
    let res = await jiraAPI('POST', '/rest/api/3/issue', { fields: { ...base, ...optional } });
    if (!res.ok && Object.keys(optional).length) {
      const err = String(res.error || '').toLowerCase();
      const keep = {};
      for (const [k, v] of Object.entries(optional)) { if (err.includes(k.toLowerCase())) dropped.push(k); else keep[k] = v; }
      if (!dropped.length) dropped = Object.keys(optional);
      res = await jiraAPI('POST', '/rest/api/3/issue', { fields: { ...base, ...(dropped.length === Object.keys(optional).length ? {} : keep) } });
    }
    const out = res.data || res;
    if (res.ok && dropped.length) out.unsupportedFields = dropped;
    return out;
  }

  async function jiraUpdateIssue(issueKey, { summary, priority, duedate, labels, description } = {}) {
    if (!issueKey || !/^[A-Z][A-Z0-9]*-\d+$/i.test(issueKey)) return { success: false, error: `"${issueKey}" is not a valid Jira issue key` };
    const fields = {};
    if (summary) fields.summary = summary;
    if (priority && JIRA_PRIORITY[priority]) fields.priority = { name: JIRA_PRIORITY[priority] };
    if (duedate !== undefined) fields.duedate = /^\d{4}-\d{2}-\d{2}$/.test(duedate || '') ? duedate : null;
    if (Array.isArray(labels)) fields.labels = labels.map(l => String(l).replace(/\s+/g, '-')).filter(Boolean);
    if (description) fields.description = adf(description);
    if (!Object.keys(fields).length) return { success: true, key: issueKey, skipped: true };

    let res = await jiraAPI('PUT', `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, { fields });
    if (!res.ok && fields.priority && /priority/i.test(res.error || '')) {
      const { priority: _dropped, ...rest } = fields;
      if (Object.keys(rest).length) {
        res = await jiraAPI('PUT', `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, { fields: rest });
        if (res.ok) {
          auditLog.log('jira_issue_updated', { issueKey, fields: Object.keys(rest), priorityUnsupported: true });
          return { success: true, key: issueKey, priorityApplied: false, warning: 'Jira project does not expose the priority field; title updated only' };
        }
      }
      return { success: false, key: issueKey, error: res.error };
    }
    if (!res.ok) return { success: false, key: issueKey, error: res.error };
    auditLog.log('jira_issue_updated', { issueKey, fields: Object.keys(fields) });
    return { success: true, key: issueKey, priorityApplied: !!fields.priority };
  }

  let assignableCache = { at: 0, users: [] };
  async function jiraAssignableUsers({ force = false, ttlMs = 5 * 60 * 1000 } = {}) {
    if (!force && assignableCache.users.length && Date.now() - assignableCache.at < ttlMs) return assignableCache.users;
    const pKey = getConfig().projectKey;
    if (!pKey) return [];
    const res = await jiraAPI('GET', `/rest/api/3/user/assignable/search?project=${encodeURIComponent(pKey)}&maxResults=50`);
    if (!res.ok || !Array.isArray(res.data)) {
      auditLog.log('jira_assignable_failed', { status: res.status, error: res.error });
      return assignableCache.users;
    }
    const users = res.data.filter(u => u.accountType === 'atlassian' && u.active !== false).map(u => ({
      accountId: u.accountId, displayName: u.displayName, email: u.emailAddress || null, avatar: u.avatarUrls?.['24x24'] || null,
    }));
    assignableCache = { at: Date.now(), users };
    return users;
  }

  async function jiraAssignIssue(issueKey, accountId) {
    if (!issueKey || !/^[A-Z][A-Z0-9]*-\d+$/i.test(issueKey)) return { success: false, error: `"${issueKey}" is not a valid Jira issue key` };
    const res = await jiraAPI('PUT', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/assignee`, { accountId: accountId || null });
    if (!res.ok) { auditLog.log('jira_assign_failed', { issueKey, accountId, status: res.status, error: res.error }); return { success: false, key: issueKey, error: res.error }; }
    auditLog.log('jira_issue_assigned', { issueKey, accountId: accountId || null });
    return { success: true, key: issueKey, accountId: accountId || null };
  }

  async function jiraTransitionIssue(issueKey, transitionName) {
    const listRes = await jiraAPI('GET', `/rest/api/3/issue/${issueKey}/transitions`);
    if (listRes?.data?.transitions) {
      const t = listRes.data.transitions.find(tr =>
        tr.name.toLowerCase().includes(transitionName.toLowerCase()) || tr.to?.name?.toLowerCase().includes(transitionName.toLowerCase()));
      if (t) {
        await jiraAPI('POST', `/rest/api/3/issue/${issueKey}/transitions`, { transition: { id: t.id } });
        auditLog.log('jira_issue_transitioned', { issueKey, transition: t.name });
        return { success: true, key: issueKey, newStatus: t.to?.name };
      }
    }
    return { error: `Transition "${transitionName}" not available for ${issueKey}` };
  }

  async function jiraIssueExists(issueKey) {
    const res = await jiraAPI('GET', `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=key`);
    if (res.status === 404) return false;
    if (res.ok) return true;
    return null;
  }

  // BX26082422 read side: full OAuth 3-legged flow is not built (no
  // functional gap it would close today -- Basic Auth via an API token
  // already reads and writes; flagged to plan.md as a question worth
  // asking Architect rather than assumed). What WAS a real gap: no read
  // function existed for a single issue, comments, or the project list --
  // only jiraListMyIssues (a fixed JQL search) and jiraIssueExists (a bare
  // boolean). These three are read-only, safe (no special gating needed,
  // per the row's own text), and feed BX26082421's depth card.
  async function jiraGetIssue(issueKey) {
    if (!issueKey || !/^[A-Z][A-Z0-9]*-\d+$/i.test(issueKey)) return { error: `"${issueKey}" is not a valid Jira issue key` };
    const res = await jiraAPI('GET', `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,status,priority,issuetype,assignee,description,created,updated,duedate`);
    if (!res.ok) return { error: res.error || `status ${res.status}` };
    const f = res.data.fields || {};
    return {
      key: res.data.key, summary: f.summary, status: f.status?.name || null,
      priority: f.priority?.name || null, type: f.issuetype?.name || null,
      assignee: f.assignee ? { accountId: f.assignee.accountId, displayName: f.assignee.displayName } : null,
      created: f.created || null, updated: f.updated || null, duedate: f.duedate || null,
    };
  }

  async function jiraGetComments(issueKey) {
    if (!issueKey || !/^[A-Z][A-Z0-9]*-\d+$/i.test(issueKey)) return { error: `"${issueKey}" is not a valid Jira issue key` };
    const res = await jiraAPI('GET', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?maxResults=50`);
    if (!res.ok) return { error: res.error || `status ${res.status}` };
    return (res.data.comments || []).map(c => ({
      id: c.id, author: c.author?.displayName || null, created: c.created,
      // ADF bodies vary in depth; a flat text join is enough for a depth
      // card, not a rich-text renderer -- extends if a real need shows up.
      text: (c.body?.content || []).flatMap(block => (block.content || []).map(t => t.text || '')).join(' ').trim(),
    }));
  }

  async function jiraListProjects() {
    const res = await jiraAPI('GET', '/rest/api/3/project/search?maxResults=50');
    if (!res.ok) return { error: res.error || `status ${res.status}` };
    return (res.data.values || []).map(p => ({ key: p.key, name: p.name, id: p.id }));
  }

  async function jiraDeleteIssue(issueKey) {
    if (!issueKey || !/^[A-Z][A-Z0-9]*-\d+$/i.test(issueKey)) return { success: false, key: issueKey, error: `"${issueKey}" is not a valid Jira issue key` };
    const cfg = getConfig();
    if (!cfg.host || !cfg.email || !cfg.token) return { success: false, key: issueKey, error: 'Jira host/email/token not fully configured' };

    const res = await jiraAPI('DELETE', `/rest/api/3/issue/${encodeURIComponent(issueKey)}?deleteSubtasks=true`);
    const accepted = res.status === 204 || res.status === 200 || res.status === 404;
    if (!accepted) {
      auditLog.log('jira_issue_delete_failed', { issueKey, status: res.status, error: res.error });
      const permissionDenied = res.status === 403;
      return {
        success: false, key: issueKey, status: res.status, verified: false, error: res.error, permissionDenied,
        fallback: permissionDenied ? 'transition-to-done' : null,
        remedy: permissionDenied
          ? 'Ask a Jira admin to grant "Delete Issues" to your role on this project, or use Clear instead (moves the issue to Done so it leaves the active board).'
          : null,
      };
    }
    // Verify it is actually gone -- deletion is fast but not always instant, and
    // Jira's own 204 is not proof; a caller must never remove the local row on
    // an unverified delete, or the two silently diverge.
    let verified = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const exists = await jiraIssueExists(issueKey);
      if (exists === false) { verified = true; break; }
      if (exists === null) break;   // can't tell (auth/network) -- don't loop forever
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }

    if (!verified) {
      auditLog.log('jira_issue_delete_unverified', { issueKey, status: res.status });
      return { success: false, key: issueKey, status: res.status, verified: false,
        error: `Jira accepted the delete (HTTP ${res.status}) but ${issueKey} still exists. Not removing it locally.` };
    }

    markDeleted(issueKey);
    auditLog.log('jira_issue_deleted', { issueKey, status: res.status, verified: true });
    return { success: true, key: issueKey, status: res.status, verified: true };
  }

  return {
    jiraAPI, jiraListMyIssues, jiraCreateIssue, jiraUpdateIssue, jiraAssignableUsers,
    jiraAssignIssue, jiraTransitionIssue, jiraIssueExists, jiraDeleteIssue,
    jiraGetIssue, jiraGetComments, jiraListProjects,
    markDeleted, isRecentlyDeleted, adf,
  };
}

module.exports = { createJiraClient, JIRA_PRIORITY, adf, httpsRequest };

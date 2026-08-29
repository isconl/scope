'use strict';
/**
 * BX26082801: Jira out-of-band write-approval gate.
 *
 * Any autonomous/agent-driven Jira write enqueues here instead of calling
 * Jira directly. Architect approves from the in-app pending-approvals view;
 * only then does the real Jira call fire. Denying discards the queued write.
 *
 * The hard rule ("Jira is never pushed to autonomously, under any
 * circumstance") is enforced here: no path may call jira.jiraCreateIssue
 * or any mutating Jira API without Architect's explicit in-app approval click.
 *
 * Ordinary task CRUD (createTask/updateTask/deleteTask/completeTask in
 * tasks.js) is EXEMPT from this gate — Architect initiating a task edit himself
 * already is the human-in-the-loop, per the resolved design question.
 */

function uid() {
  return `PJ${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function clean(v) { return v && v !== '-' ? String(v) : '-'; }

function createPendingJiraWritesClient(opts) {
  const {
    appendTSV, readTSV, rewriteTSV,
    auditLog = { log: () => {} },
    jira,
    pendingFile = 'scope/pending_jira_writes.tsv',
  } = opts;
  if (!appendTSV || !readTSV || !rewriteTSV) {
    throw new Error('createPendingJiraWritesClient requires appendTSV, readTSV, rewriteTSV');
  }

  /** Enqueue a write request for Architect's approval. Returns immediately with
   *  { queued: true, id } — the caller never blocks on a Jira call. */
  async function enqueue({ action, payload, requester = 'agent' }) {
    if (!action) throw new Error('action is required (e.g. "createIssue", "transitionIssue")');
    const id = uid();
    const now = new Date().toISOString();
    await appendTSV(pendingFile, {
      ID: id,
      ACTION: clean(action),
      PAYLOAD: JSON.stringify(payload || {}),
      REQUESTER: clean(requester),
      STATUS: 'pending',
      DECIDED_BY: '-',
      DECIDED_AT: '-',
      RESULT_KEY: '-',
      ERROR: '-',
      CREATED_AT: now.slice(0, 16),
    });
    auditLog.log('jira_write_queued', { id, action, requester });
    return { queued: true, id, pendingApproval: true };
  }

  /** List queued writes, optionally filtered by status. */
  async function listPending({ status } = {}) {
    const rows = await readTSV(pendingFile);
    const filtered = status ? rows.filter(r => r.STATUS === status) : rows;
    return filtered.map(r => ({
      id: r.ID,
      action: r.ACTION,
      payload: (() => { try { return JSON.parse(r.PAYLOAD); } catch { return {}; } })(),
      requester: r.REQUESTER,
      status: r.STATUS,
      decidedBy: r.DECIDED_BY,
      decidedAt: r.DECIDED_AT,
      resultKey: r.RESULT_KEY,
      error: r.ERROR,
      createdAt: r.CREATED_AT,
    }));
  }

  /** Approve a pending write. Fires the real Jira call, marks row approved.
   *  Requires jira client configured — returns error if not. */
  async function approve({ id, decidedBy = 'Architect' }) {
    const rows = await readTSV(pendingFile);
    const row = rows.find(r => r.ID === id);
    if (!row) throw new Error(`Pending write ${id} not found`);
    if (row.STATUS !== 'pending') throw new Error(`Pending write ${id} is already ${row.STATUS}`);
    if (!jira) {
      await rewriteTSV(pendingFile, rs => rs.map(r => r.ID === id
        ? { ...r, STATUS: 'error', ERROR: 'Jira client not configured — cannot fire write', DECIDED_AT: new Date().toISOString().slice(0, 16) }
        : r));
      return { success: false, error: 'Jira client not configured' };
    }

    let payload;
    try { payload = JSON.parse(row.PAYLOAD || '{}'); } catch { payload = {}; }

    let result;
    try {
      if (row.ACTION === 'createIssue') {
        result = await jira.jiraCreateIssue(
          payload.summary, payload.description || '', payload.issueType || 'Task',
          { duedate: payload.duedate, labels: payload.labels || [], priority: payload.priority, assignee: payload.assignee }
        );
      } else if (row.ACTION === 'transitionIssue') {
        result = await jira.jiraTransitionIssue(payload.key, payload.transitionName || 'Done');
      } else {
        result = { error: `Unknown action: ${row.ACTION}` };
      }
    } catch (e) {
      result = { error: e.message };
    }

    const ok = result && !result.error;
    const now = new Date().toISOString().slice(0, 16);
    await rewriteTSV(pendingFile, rs => rs.map(r => r.ID === id ? {
      ...r,
      STATUS: ok ? 'approved' : 'error',
      DECIDED_BY: clean(decidedBy),
      DECIDED_AT: now,
      RESULT_KEY: clean(result?.key),
      ERROR: ok ? '-' : clean(result?.error),
    } : r));

    auditLog.log('jira_write_approved', { id, action: row.ACTION, ok, key: result?.key });
    return ok ? { success: true, key: result.key } : { success: false, error: result.error };
  }

  /** Deny a pending write. Marks it denied, no Jira call is ever fired. */
  async function deny({ id, decidedBy = 'Architect' }) {
    const rows = await readTSV(pendingFile);
    const row = rows.find(r => r.ID === id);
    if (!row) throw new Error(`Pending write ${id} not found`);
    if (row.STATUS !== 'pending') throw new Error(`Pending write ${id} is already ${row.STATUS}`);
    const now = new Date().toISOString().slice(0, 16);
    await rewriteTSV(pendingFile, rs => rs.map(r => r.ID === id ? {
      ...r, STATUS: 'denied', DECIDED_BY: clean(decidedBy), DECIDED_AT: now,
    } : r));
    auditLog.log('jira_write_denied', { id, action: row.ACTION, decidedBy });
    return { success: true, denied: true };
  }

  return { enqueue, listPending, approve, deny };
}

module.exports = { createPendingJiraWritesClient };

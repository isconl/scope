'use strict';
/**
 * Task lifecycle: create, update, delete, complete -- each mirrored to a
 * linked Jira issue when one exists. Ported from isconl-agent's server.js
 * (create ~11885-11929, update ~12065-12160, delete ~12162-12203,
 * complete ~12205-12263).
 *
 * OUT OF SCOPE for this module (deliberate, same reasoning as every sibling
 * engine's exclusions): the AI-generated task brief/draft-message endpoints
 * (~11955-12063) and intelligent distillation (~12265+) both call
 * processAiChat with career-context grounding -- that's a real dependency on
 * `circle`'s career vault AND `spark`'s AI-provider routing, neither of
 * which exist yet. Belongs here once both do; not stubbed out with a fake
 * in the meantime.
 *
 * A linked Jira edit failing never rolls back the local change -- the vault
 * is the source of truth, so a Jira outage is reported, not treated as a
 * transaction failure.
 */

function stripDashes(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(/(\d)\s*[··]\s*(\d)/g, '$1-$2')
    .replace(/\s*[··]\s*/g, ' - ')
    .replace(/[—–]/g, '-');
}

const VALID_PRIORITY = ['high', 'medium', 'low'];
const VALID_STATUS = ['today', 'next', 'waiting', 'review', 'done'];

function createTasksClient(opts) {
  const {
    readTSV, appendTSV, rewriteTSV,
    auditLog = { log: () => {} },
    jira = null,          // the object createJiraClient() returns, or null/undefined when Jira isn't configured
    tagVocabulary = () => [],
    tasksFile = 'scope/tasks.tsv',
  } = opts;
  if (!readTSV || !appendTSV || !rewriteTSV) throw new Error('createTasksClient requires readTSV/appendTSV/rewriteTSV');

  async function listTasks() {
    return readTSV(tasksFile);
  }

  async function getTask(taskId) {
    return (await readTSV(tasksFile)).find(r => r.ID === taskId) || null;
  }

  async function createTask(t) {
    const taskId = 'T' + Date.now();

    // A subtask points at its parent through PARENT_ID. One level only.
    let parentId = '-';
    if (t.parentId) {
      const parent = (await readTSV(tasksFile)).find(r => r.ID === t.parentId);
      if (!parent) throw new Error(`No task ${t.parentId} to attach to`);
      if (parent.PARENT_ID && parent.PARENT_ID !== '-') throw new Error('Subtasks stay one level deep - attach to the main task instead');
      parentId = parent.ID;
    }

    const row = {
      ID: taskId, TITLE: stripDashes(t.title || 'Untitled'), STATUS: t.status || 'today',
      PRIORITY: t.priority || 'medium', PROJECT_ID: '-', CARRY_FWD: '0',
      DUE_DATE: t.due_date || '-', CREATED_AT: new Date().toISOString().slice(0, 10),
      JIRA_KEY: '-', TAG: String(t.tag || '').trim() || '-', PARENT_ID: parentId,
    };

    // Create in Jira FIRST so the key can be persisted with the row -- a key
    // only held in memory and never written to the TSV is a permanently
    // broken link. Subtasks stay local unless explicitly asked otherwise.
    let jiraResult = null;
    if (jira && t.syncJira !== false && parentId === '-') {
      jiraResult = await jira.jiraCreateIssue(row.TITLE, `Task created from iSconl dashboard.\nPriority: ${row.PRIORITY}`);
      if (jiraResult?.key) row.JIRA_KEY = jiraResult.key;
    }

    await appendTSV(tasksFile, row);
    auditLog.log('task_created', { taskId, title: row.TITLE, jiraKey: row.JIRA_KEY });
    return { task: row, jira: jiraResult };
  }

  async function updateTask({ taskId, title, priority, status, due_date, tag, start_date, assignee }) {
    if (!taskId) throw new Error('taskId required');
    if (tag !== undefined && tag !== '' && !tagVocabulary().some(t => t.id === tag)) throw new Error(`"${tag}" is not a known tag`);
    if (priority && !VALID_PRIORITY.includes(priority)) throw new Error(`priority must be one of: ${VALID_PRIORITY.join(', ')}`);
    if (status && !VALID_STATUS.includes(status)) throw new Error(`status must be one of: ${VALID_STATUS.join(', ')}`);
    if (title !== undefined && !String(title).trim()) throw new Error('title cannot be empty');
    const cleanTitle = title === undefined ? undefined : String(title).replace(/[\t\r\n]+/g, ' ').trim();

    const existing = (await readTSV(tasksFile)).find(r => r.ID === taskId);
    if (!existing) return null;

    const updated = { ...existing };
    if (cleanTitle !== undefined) updated.TITLE = cleanTitle;
    if (priority) updated.PRIORITY = priority;
    if (status) updated.STATUS = status;
    if (status === 'done' && existing.STATUS !== 'done') updated.DONE_AT = new Date().toISOString().slice(0, 10);
    if (status && status !== 'done') updated.DONE_AT = '-';
    if (due_date !== undefined) updated.DUE_DATE = due_date || '-';
    if (start_date !== undefined) updated.START_DATE = start_date || '-';
    if (tag !== undefined) updated.TAG = tag || '-';
    if (assignee !== undefined) updated.ASSIGNEE = assignee || '-';

    await rewriteTSV(tasksFile, rows => rows.map(r => r.ID === taskId ? updated : r));

    const jiraKey = (updated.JIRA_KEY && updated.JIRA_KEY !== '-') ? updated.JIRA_KEY : null;
    let jiraResult = null;
    if (jira && jiraKey && (cleanTitle !== undefined || priority || due_date !== undefined || tag !== undefined)) {
      jiraResult = await jira.jiraUpdateIssue(jiraKey, {
        summary: cleanTitle, priority,
        ...(due_date !== undefined ? { duedate: due_date || '' } : {}),
        ...(tag !== undefined ? { labels: tag ? [tag] : [] } : {}),
      });
    }
    if (jira && jiraKey && assignee !== undefined) await jira.jiraAssignIssue(jiraKey, assignee || null);
    if (jira && jiraKey && (status === 'done' || status === 'review')) {
      const candidates = status === 'review' ? ['In Review', 'Review', 'In Progress'] : ['Done'];
      for (const name of candidates) {
        const t = await jira.jiraTransitionIssue(jiraKey, name);
        if (t?.success) break;
      }
    }

    auditLog.log('task_updated', { taskId, jiraKey,
      changed: Object.keys({ ...(cleanTitle !== undefined && { title: 1 }), ...(priority && { priority: 1 }),
                             ...(status && { status: 1 }), ...(due_date && { due_date: 1 }) }) });
    return { task: updated, jira: jiraResult };
  }

  /** If a Jira issue is linked, delete it FIRST -- a Jira failure keeps the local row, so the two never silently diverge. */
  async function deleteTask({ taskId, deleteJira = true }) {
    if (!taskId) throw new Error('taskId required');
    const target = (await readTSV(tasksFile)).find(r => r.ID === taskId);
    if (!target) return null;

    const jiraKey = (target.JIRA_KEY && target.JIRA_KEY !== '-') ? target.JIRA_KEY : null;
    let jiraResult = null;
    if (jira && jiraKey && deleteJira) {
      jiraResult = await jira.jiraDeleteIssue(jiraKey);
      if (!jiraResult.success) return { failed: true, taskId, jiraKey, jira: jiraResult };
    }

    const removed = await rewriteTSV(tasksFile, rows => rows.filter(r => r.ID !== taskId));
    auditLog.log('task_deleted', { taskId, jiraKey, removedRows: removed });
    return { failed: false, taskId, jiraKey, jira: jiraResult, verified: true };
  }

  /** Completing is two different intents: "I finished it" vs "someone else must check it" -- `target` picks which. */
  async function completeTask({ taskId, jiraKey, target = 'done' }) {
    if (!['done', 'review'].includes(target)) throw new Error("target must be 'done' or 'review'");
    const existing = (await readTSV(tasksFile)).find(r => r.ID === taskId);
    let targetJiraKey = jiraKey || null;
    if (existing) {
      const updated = { ...existing, STATUS: target, DONE_AT: target === 'done' ? new Date().toISOString().slice(0, 10) : '-' };
      if (!targetJiraKey && existing.JIRA_KEY && existing.JIRA_KEY !== '-') targetJiraKey = existing.JIRA_KEY;
      await rewriteTSV(tasksFile, rows => rows.map(r => r.ID === taskId ? updated : r));
    }

    let jiraResult = null;
    if (jira && targetJiraKey) {
      const candidates = target === 'review' ? ['In Review', 'Review', 'In Progress'] : ['Done'];
      for (const name of candidates) {
        jiraResult = await jira.jiraTransitionIssue(targetJiraKey, name);
        if (jiraResult?.success) break;
      }
      auditLog.log('task_completed_jira_synced', { taskId, jiraKey: targetJiraKey, target, result: jiraResult });
    } else {
      auditLog.log('task_completed_local', { taskId, target });
    }
    return { taskId, target, jiraKey: targetJiraKey, jira: jiraResult };
  }

  return { listTasks, getTask, createTask, updateTask, deleteTask, completeTask, stripDashes };
}

module.exports = { createTasksClient, VALID_PRIORITY, VALID_STATUS, stripDashes };

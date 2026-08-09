'use strict';
/**
 * The Jira Gate: preview then push, never a silent post. Ported from
 * isconl-agent's server.js (preview ~11107-11181, push ~11274-11342, the
 * readiness checklist ~2689-2712).
 *
 * The live board is the one surface other people watch, so nothing reaches
 * it without being looked at first. PREVIEW writes nothing -- it returns the
 * exact issue that would be created plus an honest list of what's still
 * vague. PUSH enforces the same checklist server-side (not just in the
 * preview, which is advice) because issues can't be deleted from this board
 * without an admin, so an incomplete one shouldn't land there by accident.
 *
 * OUT OF SCOPE (deliberate, same reasoning as tasks.js's exclusions):
 * /api/jira/compose, which asks a model to write the summary/description --
 * a `spark` (AI routing) capability this would only be borrowing.
 *
 * CROSS-ENGINE (injected, same reasoning as everywhere else in this split):
 * tagVocabulary and readBriefs both draw on data this engine doesn't own
 * (circle's career orgs, an unassigned Spaces/Axial-tree capability, and
 * spark's future task-brief cache) -- optional, default to empty so preview
 * still works standalone.
 */

function jiraReadiness(task, payload, tags) {
  const tag = tags.find(t => t.id === (task.TAG && task.TAG !== '-' ? task.TAG : ''));
  const summary = String(payload.summary || '').trim();
  return [
    { id: 'summary', ok: summary.length >= 12 && summary.split(/\s+/).length >= 3,
      label: 'Summary states an outcome', missing: 'the summary is too thin',
      hint: 'Under three words reads as a placeholder to everyone else on the board.' },
    { id: 'description', ok: String(payload.description || '').trim().length >= 40,
      label: 'Description is filled in', missing: 'no description',
      hint: 'Explain the task, then Compose writes this from the explanation.' },
    { id: 'duedate', ok: /^\d{4}-\d{2}-\d{2}$/.test(payload.duedate || ''),
      label: 'Has a date', missing: 'no date',
      hint: 'An undated issue does not appear in any timeline.' },
    { id: 'tag', ok: Boolean(tag),
      label: 'Tagged', missing: 'not tagged',
      hint: 'Tag it so work, personal and space items stay separable on one board.' },
    { id: 'assignee', ok: Boolean(payload.assignee),
      label: 'Has an owner', missing: 'no owner',
      hint: 'Unassigned issues belong to nobody.' },
  ];
}

function createJiraGateClient(opts) {
  const {
    readTSV, rewriteTSV,
    auditLog = { log: () => {} },
    jira,                              // required -- the object createJiraClient() returns
    getConfig,                         // required -- same shape jira's getConfig uses (host/email/token/projectKey)
    tagVocabulary = () => [],
    readBriefs = () => ({}),
    tasksFile = 'scope/tasks.tsv',
  } = opts;
  if (!readTSV || !rewriteTSV) throw new Error('createJiraGateClient requires readTSV/rewriteTSV');
  if (!jira) throw new Error('createJiraGateClient requires jira (a createJiraClient() instance)');
  if (!getConfig) throw new Error('createJiraGateClient requires getConfig');

  function val(v) { return v && v !== '-' ? v : ''; }

  async function preview(taskId) {
    const task = (await readTSV(tasksFile)).find(r => r.ID === taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const brief = (readBriefs() || {})[taskId] || null;
    const descParts = [];
    if (brief?.jira) descParts.push(String(brief.jira));
    else {
      if (brief?.done) descParts.push(`Done when: ${brief.done}`);
      if (brief?.steps?.length) descParts.push(brief.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'));
    }

    const tags = tagVocabulary();
    const tag = tags.find(t => t.id === val(task.TAG));

    const cfg = getConfig();
    const users = await jira.jiraAssignableUsers({}).catch(() => []);
    const me = users.find(u => cfg.email && String(u.email || '').toLowerCase() === String(cfg.email).toLowerCase());
    const assignee = val(task.ASSIGNEE) || me?.accountId || '';

    const payload = {
      summary: task.TITLE, description: descParts.join('\n\n'), issueType: 'Task',
      priority: val(task.PRIORITY) || 'medium', duedate: val(task.DUE_DATE), startdate: val(task.START_DATE),
      labels: tag ? [tag.id] : [], assignee,
    };
    const ready = jiraReadiness(task, payload, tags);

    let canDelete = false;
    try {
      const perms = await jira.jiraAPI('GET', `/rest/api/3/mypermissions?projectKey=${encodeURIComponent(cfg.projectKey || '')}&permissions=DELETE_ISSUES`);
      canDelete = Boolean(perms?.data?.permissions?.DELETE_ISSUES?.havePermission);
    } catch { /* assume not, the safe direction */ }

    return { success: true, taskId, payload, ready, canDelete,
      alreadyPushed: val(task.JIRA_KEY) || null, project: cfg.projectKey || null, host: cfg.host || null, tags, users };
  }

  async function push(p) {
    const task = (await readTSV(tasksFile)).find(r => r.ID === p.taskId);
    if (!task) throw new Error(`Task ${p.taskId} not found`);
    if (task.JIRA_KEY && task.JIRA_KEY !== '-') throw new Error(`Already on the board as ${task.JIRA_KEY}`);

    const summary = String(p.summary || task.TITLE).trim();
    if (!summary) throw new Error('Summary cannot be empty');

    const ready = jiraReadiness(
      { ...task, TAG: p.labels?.[0] || task.TAG },
      { summary, description: p.description, duedate: p.duedate, assignee: p.assignee },
      tagVocabulary(),
    );
    const failing = ready.filter(c => !c.ok);
    if (failing.length && !p.force) {
      auditLog.log('jira_push_blocked', { taskId: p.taskId, failing: failing.map(f => f.id) });
      return { success: false, blocked: true, ready,
        error: `Not ready - ${failing.map(f => f.missing).join(', ')}. Issues cannot be deleted from this board, so incomplete ones are not pushed.` };
    }

    const created = await jira.jiraCreateIssue(summary, p.description || '', p.issueType || 'Task', {
      duedate: p.duedate, labels: Array.isArray(p.labels) ? p.labels : [], priority: p.priority, assignee: p.assignee,
    });
    if (!created?.key) return { success: false, error: created?.error || 'Jira rejected the issue' };

    await rewriteTSV(tasksFile, rows => rows.map(r => r.ID === p.taskId ? {
      ...r, JIRA_KEY: created.key, TITLE: summary, DUE_DATE: p.duedate || r.DUE_DATE, ASSIGNEE: p.assignee || r.ASSIGNEE,
    } : r));

    auditLog.log('jira_issue_pushed', { taskId: p.taskId, key: created.key, labels: p.labels,
      duedate: p.duedate || null, assigned: Boolean(p.assignee), unsupported: created.unsupportedFields || [] });
    return { success: true, key: created.key, unsupportedFields: created.unsupportedFields || [] };
  }

  return { preview, push, jiraReadiness };
}

module.exports = { createJiraGateClient, jiraReadiness };

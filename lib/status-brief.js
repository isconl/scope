'use strict';
/**
 * BA26082420: the weekly status-brief -- gathers one subject's week of
 * real activity (tasks + circle interactions), sends it to spark to draft
 * signal/substance/trajectory bullets (never authored deterministically
 * here -- that's the AI's one job, per canon's "AI drafts one field,
 * never a whole doc" rule), stores the draft for Architect to review, and
 * sends it via email once he approves (WhatsApp send is a real capability
 * gap, deliberately deferred to its own plan.md row per the row's own
 * resolution -- not attempted here).
 */

function clean(s) { return String(s || '').replace(/[\t\r\n]+/g, ' ').trim() || '-'; }

function mondayOf(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day; // ISO week: Monday start
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function daysAgo(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return Infinity;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}

function createStatusBriefClient(opts) {
  const {
    readTSV, appendTSV, rewriteTSV,
    auditLog = { log: () => {} },
    callSpark,        // async (query) => {ok, data|error} -- POST /generate-status-brief
    sendMail,         // async ({to, subject, body}) => {ok, error} -- cross-engine to vault's /graph/mail/send
    subjectsFile = 'scope/active_subjects.tsv',
    briefsFile = 'scope/status_briefs.tsv',
    tasksFile = 'scope/tasks.tsv',
    interactionsFile = 'circle/interactions.tsv',
  } = opts;
  if (!readTSV || !appendTSV) throw new Error('createStatusBriefClient requires readTSV/appendTSV');
  if (!callSpark) throw new Error('createStatusBriefClient requires callSpark');

  async function gatherActivity(subject) {
    const [tasks, interactions] = await Promise.all([
      readTSV(tasksFile).catch(() => []),
      readTSV(interactionsFile).catch(() => []),
    ]);
    const taskActivity = tasks
      .filter(t => t.ORG_ID === subject.SOURCE_REF && daysAgo(t.CREATED_AT) <= 7)
      .map(t => ({ date: t.CREATED_AT, kind: 'task', summary: t.TITLE }));
    const interactionActivity = interactions
      .filter(i => daysAgo(i.DATE) <= 7)
      .map(i => ({ date: i.DATE, kind: 'interaction', summary: i.SUMMARY }));
    return [...taskActivity, ...interactionActivity].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  async function listBriefs(filter = {}) {
    const rows = await readTSV(briefsFile);
    return rows.filter(r => !filter.subjectId || r.SUBJECT_ID === filter.subjectId).map(r => ({
      ...r,
      SIGNAL: JSON.parse(r.SIGNAL || '[]'),
      SUBSTANCE: JSON.parse(r.SUBSTANCE || '[]'),
      TRAJECTORY: JSON.parse(r.TRAJECTORY || '[]'),
    }));
  }

  /** Drafts one brief for one subject. Never sends -- draft only, per
   *  the row's UI-first distribution model (Architect reviews before send). */
  async function draftBrief(subjectId) {
    const subjects = await readTSV(subjectsFile);
    const subject = subjects.find(s => s.SUBJECT_ID === subjectId);
    if (!subject) throw new Error(`no subject ${subjectId}`);
    const activity = await gatherActivity(subject);
    const r = await callSpark({ subjectName: subject.SOURCE_REF, supervisorName: subject.SUPERVISOR_OR_CONTACT, activity });
    if (!r.ok) return { success: false, error: r.error };

    const rows = await readTSV(briefsFile);
    const n = rows.reduce((m, row) => Math.max(m, parseInt(String(row.ID).replace(/\D/g, ''), 10) || 0), 0) + 1;
    const row = {
      ID: `SB${String(n).padStart(4, '0')}`,
      SUBJECT_ID: subjectId,
      WEEK_OF: mondayOf(new Date()),
      SIGNAL: JSON.stringify(r.data.signal || []),
      SUBSTANCE: JSON.stringify(r.data.substance || []),
      TRAJECTORY: JSON.stringify(r.data.trajectory || []),
      STATUS: 'draft',
      SENT_VIA: '-',
      SENT_AT: '-',
      CREATED_AT: new Date().toISOString().slice(0, 10),
    };
    await appendTSV(briefsFile, row);
    auditLog.log('status_brief_drafted', { id: row.ID, subjectId });
    return { success: true, id: row.ID, brief: row };
  }

  /** Drafts a brief for every active subject -- what the Friday scheduler
   *  calls. A subject a draft fails for does not block the others. */
  async function draftAllBriefs() {
    const subjects = await readTSV(subjectsFile);
    const results = [];
    for (const s of subjects.filter(s => s.STATUS !== 'retired')) {
      results.push({ subjectId: s.SUBJECT_ID, ...(await draftBrief(s.SUBJECT_ID).catch(e => ({ success: false, error: String(e.message || e) }))) });
    }
    return { drafted: results.filter(r => r.success).length, results };
  }

  /** Explicit send, never automatic -- a human clicks "send via email" in
   *  the UI. WhatsApp is NOT implemented (real capability gap, see the
   *  row's own resolution) -- refuses cleanly rather than silently no-op. */
  async function sendBrief(briefId, { via, to } = {}) {
    if (via === 'whatsapp') return { success: false, error: 'WhatsApp send is not built yet -- see plan.md follow-up' };
    if (via !== 'email') return { success: false, error: 'via must be "email" (WhatsApp not built yet)' };
    if (!sendMail) return { success: false, error: 'sendMail not configured' };
    if (!to) return { success: false, error: 'to required' };
    const rows = await readTSV(briefsFile);
    const brief = rows.find(r => r.ID === briefId);
    if (!brief) throw new Error(`no brief ${briefId}`);
    const signal = JSON.parse(brief.SIGNAL || '[]');
    const substance = JSON.parse(brief.SUBSTANCE || '[]');
    const trajectory = JSON.parse(brief.TRAJECTORY || '[]');
    const body = [
      `Signal:\n${signal.map(s => `- ${s}`).join('\n') || '(none)'}`,
      `Substance:\n${substance.map(s => `- ${s}`).join('\n') || '(none)'}`,
      `Trajectory:\n${trajectory.map(s => `- ${s}`).join('\n') || '(none)'}`,
    ].join('\n\n');
    const r = await sendMail({ to, subject: `Weekly status brief -- ${brief.SUBJECT_ID} (week of ${brief.WEEK_OF})`, body });
    if (!r.ok) return { success: false, error: r.error };
    if (rewriteTSV) {
      await rewriteTSV(briefsFile, (rows2) => rows2.map(r2 => r2.ID === briefId
        ? { ...r2, STATUS: 'sent', SENT_VIA: 'email', SENT_AT: new Date().toISOString().slice(0, 10) }
        : r2));
    }
    auditLog.log('status_brief_sent', { id: briefId, via: 'email' });
    return { success: true };
  }

  return { gatherActivity, listBriefs, draftBrief, draftAllBriefs, sendBrief, mondayOf };
}

module.exports = { createStatusBriefClient };

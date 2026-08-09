'use strict';
/**
 * The Decision Log, read and kept current. Ported from isconl-agent's
 * server.js (~10976-11080).
 *
 * Two rules keep it current without anyone remembering to maintain it:
 *  1. Task movement writes back (handled by the caller -- delivery/done
 *     endpoints append a dated movement line to every decision a task
 *     cites; that coupling isn't reproduced here, this module just reads).
 *  2. Staleness is computed, not noticed: a PENDING decision whose citing
 *     tasks are all delivered is flagged until someone updates its status.
 *
 * CROSS-ENGINE: the log itself lives in `career/orgs/<org>/decision_log.yaml`
 * -- circle's career vault, not scope's. Reading it (org name, decisions,
 * risks) is an injected fetcher (`getCareerContext`), same reasoning as
 * every other cross-engine read in this split. Writing it needs the raw
 * file (surgical line-editing preserves comments/formatting a re-serialize
 * would eat) -- `getActiveOrgId`/`readCareerFile`/`writeCareerFile` are
 * injected for the same reason. Citing/staleness math against tasks is the
 * one piece that's genuinely scope's, since it reads scope/tasks.tsv.
 */

function createDecisionsClient(opts) {
  const {
    readTSV,
    auditLog = { log: () => {} },
    getCareerContext = async () => ({ decisions: [], risks: [], orgName: null }),
    getActiveOrgId = async () => null,
    readCareerFile = async () => null,
    writeCareerFile = async () => {},
    keepPreviousVersion = async () => {},
    tasksFile = 'scope/tasks.tsv',
  } = opts;
  if (!readTSV) throw new Error('createDecisionsClient requires readTSV');

  async function listDecisions() {
    const ctx = await getCareerContext();
    const tasks = readTSV(tasksFile);
    const list = (ctx.decisions || []).map(d => {
      const citing = tasks.filter(t => new RegExp(`\\b${d.id}\\b`, 'i').test(t.TITLE || ''));
      const open = citing.filter(t => !['done', 'review'].includes(t.STATUS));
      const pending = /PENDING|OPEN|DRAFT/i.test(d.status || '');
      const daysOld = d.date ? Math.floor((Date.now() - new Date(d.date).getTime()) / 86400000) : null;
      return {
        ...d,
        citing: citing.map(t => ({ id: t.ID, status: t.STATUS, delivery: t.DELIVERY })),
        stale: pending && citing.length > 0 && open.length === 0,
        aging: pending && daysOld !== null && daysOld >= 5 ? daysOld : null,
      };
    });
    return {
      decisions: list,
      stale: list.filter(d => d.stale).map(d => d.id),
      risks: (ctx.risks || []).map(r => ({ id: r.id, title: r.title || r.risk || '',
        severity: r.severity || '', protection: r.protection || '', evidence: r.evidence || '' })),
      org: ctx.orgName || null,
      source: 'career/orgs decision_log.yaml',
    };
  }

  /** Update or append one decision block, preserving the file's own YAML shape -- line-surgery, not a reserialize. */
  async function updateDecision(p) {
    const id = String(p.id || '').toUpperCase().trim();
    if (!/^D-\d{1,3}$/.test(id)) throw new Error('id must look like D-030');

    const orgId = await getActiveOrgId();
    if (!orgId) throw new Error('No active org in career/_active.yaml');
    const relPath = `career/orgs/${orgId}/decision_log.yaml`;
    const before = await readCareerFile(relPath);
    if (before == null) throw new Error(`${relPath} not found`);

    const lines = before.split(/\r?\n/);
    const startIdx = lines.findIndex(l => new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`, 'i').test(l));
    let after;

    if (startIdx === -1) {
      if (!p.decision) throw new Error(`${id} is not on record - provide 'decision' to create it`);
      const block = [
        '', `  - id: ${id}`,
        `    date: "${String(p.date || new Date().toISOString().slice(0, 10))}"`,
        `    decision: ${String(p.decision).replace(/[\r\n]+/g, ' ')}`,
        `    status: ${String(p.status || 'OPEN').replace(/[\r\n]+/g, ' ')}`,
        `    by: ${String(p.by || '-').replace(/[\r\n]+/g, ' ')}`,
        `    note: ${String(p.note || '-').replace(/[\r\n]+/g, ' ')}`,
      ].join('\n');
      after = before.replace(/\s*$/, '\n') + block + '\n';
    } else {
      let endIdx = lines.length;
      for (let i = startIdx + 1; i < lines.length; i++) {
        if (/^\s*-\s*id:/.test(lines[i])) { endIdx = i; break; }
      }
      const block = lines.slice(startIdx, endIdx);
      const setField = (field, value) => {
        const i = block.findIndex(l => new RegExp(`^\\s{4}${field}:`).test(l));
        const line = `    ${field}: ${String(value).replace(/[\r\n]+/g, ' ')}`;
        if (i >= 0) block[i] = line; else block.push(line);
      };
      if (p.status) setField('status', p.status);
      if (p.note) setField('note', p.note);
      if (p.appendNote) {
        const i = block.findIndex(l => /^\s{4}note:/.test(l));
        const addition = String(p.appendNote).replace(/[\r\n]+/g, ' ');
        if (i >= 0) block[i] = `${block[i].replace(/\s+$/, '')} ${addition}`;
        else block.push(`    note: ${addition}`);
      }
      after = [...lines.slice(0, startIdx), ...block, ...lines.slice(endIdx)].join('\n');
    }

    await keepPreviousVersion(relPath, before, 'decision-update');
    await writeCareerFile(relPath, after);
    auditLog.log('decision_updated', { id, created: startIdx === -1,
      fields: ['status', 'note', 'appendNote', 'decision'].filter(k => p[k]).join(',') });
    return { success: true, id, created: startIdx === -1 };
  }

  return { listDecisions, updateDecision };
}

module.exports = { createDecisionsClient };

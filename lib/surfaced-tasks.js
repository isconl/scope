'use strict';
/**
 * Surfaced tasks (BG26082401): a second, distinct feed for session-derived
 * "surface this to Architect" items -- separate from `scope/inbox.tsv` on
 * purpose. inbox.tsv's SOURCE column is already fully used as a per-message
 * dedup key (`chatimport:{personId}:{direction}:{date}:{bodyPrefix}`, see
 * circle/lib/chat-import.js) -- overloading it with a `system`/`derived`
 * value would collide with its actual purpose and break that dedup check.
 * This is what WV26082101's original "keep me informed" ask, and any
 * future session hitting the same need, writes into from now on.
 */

function clean(s) { return String(s || '').replace(/[\t\r\n]+/g, ' ').trim() || '-'; }

function createSurfacedTasksClient(opts) {
  const {
    readTSV, appendTSV, rewriteTSV,
    auditLog = { log: () => {} },
    surfacedFile = 'scope/surfaced_tasks.tsv',
  } = opts;
  if (!readTSV || !appendTSV || !rewriteTSV) throw new Error('createSurfacedTasksClient requires readTSV/appendTSV/rewriteTSV');

  function nextId(rows) {
    const n = rows.reduce((m, r) => Math.max(m, parseInt(String(r.ID).replace(/\D/g, ''), 10) || 0), 0) + 1;
    return `ST${String(n).padStart(4, '0')}`;
  }

  async function listSurfaced(filter = {}) {
    const rows = await readTSV(surfacedFile);
    return rows.filter(r => !filter.status || r.STATUS === filter.status);
  }

  async function addSurfaced(p) {
    const title = String(p.title || '').trim();
    if (!title) throw new Error('a surfaced item needs a title');
    const rows = await readTSV(surfacedFile);
    const row = {
      ID: nextId(rows),
      TITLE: clean(title),
      BODY: clean(p.body),
      STATUS: 'new',
      VIEW: clean(p.view),
      REF: clean(p.ref),
      ORIGIN: clean(p.origin),
      CREATED_AT: new Date().toISOString().slice(0, 10),
    };
    await appendTSV(surfacedFile, row);
    auditLog.log('surfaced_task_added', { id: row.ID, origin: row.ORIGIN, view: row.VIEW });
    return { success: true, id: row.ID };
  }

  async function updateSurfaced(p) {
    const id = String(p.id || '').trim();
    if (!id) throw new Error('id required');
    if (!['new', 'seen', 'dismissed'].includes(p.status)) throw new Error('status must be new/seen/dismissed');
    let found = false;
    await rewriteTSV(surfacedFile, rows => rows.map(r => {
      if (r.ID !== id) return r;
      found = true;
      return { ...r, STATUS: p.status };
    }));
    if (!found) throw new Error(`no surfaced item ${id}`);
    auditLog.log('surfaced_task_updated', { id, status: p.status });
    return { success: true };
  }

  return { listSurfaced, addSurfaced, updateSurfaced };
}

module.exports = { createSurfacedTasksClient };

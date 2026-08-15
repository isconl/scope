'use strict';
/**
 * Planning & Strategy: the long-game goal board. Real data
 * (`scope/plans.tsv`) has been sitting synced in the vault the whole time
 * (21 real rows, including the standing net-worth target) -- there was
 * simply never a route to serve it. `/api/plans` and `/api/plans/add`
 * were both still `legacy: true` (a 501) in hub's api-compat.js until
 * 2026-08-16, so the Planning view's PLANS array was permanently `[]`.
 */

const HORIZONS = ['cycle', 'sprint', 'quarter', 'year', '5y', 'decade'];

function createPlansClient(opts) {
  const { readTSV, appendTSV, rewriteTSV, auditLog = { log: () => {} }, plansFile = 'scope/plans.tsv', tasksFile = 'scope/tasks.tsv' } = opts;
  if (!readTSV || !appendTSV) throw new Error('createPlansClient requires readTSV/appendTSV');

  /** Every plan needs a `tasks` array present -- the frontend (app.js's
   *  renderPlanning, "Distill to tasks"/"Distill more" buttons) reads
   *  `.tasks.length` unconditionally, not defensively, so a bare plan row
   *  crashes the whole view rather than just rendering as empty. Tasks
   *  distilled FROM a plan carry `ORIGIN: "plan:<planId>..."` (set by
   *  planDistill's task-creation call, not this module). */
  async function listPlans() {
    const [plans, tasks] = await Promise.all([readTSV(plansFile), readTSV(tasksFile)]);
    const out = plans.map(p => ({
      ...p,
      tasks: tasks.filter(t => String(t.ORIGIN || '').startsWith(`plan:${p.ID}`))
        .map(t => ({ ID: t.ID, TITLE: t.TITLE, STATUS: t.STATUS, DUE_DATE: t.DUE_DATE, PRIORITY: t.PRIORITY })),
    }));
    return { plans: out };
  }

  async function addPlan(p) {
    const title = String(p.title || p.TITLE || '').trim();
    if (!title) throw new Error('state the goal first');
    const horizon = HORIZONS.includes(p.horizon || p.HORIZON) ? (p.horizon || p.HORIZON) : 'cycle';
    const clean = (s) => String(s || '').replace(/[\t\r\n]+/g, ' ').trim() || '-';
    const existing = await readTSV(plansFile);
    const n = existing.reduce((m, r) => Math.max(m, parseInt(String(r.ID).replace(/\D/g, ''), 10) || 0), 0) + 1;
    const row = {
      ID: `P${String(n).padStart(3, '0')}`,
      TITLE: clean(title), HORIZON: horizon, TAG: clean(p.tag || p.TAG),
      STATUS: 'active', CREATED_AT: new Date().toISOString().slice(0, 10), NOTE: clean(p.note || p.NOTE),
    };
    await appendTSV(plansFile, row);
    auditLog.log('plan_added', { id: row.ID, horizon });
    return { success: true, id: row.ID, plan: { ...row, tasks: [] } };
  }

  /** Status change (e.g. planSetStatus('achieved')) -- the frontend calls
   *  this expecting the legacy /api/plans/update contract. */
  async function updatePlan(p) {
    const id = String(p.id || p.ID || '').trim();
    if (!id) throw new Error('id required');
    if (!rewriteTSV) throw new Error('createPlansClient requires rewriteTSV for updates');
    let found = false;
    await rewriteTSV(plansFile, rows => rows.map(r => {
      if (r.ID !== id) return r;
      found = true;
      return { ...r, ...(p.status ? { STATUS: p.status } : {}), ...(p.note !== undefined ? { NOTE: String(p.note || '-') } : {}) };
    }));
    if (!found) throw new Error(`no plan ${id}`);
    auditLog.log('plan_updated', { id, status: p.status });
    return { success: true };
  }

  return { listPlans, addPlan, updatePlan };
}

module.exports = { createPlansClient };

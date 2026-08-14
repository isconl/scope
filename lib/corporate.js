'use strict';
/**
 * Corporate Engagements -- the aggregator behind the hub "Corporate" space.
 *
 * Per hub/docs/corporate-engagements-plan.md: this does NOT re-read
 * career/** itself (circle/lib/career.js already does, and now serves it
 * over HTTP at GET /career -- see circle/src/server.js). This module is a
 * consumer, same shape as lib/decisions.js: an injected `getCareerContext`
 * reaches circle over HTTP, this file's own job is the cross-engine merge
 * (career facts + this engine's own task counts) and the per-engagement
 * shaping the UI actually wants.
 *
 * v1 is READ-ONLY on purpose (hub/docs/corporate-engagements-plan.md
 * §6.3: read-only endpoints before any write path). Status toggling
 * (active/past) and connections (Gmail/M365) are a later phase -- this
 * file exists to get real data on screen first.
 */

function createCorporateClient(opts) {
  const {
    readTSV,
    auditLog = { log: () => {} },
    getCareerContext = async () => ({ activeOrg: null, orgs: [], available: false }),
    tasksFile = 'scope/tasks.tsv',
  } = opts;
  if (!readTSV) throw new Error('createCorporateClient requires readTSV');

  /** Open/overdue task counts for one org, matched the same way decisions.js
   *  matches citing tasks -- by the org id or name appearing in the task's
   *  TAG or TITLE. Cheap and deterministic; no cross-engine task-tagging
   *  scheme exists yet to do this more precisely. */
  function taskStats(tasks, org) {
    const today = new Date().toISOString().slice(0, 10);
    const needle = new RegExp(`\\b${(org.id || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const nameNeedle = org.name ? new RegExp(`\\b${org.name.split(/[\s/]+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null;
    const tagged = tasks.filter(t => (t.TAG && needle.test(t.TAG)) ||
      needle.test(t.TITLE || '') || (nameNeedle && nameNeedle.test(t.TITLE || '')));
    const open = tagged.filter(t => t.STATUS !== 'done');
    const overdue = open.filter(t => t.DUE_DATE && t.DUE_DATE !== '-' && t.DUE_DATE < today);
    return { tagged: tagged.length, open: open.length, overdue: overdue.length };
  }

  /** List every known engagement, active org's stats live, others as a stub
   *  (org.yaml/decision log for a non-active org is not readable through
   *  circle's current /career route -- it only resolves the active org,
   *  per career.js's own design. Listing still needs every org's identity,
   *  which _active.yaml's own `orgs:` registry already carries). */
  async function listEngagements() {
    const ctx = await getCareerContext();
    const tasks = await readTSV(tasksFile).catch(() => []);

    const engagements = (ctx.orgs || []).map(org => {
      const isActive = org.id === ctx.activeOrg;
      return {
        id: org.id,
        name: org.name,
        role: org.role,
        status: org.status,
        active: isActive,
        stats: isActive
          ? { ...taskStats(tasks, org), decisions: (ctx.decisions || []).length,
              decisionsPending: (ctx.decisions || []).filter(d => /PENDING/i.test(d.status || '')).length,
              risks: (ctx.risks || []).length, people: (ctx.people || []).length }
          : null,   // not the active org -- career.js only overlays the active one; see note above
      };
    });

    return { engagements, activeOrg: ctx.activeOrg || null, available: Boolean(ctx.available) };
  }

  /** One engagement, in full -- the "Corporate" detail screen's data source.
   *  Only ever returns real detail for the currently active org (same
   *  constraint as listEngagements); a request for any other id gets back
   *  its registry-level identity plus an explicit note why detail isn't
   *  available, never a silent empty page. */
  async function getEngagement(orgId) {
    const ctx = await getCareerContext();
    const tasks = await readTSV(tasksFile).catch(() => []);
    const stub = (ctx.orgs || []).find(o => o.id === orgId);
    if (!stub) return null;

    if (orgId !== ctx.activeOrg) {
      return { id: stub.id, name: stub.name, role: stub.role, status: stub.status,
        active: false, detail: null,
        note: 'Only the active engagement (career/_active.yaml) has full detail today -- switch active_org to load this one.' };
    }

    return {
      id: stub.id, name: stub.name, role: stub.role, status: stub.status, active: true,
      stats: { ...taskStats(tasks, stub), decisions: (ctx.decisions || []).length,
        risks: (ctx.risks || []).length, people: (ctx.people || []).length },
      people: ctx.people || [],
      decisions: ctx.decisions || [],
      risks: ctx.risks || [],
      playbooks: (ctx.playbooks || []).map(p => ({ id: p.id, name: p.name })),
      doctrine: ctx.doctrine || {},
    };
  }

  return { listEngagements, getEngagement };
}

module.exports = { createCorporateClient };

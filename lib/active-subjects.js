'use strict';
/**
 * BA26082420: unified subject registry for the weekly status-brief.
 * Not a live-query-three-sources approach -- a real TSV collection,
 * synced (idempotent, re-runnable) from career/orgs (via circle's
 * getCareerContext, cross-engine) and circle/people.tsv (direct vault
 * read, same collection every engine already shares).
 *
 * TYPE: 'engagement' (an org from career/orgs) or 'owner' (a venture
 * Architect runs himself). Per Architect: "model it now, even with no current
 * owned company populating it" -- the schema/sync logic supports 'owner'
 * as a first-class type, but sync itself only ever produces 'engagement'
 * rows today, because career/orgs has no owner-type entry yet. Adding a
 * real owner row (a company Architect runs) is a manual addUpdate() call
 * whenever that becomes real -- not fabricated here.
 */

function clean(s) { return String(s || '').replace(/[\t\r\n]+/g, ' ').trim() || '-'; }

function resolveSupervisor(people, orgId) {
  // people.tsv's GROUP is often a shorthand of the org id (found live:
  // GROUP:"viva" for org id "viva-valentia") -- substring match either
  // direction, not strict equality, or every real org fails to resolve.
  const org = String(orgId || '').toLowerCase();
  const inOrg = people.filter(p => {
    const group = String(p.GROUP || '').toLowerCase();
    return group && org && (org === group || org.includes(group) || group.includes(org));
  });
  const supervisor = inOrg.find(p => /supervisor/i.test(p.ROLE || ''));
  if (supervisor) return supervisor.NAME;
  // Fall back to the highest-authority-sounding role in the org if no
  // literal "supervisor" role exists -- never invent a name.
  const authority = inOrg.find(p => /ceo|final authority|founder/i.test(p.ROLE || ''));
  return authority ? authority.NAME : '-';
}

function createActiveSubjectsClient(opts) {
  const {
    readTSV, appendTSV, rewriteTSV,
    auditLog = { log: () => {} },
    getCareerContext = async () => ({ orgs: [], people: [] }),
    subjectsFile = 'scope/active_subjects.tsv',
  } = opts;
  if (!readTSV || !appendTSV || !rewriteTSV) throw new Error('createActiveSubjectsClient requires readTSV/appendTSV/rewriteTSV');

  async function listSubjects() {
    return readTSV(subjectsFile);
  }

  /** Idempotent: upserts one engagement row per enabled career/orgs entry.
   *  Never touches an existing 'owner' row (sync only ever produces
   *  'engagement' rows -- an owner row is added manually, separately). */
  async function syncFromCareer() {
    const ctx = await getCareerContext();
    const orgs = (ctx.orgs || []).filter(o => o.enabled !== false);
    const people = ctx.people && ctx.people.length ? ctx.people : await readTSV('circle/people.tsv');
    const existing = await readTSV(subjectsFile);
    let created = 0, updated = 0;

    await rewriteTSV(subjectsFile, (rows) => {
      const byRef = new Map(rows.filter(r => r.TYPE === 'engagement').map(r => [r.SOURCE_REF, r]));
      const kept = rows.filter(r => r.TYPE !== 'engagement'); // owner rows survive untouched
      const today = new Date().toISOString().slice(0, 10);
      for (const org of orgs) {
        const supervisor = resolveSupervisor(people, org.id);
        const prior = byRef.get(org.id);
        if (prior) {
          updated += 1;
          kept.push({ ...prior, STATUS: org.status || prior.STATUS, SUPERVISOR_OR_CONTACT: supervisor });
        } else {
          created += 1;
          const n = existing.reduce((m, r) => Math.max(m, parseInt(String(r.SUBJECT_ID).replace(/\D/g, ''), 10) || 0), 0) + created;
          kept.push({
            SUBJECT_ID: `SUBJ${String(n).padStart(3, '0')}`,
            TYPE: 'engagement',
            SOURCE_REF: org.id,
            STATUS: org.status || 'active',
            SUPERVISOR_OR_CONTACT: supervisor,
            CREATED_AT: today,
          });
        }
      }
      return kept;
    });
    auditLog.log('active_subjects_synced', { created, updated });
    return { created, updated };
  }

  /** Manual add for a TYPE:'owner' subject -- ventures Architect runs himself,
   *  never auto-populated (no source to sync from yet). */
  async function addOwnerSubject(p) {
    const sourceRef = String(p.sourceRef || p.source_ref || '').trim();
    if (!sourceRef) throw new Error('sourceRef required');
    const rows = await readTSV(subjectsFile);
    const n = rows.reduce((m, r) => Math.max(m, parseInt(String(r.SUBJECT_ID).replace(/\D/g, ''), 10) || 0), 0) + 1;
    const row = {
      SUBJECT_ID: `SUBJ${String(n).padStart(3, '0')}`,
      TYPE: 'owner',
      SOURCE_REF: clean(sourceRef),
      STATUS: clean(p.status) === '-' ? 'active' : clean(p.status),
      SUPERVISOR_OR_CONTACT: clean(p.supervisorOrContact || p.supervisor_or_contact),
      CREATED_AT: new Date().toISOString().slice(0, 10),
    };
    await appendTSV(subjectsFile, row);
    auditLog.log('active_subject_owner_added', { id: row.SUBJECT_ID, sourceRef });
    return { success: true, id: row.SUBJECT_ID, subject: row };
  }

  return { listSubjects, syncFromCareer, addOwnerSubject, resolveSupervisor };
}

module.exports = { createActiveSubjectsClient };

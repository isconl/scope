'use strict';
/**
 * BX26082424: two distinct record types for the B2B portals
 * (dev.b2bexchange.co / dev.b2bplatform.co), per Architect's resolution --
 * not one shared model.
 *
 * user_groups: a portal-wide role/account TYPE (broker, Country Manager,
 * HR/sourcing, etc -- the 5 known roles from WV26082405's credential set).
 * Describes a kind of account, not a specific transaction.
 *
 * deal_flow_parties: a role IN ONE TRANSACTION (buyer/seller/broker/
 * advisor), scoped to a specific listing/deal. The same person can be a
 * "broker" user-group account while being the "seller's advisor"
 * deal-flow-party on one listing and a plain "broker" party on another --
 * these are deliberately independent, not a foreign key from one to the
 * other.
 *
 * PERMISSIONS_NOTE is left free-text/'-' rather than a structured
 * permissions schema -- the row's own instruction is "don't invent
 * permission details blind" until WV26082405's portal walkthrough lands
 * real screenshots of what each role actually sees.
 */

const PORTALS = ['b2bexchange', 'b2bplatform'];
const USER_GROUP_TYPES = ['broker', 'broker2', 'country_manager', 'manager2', 'hr_sourcing'];
const PARTY_ROLES = ['buyer', 'seller', 'broker', 'advisor'];

function clean(s) { return String(s || '').replace(/[\t\r\n]+/g, ' ').trim() || '-'; }

function createPortalPartiesClient(opts) {
  const {
    readTSV, appendTSV,
    auditLog = { log: () => {} },
    userGroupsFile = 'scope/user_groups.tsv',
    dealFlowPartiesFile = 'scope/deal_flow_parties.tsv',
  } = opts;
  if (!readTSV || !appendTSV) throw new Error('createPortalPartiesClient requires readTSV/appendTSV');

  function nextId(prefix, rows) {
    const n = rows.reduce((m, r) => Math.max(m, parseInt(String(r.ID).replace(/\D/g, ''), 10) || 0), 0) + 1;
    return `${prefix}${String(n).padStart(4, '0')}`;
  }

  async function listUserGroups(filter = {}) {
    const rows = await readTSV(userGroupsFile);
    return rows.filter(r => !filter.portal || r.PORTAL === filter.portal);
  }

  async function addUserGroup(p) {
    const portal = String(p.portal || '').trim();
    const groupType = String(p.groupType || p.group_type || '').trim();
    if (!PORTALS.includes(portal)) throw new Error(`portal must be one of: ${PORTALS.join(', ')}`);
    if (!USER_GROUP_TYPES.includes(groupType)) throw new Error(`groupType must be one of: ${USER_GROUP_TYPES.join(', ')}`);
    const rows = await readTSV(userGroupsFile);
    const row = {
      ID: nextId('UG', rows),
      PORTAL: portal,
      GROUP_TYPE: groupType,
      LABEL: clean(p.label),
      PERMISSIONS_NOTE: clean(p.permissionsNote || p.permissions_note),
      CREATED_AT: new Date().toISOString().slice(0, 10),
    };
    await appendTSV(userGroupsFile, row);
    auditLog.log('user_group_added', { id: row.ID, portal, groupType });
    return { success: true, id: row.ID, userGroup: row };
  }

  /** Idempotent: seeds the 5 known role types for both portals if not
   *  already present -- the row's own concrete data model, not fabricated
   *  example data (these are the actual known account types, per
   *  WV26082405's credential set). Safe to call more than once. */
  async function seedKnownUserGroups() {
    const existing = await listUserGroups();
    const has = (portal, groupType) => existing.some(r => r.PORTAL === portal && r.GROUP_TYPE === groupType);
    let seeded = 0;
    for (const portal of PORTALS) {
      for (const groupType of USER_GROUP_TYPES) {
        if (has(portal, groupType)) continue;
        await addUserGroup({ portal, groupType, label: groupType.replace(/_/g, ' '), permissionsNote: '-' });
        seeded += 1;
      }
    }
    return { seeded };
  }

  async function listDealFlowParties(filter = {}) {
    const rows = await readTSV(dealFlowPartiesFile);
    return rows.filter(r => (!filter.portal || r.PORTAL === filter.portal) && (!filter.listingId || r.LISTING_ID === filter.listingId));
  }

  async function addDealFlowParty(p) {
    const portal = String(p.portal || '').trim();
    const partyRole = String(p.partyRole || p.party_role || '').trim();
    const listingId = String(p.listingId || p.listing_id || '').trim();
    if (!PORTALS.includes(portal)) throw new Error(`portal must be one of: ${PORTALS.join(', ')}`);
    if (!PARTY_ROLES.includes(partyRole)) throw new Error(`partyRole must be one of: ${PARTY_ROLES.join(', ')}`);
    if (!listingId) throw new Error('a deal-flow party needs a listingId');
    const rows = await readTSV(dealFlowPartiesFile);
    const row = {
      ID: nextId('DFP', rows),
      PORTAL: portal,
      LISTING_ID: listingId,
      PARTY_ROLE: partyRole,
      // A known contact links to circle/people.tsv by ID; otherwise a
      // portal-only identity is a free-text label -- exactly one of the two
      // is set, never both, since the row names these as alternatives.
      PERSON_ID: p.personId ? clean(p.personId) : '-',
      PORTAL_IDENTITY: p.personId ? '-' : clean(p.portalIdentity || p.portal_identity),
      CREATED_AT: new Date().toISOString().slice(0, 10),
    };
    await appendTSV(dealFlowPartiesFile, row);
    auditLog.log('deal_flow_party_added', { id: row.ID, portal, listingId, partyRole });
    return { success: true, id: row.ID, dealFlowParty: row };
  }

  return { listUserGroups, addUserGroup, seedKnownUserGroups, listDealFlowParties, addDealFlowParty };
}

module.exports = { createPortalPartiesClient, PORTALS, USER_GROUP_TYPES, PARTY_ROLES };

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPortalPartiesClient } = require('../lib/portal-parties');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: async (rel) => (data[rel] || []).slice(),
    appendTSV: async (rel, row) => { (data[rel] = data[rel] || []).push(row); return true; },
  };
}

test('addUserGroup rejects an unknown portal or group type', async () => {
  const client = createPortalPartiesClient(makeStore());
  await assert.rejects(() => client.addUserGroup({ portal: 'nope', groupType: 'broker' }), /portal must be one of/);
  await assert.rejects(() => client.addUserGroup({ portal: 'b2bexchange', groupType: 'nope' }), /groupType must be one of/);
});

test('addUserGroup persists a valid row', async () => {
  const store = makeStore();
  const client = createPortalPartiesClient(store);
  const r = await client.addUserGroup({ portal: 'b2bexchange', groupType: 'broker', label: 'Broker', permissionsNote: 'TBD' });
  assert.ok(r.success);
  assert.equal(store.data['scope/user_groups.tsv'][0].GROUP_TYPE, 'broker');
  assert.equal(store.data['scope/user_groups.tsv'][0].PORTAL, 'b2bexchange');
});

test('seedKnownUserGroups seeds all 5 roles x 2 portals exactly once, idempotent on repeat calls', async () => {
  const store = makeStore();
  const client = createPortalPartiesClient(store);
  const first = await client.seedKnownUserGroups();
  assert.equal(first.seeded, 10);
  const rows = await client.listUserGroups();
  assert.equal(rows.length, 10);
  const second = await client.seedKnownUserGroups();
  assert.equal(second.seeded, 0);
  assert.equal((await client.listUserGroups()).length, 10);
});

test('listUserGroups filters by portal', async () => {
  const store = makeStore();
  const client = createPortalPartiesClient(store);
  await client.seedKnownUserGroups();
  const exchangeOnly = await client.listUserGroups({ portal: 'b2bexchange' });
  assert.equal(exchangeOnly.length, 5);
  assert.ok(exchangeOnly.every(r => r.PORTAL === 'b2bexchange'));
});

test('addDealFlowParty rejects an unknown portal, party role, or a missing listingId', async () => {
  const client = createPortalPartiesClient(makeStore());
  await assert.rejects(() => client.addDealFlowParty({ portal: 'nope', partyRole: 'buyer', listingId: 'L1' }), /portal must be one of/);
  await assert.rejects(() => client.addDealFlowParty({ portal: 'b2bexchange', partyRole: 'nope', listingId: 'L1' }), /partyRole must be one of/);
  await assert.rejects(() => client.addDealFlowParty({ portal: 'b2bexchange', partyRole: 'buyer' }), /listingId/);
});

test('addDealFlowParty sets exactly one of PERSON_ID/PORTAL_IDENTITY, never both', async () => {
  const store = makeStore();
  const client = createPortalPartiesClient(store);
  const known = await client.addDealFlowParty({ portal: 'b2bexchange', listingId: 'L1', partyRole: 'buyer', personId: 'p001' });
  assert.equal(known.dealFlowParty.PERSON_ID, 'p001');
  assert.equal(known.dealFlowParty.PORTAL_IDENTITY, '-');

  const unknown = await client.addDealFlowParty({ portal: 'b2bexchange', listingId: 'L1', partyRole: 'seller', portalIdentity: 'portal-only contact' });
  assert.equal(unknown.dealFlowParty.PERSON_ID, '-');
  assert.equal(unknown.dealFlowParty.PORTAL_IDENTITY, 'portal-only contact');
});

test('listDealFlowParties filters by portal and listingId, independent of user_groups records', async () => {
  const store = makeStore();
  const client = createPortalPartiesClient(store);
  await client.seedKnownUserGroups();
  await client.addDealFlowParty({ portal: 'b2bexchange', listingId: 'L1', partyRole: 'buyer', portalIdentity: 'x' });
  await client.addDealFlowParty({ portal: 'b2bexchange', listingId: 'L2', partyRole: 'seller', portalIdentity: 'y' });
  await client.addDealFlowParty({ portal: 'b2bplatform', listingId: 'L1', partyRole: 'broker', portalIdentity: 'z' });

  assert.equal((await client.listDealFlowParties()).length, 3);
  assert.equal((await client.listDealFlowParties({ portal: 'b2bexchange' })).length, 2);
  assert.equal((await client.listDealFlowParties({ portal: 'b2bexchange', listingId: 'L1' })).length, 1);
  // seeding user_groups must not create any deal_flow_parties rows
  assert.equal((store.data['scope/deal_flow_parties.tsv'] || []).length, 3);
});

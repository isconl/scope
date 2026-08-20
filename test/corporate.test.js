'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCorporateClient } = require('../lib/corporate');

function makeReadTSV(seed) {
  return async (rel) => (seed[rel] || []).slice();
}

const TASKS = [
  { ID: 'T1', TITLE: 'Send tenant-one proposal', STATUS: 'today', DUE_DATE: '-', ORG_ID: 'tenant-one' },
  { ID: 'T2', TITLE: 'Unrelated task', STATUS: 'today', DUE_DATE: '2026-09-01', ORG_ID: '-' },
  { ID: 'T3', TITLE: 'Follow up', STATUS: 'done', DUE_DATE: '-', ORG_ID: 'tenant-one' },
];

test('createCorporateClient throws without readTSV', () => {
  assert.throws(() => createCorporateClient({}));
});

test('getEngagement returns tasks tagged by ORG_ID for a non-active org (BC26082006)', async () => {
  const client = createCorporateClient({
    readTSV: makeReadTSV({ 'scope/tasks.tsv': TASKS }),
    getCareerContext: async () => ({
      activeOrg: 'acme',
      orgs: [{ id: 'tenant-one', name: 'Tenant One', role: '', status: 'prospect' }],
    }),
  });
  const eng = await client.getEngagement('tenant-one');
  assert.equal(eng.active, false);
  assert.equal(eng.tasks.length, 2);
  assert.deepEqual(eng.tasks.map(t => t.id), ['T1', 'T3']);
});

test('getEngagement returns tasks tagged by ORG_ID alongside full detail for the active org', async () => {
  const client = createCorporateClient({
    readTSV: makeReadTSV({ 'scope/tasks.tsv': TASKS }),
    getCareerContext: async () => ({
      activeOrg: 'tenant-one',
      orgs: [{ id: 'tenant-one', name: 'Tenant One', role: '', status: 'prospect' }],
      decisions: [], risks: [], people: [], playbooks: [], doctrine: {},
    }),
  });
  const eng = await client.getEngagement('tenant-one');
  assert.equal(eng.active, true);
  assert.equal(eng.tasks.length, 2);
});

test('getEngagement resolves onedriveFolder from career context, falling back to the bare id when unset (BA26081803)', async () => {
  const client = createCorporateClient({
    readTSV: makeReadTSV({ 'scope/tasks.tsv': [] }),
    getCareerContext: async () => ({
      activeOrg: null,
      orgs: [
        { id: 'tenant-one', name: 'Tenant One', onedriveFolder: '2026-tenant-one' },
        { id: 'hand-added-org', name: 'Hand Added Org' }, // no onedriveFolder -- e.g. entered by hand, never discovered
      ],
    }),
  });
  const withFolder = await client.getEngagement('tenant-one');
  assert.equal(withFolder.onedriveFolder, '2026-tenant-one');
  const withoutFolder = await client.getEngagement('hand-added-org');
  assert.equal(withoutFolder.onedriveFolder, 'hand-added-org');
});

test('getEngagement returns an empty tasks list for an org nothing is tagged to', async () => {
  const client = createCorporateClient({
    readTSV: makeReadTSV({ 'scope/tasks.tsv': TASKS }),
    getCareerContext: async () => ({ activeOrg: null, orgs: [{ id: 'no-tasks-org', name: 'No Tasks Org' }] }),
  });
  const eng = await client.getEngagement('no-tasks-org');
  assert.deepEqual(eng.tasks, []);
});

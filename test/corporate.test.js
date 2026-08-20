'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCorporateClient } = require('../lib/corporate');

function makeReadTSV(seed) {
  return async (rel) => (seed[rel] || []).slice();
}

const TASKS = [
  { ID: 'T1', TITLE: 'Send viva-valentia proposal', STATUS: 'today', DUE_DATE: '-', ORG_ID: 'viva-valentia' },
  { ID: 'T2', TITLE: 'Unrelated task', STATUS: 'today', DUE_DATE: '2026-09-01', ORG_ID: '-' },
  { ID: 'T3', TITLE: 'Follow up', STATUS: 'done', DUE_DATE: '-', ORG_ID: 'viva-valentia' },
];

test('createCorporateClient throws without readTSV', () => {
  assert.throws(() => createCorporateClient({}));
});

test('getEngagement returns tasks tagged by ORG_ID for a non-active org (BC26082006)', async () => {
  const client = createCorporateClient({
    readTSV: makeReadTSV({ 'scope/tasks.tsv': TASKS }),
    getCareerContext: async () => ({
      activeOrg: 'acme',
      orgs: [{ id: 'viva-valentia', name: 'Viva Valentia', role: '', status: 'prospect' }],
    }),
  });
  const eng = await client.getEngagement('viva-valentia');
  assert.equal(eng.active, false);
  assert.equal(eng.tasks.length, 2);
  assert.deepEqual(eng.tasks.map(t => t.id), ['T1', 'T3']);
});

test('getEngagement returns tasks tagged by ORG_ID alongside full detail for the active org', async () => {
  const client = createCorporateClient({
    readTSV: makeReadTSV({ 'scope/tasks.tsv': TASKS }),
    getCareerContext: async () => ({
      activeOrg: 'viva-valentia',
      orgs: [{ id: 'viva-valentia', name: 'Viva Valentia', role: '', status: 'prospect' }],
      decisions: [], risks: [], people: [], playbooks: [], doctrine: {},
    }),
  });
  const eng = await client.getEngagement('viva-valentia');
  assert.equal(eng.active, true);
  assert.equal(eng.tasks.length, 2);
});

test('getEngagement returns an empty tasks list for an org nothing is tagged to', async () => {
  const client = createCorporateClient({
    readTSV: makeReadTSV({ 'scope/tasks.tsv': TASKS }),
    getCareerContext: async () => ({ activeOrg: null, orgs: [{ id: 'no-tasks-org', name: 'No Tasks Org' }] }),
  });
  const eng = await client.getEngagement('no-tasks-org');
  assert.deepEqual(eng.tasks, []);
});

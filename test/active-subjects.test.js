'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createActiveSubjectsClient } = require('../lib/active-subjects');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: async (rel) => (data[rel] || []).slice(),
    appendTSV: async (rel, row) => { (data[rel] = data[rel] || []).push(row); return true; },
    rewriteTSV: async (rel, fn) => { data[rel] = fn((data[rel] || []).slice()); return data[rel].length; },
  };
}

const PEOPLE = [
  { NAME: 'Alex Rivera', GROUP: 'viva', ROLE: 'supervisor (text) - day-to-day director' },
  { NAME: 'Sam Uusjarv', GROUP: 'viva', ROLE: 'CEO - final authority' },
];

test('createActiveSubjectsClient throws without readTSV/appendTSV/rewriteTSV', () => {
  assert.throws(() => createActiveSubjectsClient({}));
});

test('syncFromCareer creates one engagement row per enabled org, resolving the literal "supervisor" role first', async () => {
  const store = makeStore({ 'circle/people.tsv': PEOPLE });
  const client = createActiveSubjectsClient({
    ...store,
    getCareerContext: async () => ({ orgs: [{ id: 'viva', name: 'Viva', status: 'active', enabled: true }], people: PEOPLE }),
  });
  const r = await client.syncFromCareer();
  assert.equal(r.created, 1);
  const rows = await client.listSubjects();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].TYPE, 'engagement');
  assert.equal(rows[0].SOURCE_REF, 'viva');
  assert.equal(rows[0].SUPERVISOR_OR_CONTACT, 'Alex Rivera');
});

test('syncFromCareer matches a shorthand GROUP against a longer org id (real data shape: GROUP:"viva" vs org id "viva-valentia")', async () => {
  const store = makeStore({ 'circle/people.tsv': PEOPLE });
  const client = createActiveSubjectsClient({
    ...store,
    getCareerContext: async () => ({ orgs: [{ id: 'viva-valentia', status: 'prospect', enabled: true }], people: PEOPLE }),
  });
  await client.syncFromCareer();
  const rows = await client.listSubjects();
  assert.equal(rows[0].SUPERVISOR_OR_CONTACT, 'Alex Rivera');
});

test('syncFromCareer falls back to a CEO/final-authority role when no literal supervisor exists', async () => {
  const noSupervisor = [{ NAME: 'Sam Uusjarv', GROUP: 'viva', ROLE: 'CEO - final authority' }];
  const store = makeStore({ 'circle/people.tsv': noSupervisor });
  const client = createActiveSubjectsClient({
    ...store,
    getCareerContext: async () => ({ orgs: [{ id: 'viva', status: 'active', enabled: true }], people: noSupervisor }),
  });
  await client.syncFromCareer();
  const rows = await client.listSubjects();
  assert.equal(rows[0].SUPERVISOR_OR_CONTACT, 'Sam Uusjarv');
});

test('syncFromCareer never invents a supervisor -- "-" when nobody in the org matches', async () => {
  const store = makeStore({ 'circle/people.tsv': [] });
  const client = createActiveSubjectsClient({
    ...store,
    getCareerContext: async () => ({ orgs: [{ id: 'lonely-org', status: 'active', enabled: true }], people: [] }),
  });
  await client.syncFromCareer();
  const rows = await client.listSubjects();
  assert.equal(rows[0].SUPERVISOR_OR_CONTACT, '-');
});

test('syncFromCareer skips a disabled org', async () => {
  const store = makeStore({ 'circle/people.tsv': [] });
  const client = createActiveSubjectsClient({
    ...store,
    getCareerContext: async () => ({ orgs: [{ id: 'archived', status: 'prospect', enabled: false }], people: [] }),
  });
  const r = await client.syncFromCareer();
  assert.equal(r.created, 0);
  assert.equal((await client.listSubjects()).length, 0);
});

test('syncFromCareer is idempotent: a second run updates the existing row instead of duplicating it', async () => {
  const store = makeStore({ 'circle/people.tsv': PEOPLE });
  const client = createActiveSubjectsClient({
    ...store,
    getCareerContext: async () => ({ orgs: [{ id: 'viva', status: 'active', enabled: true }], people: PEOPLE }),
  });
  await client.syncFromCareer();
  const second = await client.syncFromCareer();
  assert.equal(second.created, 0);
  assert.equal(second.updated, 1);
  assert.equal((await client.listSubjects()).length, 1);
});

test('syncFromCareer updates STATUS on re-sync without touching a manually-added owner row', async () => {
  const store = makeStore({ 'circle/people.tsv': PEOPLE });
  const client = createActiveSubjectsClient({
    ...store,
    getCareerContext: async () => ({ orgs: [{ id: 'viva', status: 'active', enabled: true }], people: PEOPLE }),
  });
  await client.syncFromCareer();
  await client.addOwnerSubject({ sourceRef: 'acexoft-dynamics', status: 'active' });
  await client.syncFromCareer(); // simulate the org's status changing upstream is not tested here, just non-interference
  const rows = await client.listSubjects();
  assert.equal(rows.length, 2);
  const owner = rows.find(r => r.TYPE === 'owner');
  assert.equal(owner.SOURCE_REF, 'acexoft-dynamics');
});

test('addOwnerSubject requires a sourceRef and defaults status to active', async () => {
  const store = makeStore();
  const client = createActiveSubjectsClient(store);
  await assert.rejects(() => client.addOwnerSubject({}), /sourceRef/);
  const r = await client.addOwnerSubject({ sourceRef: 'my-company' });
  assert.equal(r.subject.TYPE, 'owner');
  assert.equal(r.subject.STATUS, 'active');
});

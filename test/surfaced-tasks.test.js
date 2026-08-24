'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSurfacedTasksClient } = require('../lib/surfaced-tasks');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: async (rel) => (data[rel] || []).slice(),
    appendTSV: async (rel, row) => { (data[rel] = data[rel] || []).push(row); return true; },
    rewriteTSV: async (rel, fn) => {
      const before = (data[rel] || []).length;
      data[rel] = fn((data[rel] || []).slice());
      return before - data[rel].length;
    },
  };
}

test('addSurfaced requires a title', async () => {
  const client = createSurfacedTasksClient(makeStore());
  await assert.rejects(() => client.addSurfaced({ body: 'no title' }), /title/);
});

test('addSurfaced writes a new row with sequential ST-prefixed IDs, defaulting STATUS to new', async () => {
  const store = makeStore();
  const client = createSurfacedTasksClient(store);
  const r1 = await client.addSurfaced({ title: 'First', body: 'a note', view: 'task', ref: 'T128', origin: 'session:abc' });
  const r2 = await client.addSurfaced({ title: 'Second' });
  assert.equal(r1.id, 'ST0001');
  assert.equal(r2.id, 'ST0002');
  const rows = store.data['scope/surfaced_tasks.tsv'];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].STATUS, 'new');
  assert.equal(rows[0].VIEW, 'task');
  assert.equal(rows[0].REF, 'T128');
  assert.equal(rows[0].ORIGIN, 'session:abc');
  assert.equal(rows[1].BODY, '-');
});

test('listSurfaced filters by status when given, returns everything otherwise', async () => {
  const store = makeStore({ 'scope/surfaced_tasks.tsv': [
    { ID: 'ST0001', TITLE: 'A', STATUS: 'new' },
    { ID: 'ST0002', TITLE: 'B', STATUS: 'seen' },
    { ID: 'ST0003', TITLE: 'C', STATUS: 'dismissed' },
  ] });
  const client = createSurfacedTasksClient(store);
  assert.equal((await client.listSurfaced()).length, 3);
  assert.deepEqual((await client.listSurfaced({ status: 'seen' })).map(r => r.ID), ['ST0002']);
});

test('updateSurfaced sets STATUS, rejects an unknown status value or a missing id', async () => {
  const store = makeStore({ 'scope/surfaced_tasks.tsv': [{ ID: 'ST0001', TITLE: 'A', STATUS: 'new' }] });
  const client = createSurfacedTasksClient(store);
  await client.updateSurfaced({ id: 'ST0001', status: 'seen' });
  assert.equal(store.data['scope/surfaced_tasks.tsv'][0].STATUS, 'seen');
  await assert.rejects(() => client.updateSurfaced({ id: 'ST0001', status: 'bogus' }), /status/);
  await assert.rejects(() => client.updateSurfaced({ status: 'seen' }), /id required/);
  await assert.rejects(() => client.updateSurfaced({ id: 'nope', status: 'seen' }), /no surfaced item/);
});

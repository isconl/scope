'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeAdherence, blockFor, matchesBlock } = require('../lib/time-optimization');

function makeStore(seed = {}) {
  const data = { ...seed };
  return { readTSV: async (rel) => (data[rel] || []).slice() };
}

// A Monday in 2026-08 (2026-08-24 is a Monday).
const MON = '2026-08-24';
const BLOCKS = [
  { ID: 'BLK-LEARN-MON', DAY: 'Mon', NAME: 'Learning', START: '06:00', END: '07:00', AXIS: 'learning', MATCH: 'learn,course,study', ACTIVE: 'yes' },
  { ID: 'BLK-INN-MON', DAY: 'Mon', NAME: 'Innovation', START: '08:00', END: '10:00', AXIS: 'innovator', MATCH: 'build,engineer,api', ACTIVE: 'yes' },
  { ID: 'BLK-FLEX-MON', DAY: 'Mon', NAME: 'Flex', START: '10:00', END: '11:00', AXIS: 'flex', MATCH: '', ACTIVE: 'yes' },
];

test('blockFor matches a session start time to the right day+time block', () => {
  const b = blockFor(BLOCKS, `${MON}T08:30:00`);
  assert.equal(b.ID, 'BLK-INN-MON');
});

test('blockFor returns null for a time outside every block window', () => {
  assert.equal(blockFor(BLOCKS, `${MON}T23:00:00`), null);
});

test('matchesBlock returns null (not false) when a block has no keyword list -- adherence not meaningful', () => {
  assert.equal(matchesBlock(BLOCKS[2], 'anything'), null);
});

test('matchesBlock is case-insensitive and substring-based', () => {
  assert.equal(matchesBlock(BLOCKS[1], 'Build the new API client'), true);
  assert.equal(matchesBlock(BLOCKS[1], 'Write a birthday card'), false);
});

test('computeAdherence attributes session minutes to the matching block and computes adherence%', async () => {
  const tasks = [
    { TITLE: 'Build the API client', SESSIONS: JSON.stringify([{ start: `${MON}T08:00:00`, stop: `${MON}T09:00:00` }]) },
    { TITLE: 'Write a birthday card', SESSIONS: JSON.stringify([{ start: `${MON}T08:30:00`, stop: `${MON}T09:00:00` }]) },
  ];
  const store = makeStore({ 'scope/tasks.tsv': tasks, 'scope/blocks.tsv': BLOCKS });
  const r = await computeAdherence({ readTSV: store.readTSV, days: 365 });
  const inn = r.perBlock.find(b => b.blockId === 'BLK-INN-MON');
  assert.equal(inn.loggedMinutes, 90); // 60 + 30
  assert.equal(inn.adherencePct, Math.round((60 / 90) * 100)); // only the matching task's 60 min counts
});

test('computeAdherence ignores sessions still open (no stop) and sessions outside the lookback window', async () => {
  const tasks = [
    { TITLE: 'Build something', SESSIONS: JSON.stringify([{ start: `${MON}T08:00:00`, stop: null }]) },
    { TITLE: 'Build old thing', SESSIONS: JSON.stringify([{ start: '2020-01-01T08:00:00', stop: '2020-01-01T09:00:00' }]) },
  ];
  const store = makeStore({ 'scope/tasks.tsv': tasks, 'scope/blocks.tsv': BLOCKS });
  const r = await computeAdherence({ readTSV: store.readTSV, days: 7 });
  const inn = r.perBlock.find(b => b.blockId === 'BLK-INN-MON');
  assert.equal(inn.loggedMinutes, 0);
  assert.equal(inn.sessionCount, 0);
});

test('computeAdherence recommends flagging a block with zero sessions (excluding protected/flex/lunch axes)', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [], 'scope/blocks.tsv': BLOCKS });
  const r = await computeAdherence({ readTSV: store.readTSV, days: 7 });
  assert.ok(r.recommendations.some(rec => rec.includes('Innovation')));
  assert.ok(!r.recommendations.some(rec => rec.includes('Flex'))); // flex axis excluded from the "unused" flag
});

test('computeAdherence recommends a low-adherence block when most logged time does not match its purpose', async () => {
  const tasks = [
    { TITLE: 'Build something', SESSIONS: JSON.stringify([{ start: `${MON}T08:00:00`, stop: `${MON}T08:10:00` }]) },
    { TITLE: 'Unrelated errand', SESSIONS: JSON.stringify([{ start: `${MON}T08:20:00`, stop: `${MON}T09:00:00` }]) },
  ];
  const store = makeStore({ 'scope/tasks.tsv': tasks, 'scope/blocks.tsv': BLOCKS });
  const r = await computeAdherence({ readTSV: store.readTSV, days: 365 });
  assert.ok(r.recommendations.some(rec => rec.includes('Innovation') && rec.includes('%')));
});

test('computeAdherence returns perBlock entries for every block, even ones never touched', async () => {
  const store = makeStore({ 'scope/tasks.tsv': [], 'scope/blocks.tsv': BLOCKS });
  const r = await computeAdherence({ readTSV: store.readTSV });
  assert.equal(r.perBlock.length, BLOCKS.length);
});

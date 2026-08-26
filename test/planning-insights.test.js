'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlanningInsightsClient } = require('../lib/planning-insights');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: async (rel) => (data[rel] || []).slice(),
    appendTSV: async (rel, row) => { (data[rel] = data[rel] || []).push(row); return true; },
  };
}

const today = new Date();
function daysAgoStr(n) {
  const d = new Date(today.getTime() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

test('runCuration promotes a recent, actionable campus row', async () => {
  const store = makeStore({
    'learning/campus.tsv': [
      { ID: 'cmp-1', WHY: 'This is a genuinely long and actionable why field for a lesson.', UPDATED_AT: daysAgoStr(2) },
    ],
    'scope/theme_days.tsv': [],
    'scope/plans.tsv': [],
    'scope/planning_insights.tsv': [],
  });
  const client = createPlanningInsightsClient(store);
  const result = await client.runCuration();
  assert.equal(result.promoted, 1);
  assert.equal(store.data['scope/planning_insights.tsv'].length, 1);
  const row = store.data['scope/planning_insights.tsv'][0];
  assert.equal(row.SOURCE, 'campus');
  assert.equal(row.SOURCE_ID, 'cmp-1');
  assert.equal(row.STATUS, 'active');
  assert.ok(Number(row.CONFIDENCE) > 0);
});

test('runCuration rejects a campus row older than the recency window', async () => {
  const store = makeStore({
    'learning/campus.tsv': [
      { ID: 'cmp-old', WHY: 'This is old actionable text that should not qualify by recency.', UPDATED_AT: daysAgoStr(30) },
    ],
    'scope/theme_days.tsv': [], 'scope/plans.tsv': [], 'scope/planning_insights.tsv': [],
  });
  const result = await createPlanningInsightsClient(store).runCuration();
  assert.equal(result.promoted, 0);
});

test('runCuration rejects a trivial/blank WHY field', async () => {
  const store = makeStore({
    'learning/campus.tsv': [{ ID: 'cmp-blank', WHY: '-', UPDATED_AT: daysAgoStr(1) }],
    'scope/theme_days.tsv': [], 'scope/plans.tsv': [], 'scope/planning_insights.tsv': [],
  });
  const result = await createPlanningInsightsClient(store).runCuration();
  assert.equal(result.promoted, 0);
});

test('runCuration promotes an active plans row within its 30-day window, ignores non-active status', async () => {
  const store = makeStore({
    'learning/campus.tsv': [], 'scope/theme_days.tsv': [],
    'scope/plans.tsv': [
      { ID: 'P001', STATUS: 'active', CREATED_AT: daysAgoStr(10), NOTE: 'A properly long and actionable plan note goes here.' },
      { ID: 'P002', STATUS: 'draft', CREATED_AT: daysAgoStr(1), NOTE: 'A properly long and actionable plan note goes here too.' },
      { ID: 'P003', STATUS: 'active', CREATED_AT: daysAgoStr(45), NOTE: 'A properly long and actionable plan note goes here as well.' },
    ],
    'scope/planning_insights.tsv': [],
  });
  const result = await createPlanningInsightsClient(store).runCuration();
  assert.equal(result.promoted, 1);
  assert.equal(store.data['scope/planning_insights.tsv'][0].SOURCE_ID, 'P001');
});

test('runCuration skips a near-duplicate of an already-curated insight', async () => {
  const insight = 'This is a genuinely long and actionable why field for a lesson.';
  const store = makeStore({
    'learning/campus.tsv': [{ ID: 'cmp-dup', WHY: insight, UPDATED_AT: daysAgoStr(1) }],
    'scope/theme_days.tsv': [], 'scope/plans.tsv': [],
    'scope/planning_insights.tsv': [{ ID: 'PI0001', SOURCE: 'campus', SOURCE_ID: 'cmp-old', INSIGHT: insight, CONFIDENCE: '70', LAST_VALIDATED: daysAgoStr(1), STATUS: 'active', PROMOTED_AT: daysAgoStr(1) }],
  });
  const result = await createPlanningInsightsClient(store).runCuration();
  assert.equal(result.promoted, 0);
});

test('runCuration skips two near-duplicate candidates within the same run, keeping only the first', async () => {
  const store = makeStore({
    'learning/campus.tsv': [
      { ID: 'cmp-a', WHY: 'Nearly identical actionable why text about the same underlying topic.', UPDATED_AT: daysAgoStr(1) },
      { ID: 'cmp-b', WHY: 'Nearly identical actionable why text about the same underlying topic!', UPDATED_AT: daysAgoStr(1) },
    ],
    'scope/theme_days.tsv': [], 'scope/plans.tsv': [], 'scope/planning_insights.tsv': [],
  });
  const result = await createPlanningInsightsClient(store).runCuration();
  assert.equal(result.promoted, 1);
});

test('runCuration promotes theme_days using PHRASE as its text field', async () => {
  const store = makeStore({
    'learning/campus.tsv': [], 'scope/plans.tsv': [],
    'scope/theme_days.tsv': [{ DATE: daysAgoStr(1), PHRASE: 'A genuinely long and specific theme-day phrase worth curating.', ADDED_AT: daysAgoStr(1) }],
    'scope/planning_insights.tsv': [],
  });
  const result = await createPlanningInsightsClient(store).runCuration();
  assert.equal(result.promoted, 1);
  assert.equal(store.data['scope/planning_insights.tsv'][0].SOURCE, 'theme_days');
});

test('listInsights returns whatever is currently in the collection', async () => {
  const seedRow = { ID: 'PI0001', SOURCE: 'plans', SOURCE_ID: 'P001', INSIGHT: 'x', CONFIDENCE: '50', LAST_VALIDATED: daysAgoStr(0), STATUS: 'active', PROMOTED_AT: daysAgoStr(0) };
  const store = makeStore({ 'scope/planning_insights.tsv': [seedRow] });
  const { insights } = await createPlanningInsightsClient(store).listInsights();
  assert.deepEqual(insights, [seedRow]);
});

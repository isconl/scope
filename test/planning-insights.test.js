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
    // WI26091504: the re-score path needs rewriteTSV. Same contract as the
    // real store's -- fn receives the current rows and returns the rows to
    // keep -- so a test passing here means the same thing in production.
    rewriteTSV: async (rel, fn) => { data[rel] = fn((data[rel] || []).slice()); return data[rel].length; },
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

// --- WI26091504: the daily re-score half -------------------------------------

function seededInsight(over = {}) {
  return {
    ID: 'PI0001', SOURCE: 'plans', SOURCE_ID: 'P001',
    INSIGHT: 'An older wording of this insight that should be refreshed.',
    CONFIDENCE: '55', LAST_VALIDATED: daysAgoStr(9), STATUS: 'active',
    PROMOTED_AT: daysAgoStr(9), ...over,
  };
}

test('runRescore refreshes confidence, text and LAST_VALIDATED from the live source row', async () => {
  const store = makeStore({
    'learning/campus.tsv': [], 'scope/theme_days.tsv': [],
    'scope/plans.tsv': [
      { ID: 'P001', STATUS: 'active', NOTE: 'The source note has since been rewritten and is now considerably longer than it was.', CREATED_AT: daysAgoStr(1) },
    ],
    'scope/planning_insights.tsv': [seededInsight()],
  });
  const client = createPlanningInsightsClient(store);
  const counts = await client.runRescore();
  const row = store.data['scope/planning_insights.tsv'][0];
  assert.equal(counts.examined, 1);
  assert.equal(counts.rescored, 1);
  assert.equal(row.STATUS, 'active');
  assert.equal(row.LAST_VALIDATED, daysAgoStr(0));
  assert.match(row.INSIGHT, /since been rewritten/);
  assert.notEqual(row.CONFIDENCE, '55');
});

test('runRescore retires an insight whose source row has been deleted, rather than dropping it', async () => {
  const store = makeStore({
    'learning/campus.tsv': [], 'scope/theme_days.tsv': [], 'scope/plans.tsv': [],
    'scope/planning_insights.tsv': [seededInsight()],
  });
  const client = createPlanningInsightsClient(store);
  const counts = await client.runRescore();
  assert.equal(counts.retired, 1);
  assert.equal(store.data['scope/planning_insights.tsv'].length, 1, 'the row is kept, not deleted');
  assert.equal(store.data['scope/planning_insights.tsv'][0].STATUS, 'retired');
});

test('runRescore marks an insight stale once its source ages past its recency window', async () => {
  const store = makeStore({
    'learning/campus.tsv': [], 'scope/theme_days.tsv': [],
    'scope/plans.tsv': [
      { ID: 'P001', STATUS: 'active', NOTE: 'A long enough note that still qualifies on text length alone.', CREATED_AT: daysAgoStr(400) },
    ],
    'scope/planning_insights.tsv': [seededInsight()],
  });
  const client = createPlanningInsightsClient(store);
  const counts = await client.runRescore();
  assert.equal(counts.staled, 1);
  assert.equal(store.data['scope/planning_insights.tsv'][0].STATUS, 'stale');
});

test('a stale insight revives when its source moves back inside the window; a retired one does not', async () => {
  const store = makeStore({
    'learning/campus.tsv': [], 'scope/theme_days.tsv': [],
    'scope/plans.tsv': [
      { ID: 'P001', STATUS: 'active', NOTE: 'A long enough note that still qualifies on text length alone.', CREATED_AT: daysAgoStr(1) },
      { ID: 'P002', STATUS: 'active', NOTE: 'Another long enough note that also qualifies on text length.', CREATED_AT: daysAgoStr(1) },
    ],
    'scope/planning_insights.tsv': [
      seededInsight({ ID: 'PI0001', SOURCE_ID: 'P001', STATUS: 'stale' }),
      seededInsight({ ID: 'PI0002', SOURCE_ID: 'P002', STATUS: 'retired' }),
    ],
  });
  const client = createPlanningInsightsClient(store);
  const counts = await client.runRescore();
  const rows = store.data['scope/planning_insights.tsv'];
  assert.equal(counts.revived, 1);
  assert.equal(rows.find(r => r.ID === 'PI0001').STATUS, 'active');
  assert.equal(rows.find(r => r.ID === 'PI0002').STATUS, 'retired', 'retired is terminal -- there is nothing left to re-validate against');
});

test('runRescore leaves a row with an unrecognised SOURCE completely untouched', async () => {
  const foreign = { ID: 'PI9999', SOURCE: 'something-else', SOURCE_ID: 'X1', INSIGHT: 'Written by something this pass does not own.', CONFIDENCE: '42', LAST_VALIDATED: daysAgoStr(30), STATUS: 'active', PROMOTED_AT: daysAgoStr(30) };
  const store = makeStore({
    'learning/campus.tsv': [], 'scope/theme_days.tsv': [], 'scope/plans.tsv': [],
    'scope/planning_insights.tsv': [{ ...foreign }],
  });
  const client = createPlanningInsightsClient(store);
  const counts = await client.runRescore();
  assert.equal(counts.examined, 0);
  assert.deepEqual(store.data['scope/planning_insights.tsv'][0], foreign);
});

test('runDaily re-scores before promoting, so a newly promoted row is not also marked re-validated', async () => {
  const store = makeStore({
    'learning/campus.tsv': [], 'scope/theme_days.tsv': [],
    'scope/plans.tsv': [
      { ID: 'P001', STATUS: 'active', NOTE: 'An existing source note, long enough to clear the actionability bar.', CREATED_AT: daysAgoStr(2) },
      { ID: 'P002', STATUS: 'active', NOTE: 'A brand new plan note that has never been promoted into the database.', CREATED_AT: daysAgoStr(0) },
    ],
    'scope/planning_insights.tsv': [seededInsight({ SOURCE_ID: 'P001' })],
  });
  const client = createPlanningInsightsClient(store);
  const result = await client.runDaily();
  assert.equal(result.ok, true);
  assert.equal(result.rescored.examined, 1, 'only the pre-existing row was re-scored');
  assert.equal(result.promoted, 1, 'the new plan was promoted');
  assert.ok(result.startedAt && result.finishedAt);
  assert.equal(store.data['scope/planning_insights.tsv'].length, 2);
});

test('listInsights reports lastValidatedAt, which is how an unattended run proves it happened', async () => {
  const store = makeStore({
    'learning/campus.tsv': [], 'scope/theme_days.tsv': [],
    'scope/plans.tsv': [
      { ID: 'P001', STATUS: 'active', NOTE: 'A long enough note that still qualifies on text length alone.', CREATED_AT: daysAgoStr(1) },
    ],
    'scope/planning_insights.tsv': [seededInsight()],
  });
  const client = createPlanningInsightsClient(store);
  assert.equal((await client.listInsights()).lastValidatedAt, daysAgoStr(9));
  await client.runDaily();
  assert.equal((await client.listInsights()).lastValidatedAt, daysAgoStr(0));
});

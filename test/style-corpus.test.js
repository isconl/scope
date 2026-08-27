'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStyleCorpusClient, styleStats } = require('../lib/style-corpus');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: async (rel) => (data[rel] || []).slice(),
    appendTSV: async (rel, row) => { (data[rel] = data[rel] || []).push(row); return true; },
  };
}

test('createStyleCorpusClient throws without readTSV/appendTSV', () => {
  assert.throws(() => createStyleCorpusClient({}));
});

test('ingestNew pulls only outbound rows with a real body, skipping inbound and blank ones', async () => {
  const store = makeStore({
    'scope/inbox.tsv': [
      { ID: 'M1', DIRECTION: 'out', BODY: 'Sounds good, let us do that.', CHANNEL: 'whatsapp', PERSON_ID: 'alex' },
      { ID: 'M2', DIRECTION: 'in', BODY: 'Their reply, not his own voice.', CHANNEL: 'whatsapp', PERSON_ID: 'alex' },
      { ID: 'M3', DIRECTION: 'out', BODY: '-', CHANNEL: 'whatsapp', PERSON_ID: 'alex' },
    ],
  });
  const client = createStyleCorpusClient(store);
  const r = await client.ingestNew();
  assert.equal(r.ingested, 1);
  assert.equal(store.data['scope/style_corpus.tsv'].length, 1);
  assert.equal(store.data['scope/style_corpus.tsv'][0].SOURCE_ID, 'M1');
});

test('ingestNew is idempotent -- a second run does not re-ingest the same rows', async () => {
  const store = makeStore({
    'scope/inbox.tsv': [{ ID: 'M1', DIRECTION: 'out', BODY: 'Real message.', CHANNEL: 'whatsapp' }],
  });
  const client = createStyleCorpusClient(store);
  await client.ingestNew();
  const second = await client.ingestNew();
  assert.equal(second.ingested, 0);
  assert.equal(store.data['scope/style_corpus.tsv'].length, 1);
});

test('ingestNew picks up genuinely new outbound rows on a later run without duplicating', async () => {
  const store = makeStore({
    'scope/inbox.tsv': [{ ID: 'M1', DIRECTION: 'out', BODY: 'First message.', CHANNEL: 'whatsapp' }],
  });
  const client = createStyleCorpusClient(store);
  await client.ingestNew();
  store.data['scope/inbox.tsv'].push({ ID: 'M2', DIRECTION: 'out', BODY: 'Second message, later.', CHANNEL: 'email' });
  const r = await client.ingestNew();
  assert.equal(r.ingested, 1);
  assert.equal(store.data['scope/style_corpus.tsv'].length, 2);
});

test('styleStats computes real, interpretable numbers from a small text sample', () => {
  const stats = styleStats(['Sounds good. Let us do that!', 'Are you free tomorrow?']);
  assert.equal(stats.messageCount, 2);
  assert.equal(stats.sentenceCount, 3);
  assert.ok(stats.avgSentenceWords > 0);
  assert.ok(stats.commonWords.length > 0);
  assert.equal(stats.questionsPer100Words > 0, true);
});

test('getStyleProfile returns only a general profile when no personId is given', async () => {
  const store = makeStore({
    'scope/style_corpus.tsv': [{ TEXT: 'Sounds good.', PERSON_ID: 'alex' }],
  });
  const client = createStyleCorpusClient(store);
  const r = await client.getStyleProfile();
  assert.ok(r.general);
  assert.equal(r.perContact, undefined);
});

test('getStyleProfile overlays a per-contact profile when that contact has outbound history', async () => {
  const store = makeStore({
    'scope/style_corpus.tsv': [
      { TEXT: 'General voice message one.', PERSON_ID: 'alex' },
      { TEXT: 'Different voice to someone else.', PERSON_ID: 'sam' },
    ],
  });
  const client = createStyleCorpusClient(store);
  const r = await client.getStyleProfile('alex');
  assert.ok(r.general);
  assert.ok(r.perContact);
  assert.equal(r.perContact.messageCount, 1);
});

test('getStyleProfile returns general-only with a clear note for a contact with no outbound history yet', async () => {
  const store = makeStore({ 'scope/style_corpus.tsv': [{ TEXT: 'Something.', PERSON_ID: 'alex' }] });
  const client = createStyleCorpusClient(store);
  const r = await client.getStyleProfile('nobody-yet');
  assert.equal(r.perContact, null);
  assert.match(r.note, /no outbound history/);
});

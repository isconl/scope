'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWriterBinderClient, groupLatestPerEpisode, extractCuratedSection, extractYamlField } = require('../lib/writer-binder');

test('createWriterBinderClient throws without callVault', () => {
  assert.throws(() => createWriterBinderClient({}));
});

test('groupLatestPerEpisode ignores non-matching filenames and keeps only the highest version per episode', () => {
  const items = [
    { id: 'a', name: '20260126_canon_episode_1_1_3_complete_output_v1.0.0.md', lastModifiedDateTime: '2026-01-26' },
    { id: 'b', name: '20260126_canon_episode_1_1_3_complete_output_v3.0.0.md', lastModifiedDateTime: '2026-03-01' },
    { id: 'c', name: '20260331_canon_episode_1_4_3_complete_output_v1.3.0.md', lastModifiedDateTime: '2026-03-31' },
    { id: 'd', name: 'README.md', lastModifiedDateTime: '2026-01-01' },
  ];
  const episodes = groupLatestPerEpisode(items);
  assert.equal(episodes.length, 2);
  const e113 = episodes.find(e => e.episodeId === '1.1.3');
  assert.equal(e113.itemId, 'b');
  assert.equal(e113.version, '3.0.0');
  const e143 = episodes.find(e => e.episodeId === '1.4.3');
  assert.equal(e143.itemId, 'c');
});

test('groupLatestPerEpisode sorts episodes numerically by ID', () => {
  const items = [
    { id: 'a', name: '20260101_canon_episode_1_10_1_x_v1.0.0.md' },
    { id: 'b', name: '20260101_canon_episode_1_2_1_x_v1.0.0.md' },
  ];
  const episodes = groupLatestPerEpisode(items);
  assert.deepEqual(episodes.map(e => e.episodeId), ['1.2.1', '1.10.1']);
});

test('extractCuratedSection pulls Section 10.3 content up to the next heading', () => {
  const md = [
    '## 10. OUTPUT',
    '### 10.2 CANONICAL',
    'Canonical text here.',
    '### 10.3 CURATED',
    '**A Bold Title**',
    '',
    'Curated body text with a > blockquote.',
    '### 10.4 SOCIAL',
    'Social posts here.',
  ].join('\n');
  const curated = extractCuratedSection(md);
  assert.match(curated, /A Bold Title/);
  assert.match(curated, /blockquote/);
  assert.doesNotMatch(curated, /Social posts/);
  assert.doesNotMatch(curated, /Canonical text/);
});

test('extractCuratedSection returns null when no Section 10.3 exists', () => {
  assert.equal(extractCuratedSection('# Just a title\n\nSome text.'), null);
});

test('extractYamlField reads a field from an embedded yaml-shaped block', () => {
  const md = '```yaml\nepisode_number: "1.1.3"\nfinal_title: "Consistency Kills Leverage"\nstatus: Complete\n```';
  assert.equal(extractYamlField(md, 'final_title'), 'Consistency Kills Leverage');
  assert.equal(extractYamlField(md, 'status'), 'Complete');
  assert.equal(extractYamlField(md, 'nonexistent'), null);
});

test('listEpisodes surfaces a callVault failure as ok:false rather than throwing', async () => {
  const client = createWriterBinderClient({ callVault: async () => ({ ok: false, error: 'vault down' }) });
  const r = await client.listEpisodes();
  assert.equal(r.ok, false);
  assert.equal(r.error, 'vault down');
});

test('listEpisodes returns the grouped episode list on success', async () => {
  const client = createWriterBinderClient({
    callVault: async (method, path) => {
      assert.equal(method, 'GET');
      assert.equal(path, '/onedrive/browse');
      return { ok: true, data: { items: [{ id: 'x', name: '20260101_canon_episode_1_1_1_x_v1.0.0.md' }] } };
    },
  });
  const r = await client.listEpisodes();
  assert.ok(r.ok);
  assert.equal(r.episodes.length, 1);
});

test('compileEpisode requires an itemId', async () => {
  const client = createWriterBinderClient({ callVault: async () => ({ ok: true, data: {} }) });
  const r = await client.compileEpisode();
  assert.equal(r.ok, false);
});

test('compileEpisode surfaces a missing Section 10.3 as a clear error, not a crash', async () => {
  const client = createWriterBinderClient({
    callVault: async () => ({ ok: true, data: { textContent: '# No output section here' } }),
  });
  const r = await client.compileEpisode('item1');
  assert.equal(r.ok, false);
  assert.match(r.error, /10\.3/);
});

test('compileEpisode returns title/status/linkedinPost on a real-shaped canvas', async () => {
  const canvas = [
    '```yaml',
    'final_title: "Consistency Kills Leverage"',
    'status: Complete — Ready for Export',
    '```',
    '## 10. OUTPUT',
    '### 10.3 CURATED',
    '**Consistency Kills Leverage**',
    '',
    'The real body text.',
    '### 10.4 SOCIAL',
    'ignore this',
  ].join('\n');
  const client = createWriterBinderClient({ callVault: async () => ({ ok: true, data: { textContent: canvas } }) });
  const r = await client.compileEpisode('item1');
  assert.ok(r.ok);
  assert.equal(r.title, 'Consistency Kills Leverage');
  assert.match(r.linkedinPost, /real body text/);
  assert.doesNotMatch(r.linkedinPost, /ignore this/);
});

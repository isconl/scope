'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDocsRegistryClient } = require('../lib/generate/docs-registry');

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

function fakeWritten(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  const written = { dir, files: {} };
  for (const [ext, name] of Object.entries(files)) {
    const fp = path.join(dir, name);
    fs.writeFileSync(fp, `fake ${ext} content`);
    written.files[ext] = fp;
  }
  return written;
}

test('recordGenerated indexes the docx (preferred over md/pdf) as the primary file', async () => {
  const store = makeStore();
  const client = createDocsRegistryClient(store);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-test-'));
  const written = fakeWritten(dir, { md: 'doc.md', docx: 'doc.docx', 'content.json': 'doc.content.json' });
  const id = await client.recordGenerated({ archetypeId: 'decision-brief', targetKind: 'project', targetId: 'p1', targetLabel: 'Project One', written, version: '0.1.0' });
  assert.ok(id);
  const rows = store.data['scope/generated_docs.tsv'];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].FILENAME, 'doc.docx');
  assert.equal(rows[0].STATUS, 'active');
  assert.equal(rows[0].TARGET_ID, 'p1');
});

test('listDocs excludes deleted rows by default, and filters by archetype/targetKind/status', async () => {
  const store = makeStore({ 'scope/generated_docs.tsv': [
    { ID: 'GD0001', ARCHETYPE_ID: 'a', TARGET_KIND: 'project', STATUS: 'active', CREATED_AT: '2026-08-19' },
    { ID: 'GD0002', ARCHETYPE_ID: 'b', TARGET_KIND: 'general', STATUS: 'deleted', CREATED_AT: '2026-08-20' },
    { ID: 'GD0003', ARCHETYPE_ID: 'a', TARGET_KIND: 'general', STATUS: 'archived', CREATED_AT: '2026-08-18' },
  ] });
  const client = createDocsRegistryClient(store);
  const all = await client.listDocs();
  assert.deepEqual(all.map(r => r.ID), ['GD0001', 'GD0003']);   // deleted excluded, newest first
  const archived = await client.listDocs({ status: 'archived' });
  assert.deepEqual(archived.map(r => r.ID), ['GD0003']);
  const byArchetype = await client.listDocs({ archetypeId: 'a' });
  assert.deepEqual(byArchetype.map(r => r.ID), ['GD0001', 'GD0003']);
});

test('updateDoc(status: deleted) soft-deletes the row AND unlinks the local files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-test-'));
  const localPath = path.join(dir, 'doc.docx');
  const contentJsonPath = path.join(dir, 'doc.content.json');
  fs.writeFileSync(localPath, 'x');
  fs.writeFileSync(contentJsonPath, '{}');
  const store = makeStore({ 'scope/generated_docs.tsv': [
    { ID: 'GD0001', LOCAL_PATH: localPath, CONTENT_JSON_PATH: contentJsonPath, STATUS: 'active' },
  ] });
  const client = createDocsRegistryClient(store);
  await client.updateDoc('GD0001', { status: 'deleted' });
  assert.equal(store.data['scope/generated_docs.tsv'][0].STATUS, 'deleted');
  assert.equal(fs.existsSync(localPath), false);
  assert.equal(fs.existsSync(contentJsonPath), false);
});

test('updateDoc(status: archived) sets ARCHIVED_AT without touching local files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-test-'));
  const localPath = path.join(dir, 'doc.docx');
  fs.writeFileSync(localPath, 'x');
  const store = makeStore({ 'scope/generated_docs.tsv': [{ ID: 'GD0001', LOCAL_PATH: localPath, STATUS: 'active', ARCHIVED_AT: '-' }] });
  const client = createDocsRegistryClient(store);
  await client.updateDoc('GD0001', { status: 'archived' });
  const row = store.data['scope/generated_docs.tsv'][0];
  assert.equal(row.STATUS, 'archived');
  assert.notEqual(row.ARCHIVED_AT, '-');
  assert.equal(fs.existsSync(localPath), true);
});

test('downloadDoc returns base64 bytes and a content type derived from the extension', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-test-'));
  const localPath = path.join(dir, 'doc.docx');
  fs.writeFileSync(localPath, 'hello');
  const store = makeStore({ 'scope/generated_docs.tsv': [{ ID: 'GD0001', LOCAL_PATH: localPath, FILENAME: 'doc.docx' }] });
  const client = createDocsRegistryClient(store);
  const r = await client.downloadDoc('GD0001');
  assert.equal(Buffer.from(r.base64, 'base64').toString(), 'hello');
  assert.equal(r.contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('getContent reads back the stored content.json for the Edit action', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-test-'));
  const contentJsonPath = path.join(dir, 'doc.content.json');
  fs.writeFileSync(contentJsonPath, JSON.stringify({ archetype: 'decision-brief', content: { title: 'Hello' } }));
  const store = makeStore({ 'scope/generated_docs.tsv': [
    { ID: 'GD0001', ARCHETYPE_ID: 'decision-brief', TARGET_KIND: 'project', TARGET_ID: 'p1', TARGET_LABEL: 'Project One', CONTENT_JSON_PATH: contentJsonPath },
  ] });
  const client = createDocsRegistryClient(store);
  const r = await client.getContent('GD0001');
  assert.equal(r.archetypeId, 'decision-brief');
  assert.equal(r.targetId, 'p1');
  assert.deepEqual(r.content, { title: 'Hello' });
});

test('getContent throws a clear error when the content.json is missing from disk', async () => {
  const store = makeStore({ 'scope/generated_docs.tsv': [{ ID: 'GD0001', CONTENT_JSON_PATH: '-' }] });
  const client = createDocsRegistryClient(store);
  await assert.rejects(() => client.getContent('GD0001'), /No content\.json/);
});

test('tasksForDoc only scopes by PROJECT_ID for project-target docs, empty otherwise', async () => {
  const store = makeStore({
    'scope/generated_docs.tsv': [
      { ID: 'GD0001', TARGET_KIND: 'project', TARGET_ID: 'proj1' },
      { ID: 'GD0002', TARGET_KIND: 'engagement', TARGET_ID: 'eng1' },
    ],
    'scope/tasks.tsv': [
      { ID: 'T1', PROJECT_ID: 'proj1', TITLE: 'In scope' },
      { ID: 'T2', PROJECT_ID: 'proj2', TITLE: 'Different project' },
    ],
  });
  const client = createDocsRegistryClient(store);
  const projectTasks = await client.tasksForDoc('GD0001');
  assert.deepEqual(projectTasks.map(t => t.ID), ['T1']);
  const engagementTasks = await client.tasksForDoc('GD0002');
  assert.deepEqual(engagementTasks, []);
});

test('attachToTask sets the doc\'s TASK_ID, and writes the task DELIVERABLE only once a webUrl exists', async () => {
  const store = makeStore({
    'scope/generated_docs.tsv': [{ ID: 'GD0001', TASK_ID: '-', ONEDRIVE_WEBURL: '-', STATUS: 'active', ARCHIVED_AT: '-' }],
    'scope/tasks.tsv': [{ ID: 'T1', DELIVERABLE: '-' }],
  });
  const client = createDocsRegistryClient(store);
  await client.attachToTask('GD0001', 'T1');
  assert.equal(store.data['scope/generated_docs.tsv'][0].TASK_ID, 'T1');
  assert.equal(store.data['scope/tasks.tsv'][0].DELIVERABLE, '-');   // no webUrl yet -- not overwritten with garbage

  store.data['scope/generated_docs.tsv'][0].ONEDRIVE_WEBURL = 'https://example.com/doc';
  await client.attachToTask('GD0001', 'T1');
  assert.equal(store.data['scope/tasks.tsv'][0].DELIVERABLE, 'https://example.com/doc');
});

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
  const r = await client.recordGenerated({ archetypeId: 'decision-brief', targetKind: 'project', targetId: 'p1', targetLabel: 'Project One', written, version: '0.1.0' });
  assert.ok(r.id);
  const rows = store.data['scope/generated_docs.tsv'];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].FILENAME, 'doc.docx');
  assert.equal(rows[0].STATUS, 'active');
  assert.equal(rows[0].TARGET_ID, 'p1');
});

test('recordGenerated pushes to OneDrive and stores the real webUrl for a General target', async () => {
  const store = makeStore();
  let uploadCall = null;
  const uploadFile = async (folderPath, fileName, buffer, contentType) => { uploadCall = { folderPath, fileName, contentType }; return 'https://onedrive.example/general-doc'; };
  const client = createDocsRegistryClient({ ...store, uploadFile });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-test-'));
  const written = fakeWritten(dir, { docx: 'doc.docx', 'content.json': 'doc.content.json' });
  const r = await client.recordGenerated({ archetypeId: 'email', targetKind: 'general', written, version: '0.1.0' });
  assert.equal(r.webUrl, 'https://onedrive.example/general-doc');
  assert.equal(uploadCall.folderPath, 'Sconl/Core/Axial/Visionary/Writer/general');
  assert.equal(uploadCall.fileName, 'doc.docx');
  const row = store.data['scope/generated_docs.tsv'][0];
  assert.equal(row.ONEDRIVE_WEBURL, 'https://onedrive.example/general-doc');
});

test('recordGenerated with no resolveProjectFolder injected does NOT push a project target (default passthrough returns null)', async () => {
  const store = makeStore();
  let called = false;
  const uploadFile = async () => { called = true; return 'https://should-not-be-called'; };
  const client = createDocsRegistryClient({ ...store, uploadFile });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-test-'));
  const written = fakeWritten(dir, { docx: 'doc.docx' });
  const r = await client.recordGenerated({ archetypeId: 'decision-brief', targetKind: 'project', targetId: 'p1', written, version: '0.1.0' });
  assert.equal(called, false);
  assert.equal(r.webUrl, null);
  assert.equal(store.data['scope/generated_docs.tsv'][0].ONEDRIVE_WEBURL, '-');
});

test('recordGenerated pushes a project target straight into ventures.tsv\'s own FOLDER path, no root-prefixing (BA26082402)', async () => {
  const store = makeStore();
  let uploadCall = null;
  const uploadFile = async (folderPath, fileName) => { uploadCall = { folderPath, fileName }; return 'https://onedrive.example/aquifer-doc'; };
  const resolveProjectFolder = async (ventureId) => (ventureId === 'aquifer' ? 'Sconl/Core/Axial/Innovator/Engineer/engineer-systems/Portfolio/aquifer-content' : null);
  const client = createDocsRegistryClient({ ...store, uploadFile, resolveProjectFolder });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-test-'));
  const written = fakeWritten(dir, { docx: 'doc.docx' });
  const r = await client.recordGenerated({ archetypeId: 'decision-brief', targetKind: 'project', targetId: 'aquifer', written, version: '0.1.0' });
  assert.equal(r.webUrl, 'https://onedrive.example/aquifer-doc');
  assert.equal(uploadCall.folderPath, 'Sconl/Core/Axial/Innovator/Engineer/engineer-systems/Portfolio/aquifer-content');
});

test('recordGenerated refuses the push (no guessed fallback) for a venture with no FOLDER assigned', async () => {
  const store = makeStore();
  let called = false;
  const uploadFile = async () => { called = true; return 'https://should-not-be-called'; };
  const resolveProjectFolder = async () => null;   // e.g. ventures.tsv's FOLDER: '-'
  const client = createDocsRegistryClient({ ...store, uploadFile, resolveProjectFolder });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-test-'));
  const written = fakeWritten(dir, { docx: 'doc.docx' });
  const r = await client.recordGenerated({ archetypeId: 'decision-brief', targetKind: 'project', targetId: 'acexoft-dynamics', written, version: '0.1.0' });
  assert.equal(called, false);
  assert.equal(r.webUrl, null);
  assert.equal(store.data['scope/generated_docs.tsv'][0].ONEDRIVE_WEBURL, '-');
});

test('recordGenerated pushes an engagement target into its real discovered OneDrive folder (BA26081803)', async () => {
  const store = makeStore();
  let uploadCall = null;
  const uploadFile = async (folderPath, fileName) => { uploadCall = { folderPath, fileName }; return 'https://onedrive.example/viva-doc'; };
  const resolveEngagementFolder = async (orgId) => (orgId === 'viva-valentia' ? '2026-viva-valentia' : orgId);
  const client = createDocsRegistryClient({ ...store, uploadFile, resolveEngagementFolder });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-test-'));
  const written = fakeWritten(dir, { docx: 'doc.docx' });
  const r = await client.recordGenerated({ archetypeId: 'decision-brief', targetKind: 'engagement', targetId: 'viva-valentia', written, version: '0.1.0' });
  assert.equal(r.webUrl, 'https://onedrive.example/viva-doc');
  assert.equal(uploadCall.folderPath, 'Sconl/Core/Axial/Visionary/Corporate/2026-viva-valentia');
});

test('recordGenerated falls back to the bare org id for an engagement with no resolvable OneDrive folder', async () => {
  const store = makeStore();
  let uploadCall = null;
  const uploadFile = async (folderPath, fileName) => { uploadCall = { folderPath, fileName }; return 'https://onedrive.example/hand-added-doc'; };
  const client = createDocsRegistryClient({ ...store, uploadFile }); // default resolveEngagementFolder passthrough
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-test-'));
  const written = fakeWritten(dir, { docx: 'doc.docx' });
  await client.recordGenerated({ archetypeId: 'decision-brief', targetKind: 'engagement', targetId: 'hand-added-org', written, version: '0.1.0' });
  assert.equal(uploadCall.folderPath, 'Sconl/Core/Axial/Visionary/Corporate/hand-added-org');
});

test('recordGenerated still indexes the row locally even when the OneDrive push fails', async () => {
  const store = makeStore();
  const uploadFile = async () => { throw new Error('graph down'); };
  const client = createDocsRegistryClient({ ...store, uploadFile });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-test-'));
  const written = fakeWritten(dir, { docx: 'doc.docx' });
  const r = await client.recordGenerated({ archetypeId: 'email', targetKind: 'general', written, version: '0.1.0' });
  assert.ok(r.id);
  assert.equal(r.webUrl, null);
  assert.equal(store.data['scope/generated_docs.tsv'][0].STATUS, 'active');
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

test('listDocsMerged (BA26083107): merges a live OneDrive listing for the given engagement, tagged and deduped against generated rows', async () => {
  const store = makeStore({ 'scope/generated_docs.tsv': [
    { ID: 'GD0001', ARCHETYPE_ID: 'a', TARGET_KIND: 'engagement', TARGET_ID: 'viva-valentia', FILENAME: 'already-generated.docx', STATUS: 'active', CREATED_AT: '2026-08-19' },
  ] });
  const browseFolder = async (folderPath) => {
    assert.equal(folderPath, 'Sconl/Core/Axial/Visionary/Corporate/2026-viva-valentia/work-documents');
    return { ok: true, items: [
      { id: 'i1', name: 'already-generated.docx', webUrl: 'https://onedrive.example/dup' }, // should be deduped out
      { id: 'i2', name: 'competitor-position-review.pdf', webUrl: 'https://onedrive.example/pdf', downloadUrl: 'https://onedrive.example/pdf/dl', lastModifiedDateTime: '2026-08-23T10:00:00Z' },
      { id: 'i3', name: 'subfolder', folder: { childCount: 2 } }, // should be excluded, not a file
    ] };
  };
  const resolveEngagementFolder = async (id) => (id === 'viva-valentia' ? '2026-viva-valentia' : id);
  const client = createDocsRegistryClient({ ...store, browseFolder, resolveEngagementFolder });
  const merged = await client.listDocsMerged({}, { id: 'viva-valentia', label: 'Viva Valentia' });
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map(r => r.FILENAME).sort(), ['already-generated.docx', 'competitor-position-review.pdf']);
  const onedriveEntry = merged.find(r => r.FILENAME === 'competitor-position-review.pdf');
  assert.equal(onedriveEntry.SOURCE, 'onedrive');
  assert.equal(onedriveEntry.ONEDRIVE_WEBURL, 'https://onedrive.example/pdf');
  assert.equal(onedriveEntry.ONEDRIVE_DOWNLOAD_URL, 'https://onedrive.example/pdf/dl');
  assert.equal(onedriveEntry.TARGET_LABEL, 'Viva Valentia');
  assert.equal(onedriveEntry.LOCAL_PATH, '-');   // nothing to re-open in the Edit studio
  const generatedEntry = merged.find(r => r.FILENAME === 'already-generated.docx');
  assert.equal(generatedEntry.SOURCE, 'generated');
});

test('listDocsMerged falls back to generated-only when browseFolder fails, and skips the merge with no mergeEngagement', async () => {
  const store = makeStore({ 'scope/generated_docs.tsv': [
    { ID: 'GD0001', ARCHETYPE_ID: 'a', TARGET_KIND: 'engagement', TARGET_ID: 'viva-valentia', FILENAME: 'doc.docx', STATUS: 'active', CREATED_AT: '2026-08-19' },
  ] });
  const failingBrowse = async () => ({ ok: false, error: 'vault unreachable' });
  const client = createDocsRegistryClient({ ...store, browseFolder: failingBrowse });
  const withFailure = await client.listDocsMerged({}, { id: 'viva-valentia' });
  assert.equal(withFailure.length, 1);
  assert.equal(withFailure[0].SOURCE, 'generated');
  const withoutMerge = await client.listDocsMerged({}, null);
  assert.equal(withoutMerge.length, 1);
});

test('listDocsMerged does not merge OneDrive when the filter explicitly scopes to a non-engagement targetKind', async () => {
  const store = makeStore({ 'scope/generated_docs.tsv': [
    { ID: 'GD0001', TARGET_KIND: 'general', FILENAME: 'general-doc.docx', STATUS: 'active', CREATED_AT: '2026-08-19' },
  ] });
  let browseCalled = false;
  const browseFolder = async () => { browseCalled = true; return { ok: true, items: [] }; };
  const client = createDocsRegistryClient({ ...store, browseFolder });
  const result = await client.listDocsMerged({ targetKind: 'general' }, { id: 'viva-valentia' });
  assert.equal(browseCalled, false);
  assert.equal(result.length, 1);
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

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStatusBriefClient } = require('../lib/status-brief');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: async (rel) => (data[rel] || []).slice(),
    appendTSV: async (rel, row) => { (data[rel] = data[rel] || []).push(row); return true; },
    rewriteTSV: async (rel, fn) => { data[rel] = fn((data[rel] || []).slice()); return data[rel].length; },
  };
}

const SUBJECT = { SUBJECT_ID: 'SUBJ001', TYPE: 'engagement', SOURCE_REF: 'viva', STATUS: 'active', SUPERVISOR_OR_CONTACT: 'Alex Rivera' };
const DRAFT_RESULT = { ok: true, data: { signal: ['s1'], substance: ['sub1'], trajectory: ['t1'] } };

function todayISO() { return new Date().toISOString().slice(0, 10); }

test('createStatusBriefClient throws without readTSV/appendTSV or callSpark', () => {
  assert.throws(() => createStatusBriefClient({}));
  assert.throws(() => createStatusBriefClient({ readTSV: async () => [], appendTSV: async () => {} }));
});

test('gatherActivity filters tasks by ORG_ID and both sources to the last 7 days', async () => {
  const store = makeStore({
    'scope/tasks.tsv': [
      { ORG_ID: 'viva', CREATED_AT: todayISO(), TITLE: 'In window, matching org' },
      { ORG_ID: 'other', CREATED_AT: todayISO(), TITLE: 'Wrong org' },
      { ORG_ID: 'viva', CREATED_AT: '2020-01-01', TITLE: 'Too old' },
    ],
    'circle/interactions.tsv': [{ DATE: todayISO(), SUMMARY: 'Recent touch' }],
  });
  const client = createStatusBriefClient({ ...store, callSpark: async () => DRAFT_RESULT });
  const activity = await client.gatherActivity(SUBJECT);
  const summaries = activity.map(a => a.summary);
  assert.ok(summaries.includes('In window, matching org'));
  assert.ok(!summaries.includes('Wrong org'));
  assert.ok(!summaries.includes('Too old'));
  assert.ok(summaries.includes('Recent touch'));
});

test('draftBrief calls spark with the subject/supervisor and stores a draft row', async () => {
  const store = makeStore({ 'scope/active_subjects.tsv': [SUBJECT] });
  let seenQuery;
  const client = createStatusBriefClient({ ...store, callSpark: async (q) => { seenQuery = q; return DRAFT_RESULT; } });
  const r = await client.draftBrief('SUBJ001');
  assert.ok(r.success);
  assert.equal(seenQuery.subjectName, 'viva');
  assert.equal(seenQuery.supervisorName, 'Alex Rivera');
  const rows = await client.listBriefs();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].SIGNAL, ['s1']);
  assert.equal(rows[0].STATUS, 'draft');
});

test('draftBrief throws for an unknown subjectId', async () => {
  const client = createStatusBriefClient({ ...makeStore(), callSpark: async () => DRAFT_RESULT });
  await assert.rejects(() => client.draftBrief('nope'));
});

test('draftBrief surfaces a spark failure as success:false rather than throwing', async () => {
  const store = makeStore({ 'scope/active_subjects.tsv': [SUBJECT] });
  const client = createStatusBriefClient({ ...store, callSpark: async () => ({ ok: false, error: 'groq down' }) });
  const r = await client.draftBrief('SUBJ001');
  assert.equal(r.success, false);
  assert.equal(r.error, 'groq down');
});

test('draftAllBriefs drafts every non-retired subject, one failure does not block the rest', async () => {
  const store = makeStore({ 'scope/active_subjects.tsv': [
    SUBJECT,
    { SUBJECT_ID: 'SUBJ002', SOURCE_REF: 'gone', STATUS: 'retired' },
    { SUBJECT_ID: 'SUBJ003', SOURCE_REF: 'other', STATUS: 'active' },
  ] });
  let calls = 0;
  const client = createStatusBriefClient({
    ...store,
    callSpark: async (q) => { calls += 1; if (q.subjectName === 'other') throw new Error('boom'); return DRAFT_RESULT; },
  });
  const r = await client.draftAllBriefs();
  assert.equal(calls, 2); // retired subject skipped
  assert.equal(r.drafted, 1);
});

test('sendBrief refuses WhatsApp cleanly rather than silently no-op', async () => {
  const store = makeStore({ 'scope/status_briefs.tsv': [] });
  const client = createStatusBriefClient({ ...store, callSpark: async () => DRAFT_RESULT });
  const r = await client.sendBrief('SB0001', { via: 'whatsapp', to: 'x@example.com' });
  assert.equal(r.success, false);
  assert.match(r.error, /WhatsApp/);
});

test('sendBrief requires sendMail configured and a "to" address', async () => {
  const store = makeStore({ 'scope/status_briefs.tsv': [] });
  const client = createStatusBriefClient({ ...store, callSpark: async () => DRAFT_RESULT });
  assert.equal((await client.sendBrief('SB0001', { via: 'email' })).success, false);
});

test('sendBrief sends the composed body and marks the brief sent on success', async () => {
  const briefRow = { ID: 'SB0001', SUBJECT_ID: 'SUBJ001', WEEK_OF: '2026-08-24', SIGNAL: '["s1"]', SUBSTANCE: '["sub1"]', TRAJECTORY: '["t1"]', STATUS: 'draft', SENT_VIA: '-', SENT_AT: '-' };
  const store = makeStore({ 'scope/status_briefs.tsv': [briefRow] });
  let sentBody;
  const client = createStatusBriefClient({
    ...store, callSpark: async () => DRAFT_RESULT,
    sendMail: async ({ to, subject, body }) => { sentBody = { to, subject, body }; return { ok: true }; },
  });
  const r = await client.sendBrief('SB0001', { via: 'email', to: 'sconl@acexoft.com' });
  assert.ok(r.success);
  assert.match(sentBody.subject, /SUBJ001/);
  assert.match(sentBody.body, /s1/);
  const rows = await client.listBriefs();
  assert.equal(rows[0].STATUS, 'sent');
  assert.equal(rows[0].SENT_VIA, 'email');
});

test('sendBrief surfaces a mail-send failure without marking the brief sent', async () => {
  const briefRow = { ID: 'SB0001', SUBJECT_ID: 'SUBJ001', WEEK_OF: '2026-08-24', SIGNAL: '[]', SUBSTANCE: '[]', TRAJECTORY: '[]', STATUS: 'draft', SENT_VIA: '-', SENT_AT: '-' };
  const store = makeStore({ 'scope/status_briefs.tsv': [briefRow] });
  const client = createStatusBriefClient({ ...store, callSpark: async () => DRAFT_RESULT, sendMail: async () => ({ ok: false, error: 'graph down' }) });
  const r = await client.sendBrief('SB0001', { via: 'email', to: 'x@example.com' });
  assert.equal(r.success, false);
  const rows = await client.listBriefs();
  assert.equal(rows[0].STATUS, 'draft');
});

test('mondayOf resolves a date to its ISO week Monday', () => {
  const client = createStatusBriefClient({ ...makeStore(), callSpark: async () => DRAFT_RESULT });
  assert.equal(client.mondayOf('2026-08-27'), '2026-08-24'); // Thursday -> that week's Monday
  assert.equal(client.mondayOf('2026-08-24'), '2026-08-24'); // Monday -> itself
});

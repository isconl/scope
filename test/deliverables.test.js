'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const deliv = require('../lib/deliverables');

function tmpWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-deliv-test-'));
  const docsDir = path.join(workspace, 'Viva', 'work-tasks');
  fs.mkdirSync(docsDir, { recursive: true });
  return { workspace, docsDir };
}

test('readLinks splits the DELIVERABLE column on | and drops blanks/dashes', () => {
  const links = deliv.readLinks({ DELIVERABLE: 'a/b.md | - | c/d.pdf | ' });
  assert.deepEqual(links, ['a/b.md', 'c/d.pdf']);
});

test('readLinks returns an empty array when the column is missing or a dash', () => {
  assert.deepEqual(deliv.readLinks({}), []);
  assert.deepEqual(deliv.readLinks({ DELIVERABLE: '-' }), []);
});

test('isDeliverable rejects non-document extensions, README-shaped tooling docs, and build/cache paths', () => {
  assert.equal(deliv.isDeliverable({ name: '20260101_note_gap_register_v1.md', path: 'work-tasks/x' }), true);
  assert.equal(deliv.isDeliverable({ name: 'reference.ts', path: 'work-tasks/x' }), false);
  assert.equal(deliv.isDeliverable({ name: 'README.md', path: 'work-tasks/x' }), false);
  assert.equal(deliv.isDeliverable({ name: 'report.pdf', path: 'work-tasks/node_modules/x' }), false);
});

test('roleOf identifies a conventionally-named message/note file, and a deliverable otherwise', () => {
  assert.equal(deliv.roleOf('20260101_class_message_project_followup_v1.md'), 'note');
  assert.equal(deliv.roleOf('20260101_class_report_project_gap-register_v1.md'), 'deliverable');
  assert.equal(deliv.roleOf('quick-reply-caption.txt'), 'note');
});

test('parseName recognises the YYYYMMDD_class_type_project_descriptor convention and falls back to loose tokens otherwise', () => {
  const conv = deliv.parseName('20260315_note_report_wellpath_gap-register_v1_0_0.md');
  assert.equal(conv.conventional, true);
  assert.equal(conv.date, '20260315');
  assert.equal(conv.project, 'wellpath');

  const loose = deliv.parseName('random-file-name.md');
  assert.equal(loose.conventional, false);
  assert.ok(loose.tokens.includes('random'));
});

test('composeNote names the single file, lists multiple files, or falls back to the task title with none', () => {
  const one = deliv.composeNote({ TITLE: 'Ship D-030' }, [{ name: 'report.pdf' }], 'Taylor');
  assert.match(one, /^Taylor,/);
  assert.match(one, /report\.pdf \(D-030\)/);

  const many = deliv.composeNote({ TITLE: 'x' }, [{ name: 'a.pdf' }, { name: 'b.pdf' }], null);
  assert.match(many, /2 files/);

  const none = deliv.composeNote({ TITLE: 'Follow up on the audit' }, [], null);
  assert.match(none, /Following up on: Follow up on the audit/);
});

test('resolveNote rung 3 (composed) is always available with no note file and no cached draft', () => {
  const { workspace } = tmpWorkspace();
  const r = deliv.resolveNote({ ID: 'T1', TITLE: 'Ship it' }, { deliverables: [], notes: [] }, { workspace, drafts: {} });
  assert.equal(r.source, 'composed');
  assert.match(r.text, /Following up on: Ship it/);
});

test('resolveNote rung 2 (cached draft) wins over rung 3 when no note file exists', () => {
  const { workspace } = tmpWorkspace();
  const drafts = { 'T1:whatsapp': { current: { body: 'Here is the file', to: 'Taylor', channel: 'whatsapp', generatedAt: '2026-01-01T00:00:00Z' } } };
  const r = deliv.resolveNote({ ID: 'T1', TITLE: 'x' }, { deliverables: [], notes: [] }, { workspace, drafts });
  assert.equal(r.source, 'draft');
  assert.equal(r.text, 'Here is the file');
});

test('resolveNote rung 1 (an authored note file) wins over both a cached draft and composing', () => {
  const { workspace, docsDir } = tmpWorkspace();
  const noteFile = path.join(docsDir, '20260101_note_message_x_followup_v1.md');
  fs.writeFileSync(noteFile, 'Written by hand, exactly this.');
  const rel = path.relative(workspace, noteFile).replace(/\\/g, '/');
  const drafts = { 'T1:whatsapp': { current: { body: 'draft body', generatedAt: '2026-01-01T00:00:00Z' } } };
  const r = deliv.resolveNote({ ID: 'T1', TITLE: 'x' },
    { deliverables: [], notes: [{ rel, name: path.basename(noteFile) }] },
    { workspace, drafts });
  assert.equal(r.source, 'file');
  assert.equal(r.text, 'Written by hand, exactly this.');
});

test('collect() finds a linked deliverable inside the declared roots and reports a missing link as dead', () => {
  const { workspace, docsDir } = tmpWorkspace();
  const realFile = path.join(docsDir, '20260101_report_gap_register_v1.md');
  fs.writeFileSync(realFile, '# Gap register\n\nSome real content here.');
  const rel = path.relative(workspace, realFile).replace(/\\/g, '/');

  const bag = deliv.collect({ ID: 'T1', TITLE: 'x', DELIVERABLE: `${rel} | Viva/work-tasks/does-not-exist.md` }, { workspace });
  assert.equal(bag.dead.length, 1);
  assert.ok(bag.all.some(d => d.rel === rel && d.source === 'linked'));
});

test('collect() refuses a linked path that escapes the declared roots, reporting it as dead', () => {
  const { workspace } = tmpWorkspace();
  const outside = path.join(os.tmpdir(), 'outside-scope-test.md');
  fs.writeFileSync(outside, 'should not be reachable');
  const rel = path.relative(workspace, outside).replace(/\\/g, '/');
  const bag = deliv.collect({ ID: 'T1', TITLE: 'x', DELIVERABLE: rel }, { workspace });
  assert.equal(bag.dead.length, 1);
  assert.equal(bag.all.length, 0);
});

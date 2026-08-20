'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../lib/store');

test('uploadFile POSTs base64 content and returns the real webUrl from vault\'s response (not a constructed path)', async () => {
  let seenPath, seenBody;
  const requestImpl = async (method, path, body) => {
    seenPath = path; seenBody = body;
    return { status: 200, data: { ok: true, item: { webUrl: 'https://onedrive.example/real-link' } } };
  };
  const store = createStore({ baseUrl: 'http://x', requestImpl });
  const url = await store.uploadFile('Writer/general', 'doc.docx', Buffer.from('hello'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(seenPath, '/onedrive/upload');
  assert.equal(seenBody.folderPath, 'Writer/general');
  assert.equal(seenBody.contentBase64, Buffer.from('hello').toString('base64'));
  assert.equal(url, 'https://onedrive.example/real-link');
});

test('uploadFile returns null (not throw) on a failed upload', async () => {
  const requestImpl = async () => ({ status: 502, data: { ok: false, error: 'graph down' } });
  const store = createStore({ baseUrl: 'http://x', requestImpl });
  const url = await store.uploadFile('Writer/general', 'doc.docx', Buffer.from('x'), 'text/plain');
  assert.equal(url, null);
});

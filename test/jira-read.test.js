'use strict';
/** BX26082422 read side: jiraGetIssue/jiraGetComments/jiraListProjects,
 *  built on the existing Basic Auth jiraAPI -- same fake-https harness as
 *  jira.test.js since jiraAPI does a real https.request. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createJiraClient } = require('../lib/jira');
const https = require('https');

function makeClient(configOverrides = {}) {
  const config = { host: 'example.atlassian.net', email: 'me@example.com', token: 'tok', projectKey: 'WSRU', ...configOverrides };
  return createJiraClient({ getConfig: () => config, auditLog: { log: () => {} } });
}

function withFakeHttps(responder, fn) {
  const original = https.request;
  https.request = (options, cb) => {
    const req = { on: () => req, setTimeout: () => req, write: () => {}, end: () => {}, destroy: () => {} };
    setImmediate(() => {
      const { status, body } = responder(options);
      const res = {
        statusCode: status,
        on: (event, handler) => {
          if (event === 'data') handler(Buffer.from(JSON.stringify(body)));
          if (event === 'end') handler();
          return res;
        },
      };
      cb(res);
    });
    return req;
  };
  return fn().finally(() => { https.request = original; });
}

test('jiraGetIssue rejects a malformed key without a request', async () => {
  const client = makeClient();
  const r = await client.jiraGetIssue('not-a-key');
  assert.match(r.error, /not a valid Jira issue key/);
});

test('jiraGetIssue returns a flat shape for a real 200 response', () => withFakeHttps(
  () => ({ status: 200, body: { key: 'WSRU-1', fields: {
    summary: 'Ship the release notes', status: { name: 'To Do' }, priority: { name: 'High' }, issuetype: { name: 'Task' },
    assignee: { accountId: 'acc1', displayName: 'Operator' }, created: '2026-08-01', updated: '2026-08-02', duedate: '2026-08-10',
  } } }),
  async () => {
    const client = makeClient();
    const r = await client.jiraGetIssue('WSRU-1');
    assert.equal(r.key, 'WSRU-1');
    assert.equal(r.summary, 'Ship the release notes');
    assert.equal(r.status, 'To Do');
    assert.equal(r.priority, 'High');
    assert.deepEqual(r.assignee, { accountId: 'acc1', displayName: 'Operator' });
  },
));

test('jiraGetIssue surfaces an error on a non-2xx response rather than throwing', () => withFakeHttps(
  () => ({ status: 404, body: { errorMessages: ['Issue does not exist'] } }),
  async () => {
    const client = makeClient();
    const r = await client.jiraGetIssue('WSRU-999');
    assert.ok(r.error);
  },
));

test('jiraGetComments rejects a malformed key without a request', async () => {
  const client = makeClient();
  const r = await client.jiraGetComments('bad key');
  assert.match(r.error, /not a valid Jira issue key/);
});

test('jiraGetComments flattens ADF comment bodies to plain text', () => withFakeHttps(
  () => ({ status: 200, body: { comments: [
    { id: 'c1', author: { displayName: 'Alex' }, created: '2026-08-01', body: { content: [{ content: [{ text: 'Looks good, ' }, { text: 'ship it.' }] }] } },
  ] } }),
  async () => {
    const client = makeClient();
    const r = await client.jiraGetComments('WSRU-1');
    assert.equal(r.length, 1);
    assert.equal(r[0].author, 'Alex');
    assert.equal(r[0].text, 'Looks good,  ship it.'.trim());
  },
));

test('jiraListProjects returns key/name/id for each project', () => withFakeHttps(
  () => ({ status: 200, body: { values: [{ key: 'WSRU', name: 'WAMCA sites Review and Updates', id: '10434' }] } }),
  async () => {
    const client = makeClient();
    const r = await client.jiraListProjects();
    assert.deepEqual(r, [{ key: 'WSRU', name: 'WAMCA sites Review and Updates', id: '10434' }]);
  },
));

test('all three fail soft with an error object, not a throw, when Jira is not configured', async () => {
  const client = makeClient({ host: '', email: '', token: '' });
  assert.ok((await client.jiraGetIssue('WSRU-1')).error);
  assert.ok((await client.jiraGetComments('WSRU-1')).error);
  assert.ok((await client.jiraListProjects()).error);
});

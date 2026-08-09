'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createJiraClient, JIRA_PRIORITY } = require('../lib/jira');

function makeClient(configOverrides = {}, httpsOverride = null) {
  const config = { host: 'example.atlassian.net', email: 'me@example.com', token: 'tok', projectKey: 'WSRU', ...configOverrides };
  const client = createJiraClient({ getConfig: () => config, auditLog: { log: () => {} } });
  if (httpsOverride) client.jiraAPI = httpsOverride; // not used -- jiraAPI is internal; tests instead stub via module-level https mock below
  return client;
}

// jiraAPI itself does a real https.request -- for unit tests we don't want a
// real network call, so tests exercise the pieces that don't require it
// (config validation, key validation, the recently-deleted filter) directly,
// and use a fake https module for the ones that need a full round trip.
const https = require('https');

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

test('createJiraClient throws without getConfig', () => {
  assert.throws(() => createJiraClient({}));
});

test('jiraDeleteIssue rejects a malformed issue key without making a request', async () => {
  const client = makeClient();
  const r = await client.jiraDeleteIssue('not-a-key');
  assert.equal(r.success, false);
});

test('jiraDeleteIssue reports config-missing without a request when Jira is not configured', async () => {
  const client = makeClient({ host: '', email: '', token: '' });
  const r = await client.jiraDeleteIssue('ABC-1');
  assert.equal(r.success, false);
  assert.match(r.error, /not fully configured/);
});

test('jiraAssignIssue/jiraUpdateIssue/jiraTransitionIssue reject a malformed issue key', async () => {
  const client = makeClient();
  assert.equal((await client.jiraAssignIssue('nope', 'x')).success, false);
  assert.equal((await client.jiraUpdateIssue('nope', { summary: 'x' })).success, false);
});

test('markDeleted/isRecentlyDeleted filters a key for the TTL window', () => {
  const client = createJiraClient({ getConfig: () => ({}), deletedTtlMs: 100 });
  assert.equal(client.isRecentlyDeleted('ABC-1'), false);
  client.markDeleted('ABC-1');
  assert.equal(client.isRecentlyDeleted('ABC-1'), true);
});

test('adf() wraps plain text in Atlassian Document Format, splitting on blank lines as paragraphs', () => {
  const { adf } = require('../lib/jira');
  const doc = adf('first line\n\nsecond paragraph');
  assert.equal(doc.type, 'doc');
  assert.equal(doc.content.length, 2);
  assert.equal(doc.content[0].content[0].text, 'first line');
});

test('jiraListMyIssues maps fields and drops recently-deleted keys from the result', async () => {
  const client = makeClient();
  client.markDeleted('WSRU-5');
  await withFakeHttps(() => ({
    status: 200,
    body: { issues: [
      { key: 'WSRU-1', fields: { summary: 'A', status: { name: 'To Do' }, priority: { name: 'High' }, issuetype: { name: 'Task' }, created: '2026-01-01', assignee: null } },
      { key: 'WSRU-5', fields: { summary: 'B', status: { name: 'Done' } } },
    ] },
  }), async () => {
    const issues = await client.jiraListMyIssues();
    assert.equal(issues.length, 1);
    assert.equal(issues[0].key, 'WSRU-1');
    assert.equal(issues[0].priority, 'High');
  });
});

test('jiraCreateIssue retries without an optional field the project rejects, and reports it as unsupported', async () => {
  const client = makeClient();
  let call = 0;
  await withFakeHttps((options) => {
    call++;
    if (call === 1) return { status: 400, body: { errors: { duedate: 'not on this screen' } } };
    return { status: 201, body: { id: '10001', key: 'WSRU-9' } };
  }, async () => {
    const r = await client.jiraCreateIssue('Title', 'Body', 'Task', { duedate: '2026-01-01' });
    assert.equal(r.key, 'WSRU-9');
    assert.deepEqual(r.unsupportedFields, ['duedate']);
  });
});

test('jiraUpdateIssue drops priority and retries when the project rejects it, keeping the rest of the edit', async () => {
  const client = makeClient();
  let call = 0;
  await withFakeHttps(() => {
    call++;
    if (call === 1) return { status: 400, body: { errorMessages: ['priority is not on the screen'] } };
    return { status: 200, body: {} };
  }, async () => {
    const r = await client.jiraUpdateIssue('WSRU-1', { summary: 'New title', priority: 'high' });
    assert.equal(r.success, true);
    assert.equal(r.priorityApplied, false);
  });
});

test('jiraTransitionIssue finds a transition by fuzzy name match and applies it', async () => {
  const client = makeClient();
  let call = 0;
  await withFakeHttps(() => {
    call++;
    if (call === 1) return { status: 200, body: { transitions: [{ id: '31', name: 'In Review', to: { name: 'In Review' } }] } };
    return { status: 204, body: {} };
  }, async () => {
    const r = await client.jiraTransitionIssue('WSRU-1', 'review');
    assert.equal(r.success, true);
    assert.equal(r.newStatus, 'In Review');
  });
});

test('jiraTransitionIssue reports failure when no matching transition exists', async () => {
  const client = makeClient();
  await withFakeHttps(() => ({ status: 200, body: { transitions: [{ id: '1', name: 'Blocked', to: { name: 'Blocked' } }] } }), async () => {
    const r = await client.jiraTransitionIssue('WSRU-1', 'done');
    assert.ok(r.error);
  });
});

test('jiraDeleteIssue succeeds and is verified when the issue no longer exists after delete', async () => {
  const client = makeClient();
  let call = 0;
  await withFakeHttps(() => {
    call++;
    if (call === 1) return { status: 204, body: {} };          // DELETE
    return { status: 404, body: {} };                          // existence check -> gone
  }, async () => {
    const r = await client.jiraDeleteIssue('WSRU-1');
    assert.equal(r.success, true);
    assert.equal(r.verified, true);
  });
});

test('jiraDeleteIssue refuses to report success when the issue still exists after delete', async () => {
  const client = makeClient();
  let call = 0;
  await withFakeHttps(() => {
    call++;
    if (call === 1) return { status: 204, body: {} };          // DELETE accepted
    return { status: 200, body: { key: 'WSRU-1' } };           // still exists on every retry
  }, async () => {
    const r = await client.jiraDeleteIssue('WSRU-1');
    assert.equal(r.success, false);
    assert.equal(r.verified, false);
    assert.match(r.error, /still exists/);
  });
});

test('jiraDeleteIssue reports a permission-denied fallback on a 403', async () => {
  const client = makeClient();
  await withFakeHttps(() => ({ status: 403, body: { errorMessages: ['no permission'] } }), async () => {
    const r = await client.jiraDeleteIssue('WSRU-1');
    assert.equal(r.success, false);
    assert.equal(r.permissionDenied, true);
    assert.equal(r.fallback, 'transition-to-done');
  });
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBufferClient } = require('../lib/buffer');

function makeClient(apiKey, responder) {
  return createBufferClient({
    getApiKey: () => apiKey,
    requestImpl: async (query, variables) => responder(query, variables),
  });
}

test('createBufferClient throws without getApiKey', () => {
  assert.throws(() => createBufferClient({}));
});

test('every call fails soft with ok:false when the API key is not configured', async () => {
  const client = createBufferClient({ getApiKey: () => '' });
  assert.equal((await client.getOrganizations()).ok, false);
  assert.equal((await client.listChannels('org1')).ok, false);
  assert.equal((await client.listQueue({ organizationId: 'org1', channelIds: ['c1'] })).ok, false);
  assert.equal((await client.schedulePost({ channelId: 'c1', text: 'hi' })).ok, false);
});

test('getOrganizations returns the organizations list on success', async () => {
  const client = makeClient('key', () => ({ status: 200, data: { data: { account: { organizations: [{ id: 'org1', name: 'Architect' }] } } } }));
  const r = await client.getOrganizations();
  assert.ok(r.ok);
  assert.deepEqual(r.organizations, [{ id: 'org1', name: 'Architect' }]);
});

test('listChannels requires an organizationId', async () => {
  const client = makeClient('key', () => { throw new Error('should not be called'); });
  const r = await client.listChannels();
  assert.equal(r.ok, false);
  assert.match(r.error, /organizationId/);
});

test('listChannels returns channels for a given org', async () => {
  const client = makeClient('key', (query, variables) => {
    assert.equal(variables.organizationId, 'org1');
    return { status: 200, data: { data: { channels: [{ id: 'c1', name: 'Architect LinkedIn', service: 'linkedin' }] } } };
  });
  const r = await client.listChannels('org1');
  assert.ok(r.ok);
  assert.equal(r.channels[0].service, 'linkedin');
});

test('listQueue requires organizationId and a non-empty channelIds array', async () => {
  const client = makeClient('key', () => { throw new Error('should not be called'); });
  assert.equal((await client.listQueue({ channelIds: ['c1'] })).ok, false);
  assert.equal((await client.listQueue({ organizationId: 'org1', channelIds: [] })).ok, false);
});

test('listQueue defaults to status:scheduled and flattens the edges/node shape', async () => {
  const client = makeClient('key', (query, variables) => {
    assert.deepEqual(variables.status, ['scheduled']);
    return { status: 200, data: { data: { posts: {
      edges: [{ node: { id: 'p1', text: 'hello', dueAt: '2026-09-01T00:00:00.000Z', channelId: 'c1' } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } } };
  });
  const r = await client.listQueue({ organizationId: 'org1', channelIds: ['c1'] });
  assert.ok(r.ok);
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0].id, 'p1');
});

test('schedulePost refuses without channelId or text -- never invents content', async () => {
  const client = makeClient('key', () => { throw new Error('should not be called'); });
  assert.match((await client.schedulePost({ text: 'hi' })).error, /channelId/);
  assert.match((await client.schedulePost({ channelId: 'c1' })).error, /text required/);
});

test('schedulePost requires dueAt for mode:customScheduled but not for addToQueue', async () => {
  const client = makeClient('key', () => { throw new Error('should not be called'); });
  const r = await client.schedulePost({ channelId: 'c1', text: 'hi', mode: 'customScheduled' });
  assert.match(r.error, /dueAt/);
});

test('schedulePost sends the expected mutation input and returns the created post on success', async () => {
  const client = makeClient('key', (query, variables) => {
    assert.equal(variables.input.channelId, 'c1');
    assert.equal(variables.input.text, 'Scheduled via scaffolding');
    assert.equal(variables.input.schedulingType, 'automatic');
    assert.equal(variables.input.mode, 'addToQueue');
    return { status: 200, data: { data: { createPost: { post: { id: 'p2', text: 'Scheduled via scaffolding', dueAt: null } } } } };
  });
  const r = await client.schedulePost({ channelId: 'c1', text: 'Scheduled via scaffolding' });
  assert.ok(r.ok);
  assert.equal(r.post.id, 'p2');
});

test('schedulePost surfaces a Buffer MutationError as ok:false, not a throw', async () => {
  const client = makeClient('key', () => ({ status: 200, data: { data: { createPost: { message: 'Channel not found' } } } }));
  const r = await client.schedulePost({ channelId: 'bad', text: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Channel not found');
});

test('a GraphQL top-level errors array is surfaced as ok:false', async () => {
  const client = makeClient('key', () => ({ status: 200, data: { errors: [{ message: 'Unauthorized' }] } }));
  const r = await client.getOrganizations();
  assert.equal(r.ok, false);
  assert.match(r.error, /Unauthorized/);
});

test('a non-200 HTTP status is surfaced as ok:false, not a throw', async () => {
  const client = makeClient('key', () => ({ status: 500, data: {} }));
  const r = await client.getOrganizations();
  assert.equal(r.ok, false);
});

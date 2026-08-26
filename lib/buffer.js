'use strict';
/**
 * BX26082423: Buffer social-scheduling engine -- scaffolding + API wiring
 * ONLY. Per Architect: content is authored elsewhere (a future, not-yet-scoped
 * "studio"); this module accepts already-written text + a target channel +
 * a schedule time and hands it to Buffer's queue. NO content generation,
 * NO auto-drafting, NO connection to BA26082403's episode binder or any
 * other content source -- do not guess at the studio's shape here.
 *
 * Buffer's current public API is GraphQL (the old REST "profiles.json"/
 * "updates/create.json" v1 API is a different, legacy generation) --
 * confirmed live against developers.buffer.com 26 Aug 2026, not assumed
 * from memory:
 *   - Endpoint: https://api.buffer.com (single POST endpoint, GraphQL)
 *   - Auth: Authorization: Bearer <BUFFER_API_KEY_SCONL>
 *   - account { organizations { id name } } -- an org id is needed before
 *     channels/posts queries will work.
 *   - channels(input: {organizationId}) { id name service }
 *   - posts(first, input: {organizationId, filter: {status, channelIds}})
 *     -- the "view queue" read.
 *   - createPost(input: {text, channelId, schedulingType, mode, dueAt}) --
 *     mode: "addToQueue" (next open queue slot) or "customScheduled"
 *     (exact dueAt). Returns a PostActionSuccess|MutationError union.
 */

const https = require('https');

function defaultRequest(apiKey) {
  return (query, variables) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request({
      hostname: 'api.buffer.com',
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function createBufferClient(opts) {
  const { getApiKey, auditLog = { log: () => {} }, requestImpl } = opts;
  if (!getApiKey) throw new Error('createBufferClient requires getApiKey');

  async function bufferGraphQL(query, variables) {
    const apiKey = getApiKey();
    if (!apiKey) return { ok: false, error: 'BUFFER_API_KEY_SCONL not configured' };
    const request = requestImpl || defaultRequest(apiKey);
    const res = await request(query, variables);
    auditLog.log('buffer_graphql', { status: res.status, hasErrors: !!(res.data && res.data.errors) });
    if (res.status !== 200) return { ok: false, error: `Buffer returned status ${res.status}` };
    if (res.data && res.data.errors && res.data.errors.length) {
      return { ok: false, error: res.data.errors.map(e => e.message).join('; ') };
    }
    return { ok: true, data: res.data && res.data.data };
  }

  async function getOrganizations() {
    const r = await bufferGraphQL('query GetOrganizations { account { organizations { id name } } }');
    if (!r.ok) return r;
    return { ok: true, organizations: (r.data.account && r.data.account.organizations) || [] };
  }

  async function listChannels(organizationId) {
    if (!organizationId) return { ok: false, error: 'organizationId required' };
    const r = await bufferGraphQL(
      'query GetChannels($organizationId: String!) { channels(input: { organizationId: $organizationId }) { id name service } }',
      { organizationId },
    );
    if (!r.ok) return r;
    return { ok: true, channels: r.data.channels || [] };
  }

  /** "View queue" -- status defaults to scheduled (not yet sent), the
   *  normal meaning of "queue" for this row's scaffolding. */
  async function listQueue({ organizationId, channelIds, status = 'scheduled' }) {
    if (!organizationId) return { ok: false, error: 'organizationId required' };
    if (!Array.isArray(channelIds) || !channelIds.length) return { ok: false, error: 'channelIds required' };
    const r = await bufferGraphQL(
      `query GetPosts($organizationId: String!, $channelIds: [String!]!, $status: [PostStatus!]) {
        posts(first: 20, input: { organizationId: $organizationId, filter: { status: $status, channelIds: $channelIds } }) {
          edges { node { id text dueAt channelId } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { organizationId, channelIds, status: [status] },
    );
    if (!r.ok) return r;
    const posts = (r.data.posts && r.data.posts.edges || []).map(e => e.node);
    return { ok: true, posts, pageInfo: r.data.posts && r.data.posts.pageInfo };
  }

  /** Schedules already-authored text -- never generates or edits content.
   *  mode: 'addToQueue' (next open slot, dueAt ignored) or
   *  'customScheduled' (exact dueAt, ISO 8601 UTC, required). */
  async function schedulePost({ channelId, text, dueAt, mode = 'addToQueue' }) {
    if (!channelId) return { ok: false, error: 'channelId required' };
    if (!String(text || '').trim()) return { ok: false, error: 'text required -- this scaffolding schedules already-authored content, it does not write it' };
    if (mode === 'customScheduled' && !dueAt) return { ok: false, error: 'dueAt required for mode:customScheduled' };
    const r = await bufferGraphQL(
      `mutation CreateScheduledPost($input: CreatePostInput!) {
        createPost(input: $input) {
          ... on PostActionSuccess { post { id text dueAt } }
          ... on MutationError { message }
        }
      }`,
      { input: { text, channelId, schedulingType: 'automatic', mode, ...(dueAt ? { dueAt } : {}) } },
    );
    if (!r.ok) return r;
    const result = r.data.createPost;
    if (result && result.message) { auditLog.log('buffer_schedule_failed', { channelId, message: result.message }); return { ok: false, error: result.message }; }
    auditLog.log('buffer_post_scheduled', { channelId, postId: result && result.post && result.post.id, mode });
    return { ok: true, post: result && result.post };
  }

  return { getOrganizations, listChannels, listQueue, schedulePost, bufferGraphQL };
}

module.exports = { createBufferClient };

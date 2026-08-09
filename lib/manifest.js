'use strict';
/**
 * scope's capability manifest -- same lightweight MCP-tool-list stand-in as
 * vault's and pulse's manifests (Decision 003).
 */
module.exports = {
  engine: 'scope',
  version: require('../package.json').version,
  description: 'Tasks, the Jira Gate, documents/deliverables, and the decision log.',
  capabilities: [
    { name: 'tasks.list', method: 'GET', path: '/tasks', description: 'List every task.' },
    { name: 'tasks.get', method: 'GET', path: '/tasks/:id', description: 'One task.' },
    { name: 'tasks.create', method: 'POST', path: '/tasks', description: 'Create a task, optionally syncing to Jira.' },
    { name: 'tasks.update', method: 'POST', path: '/tasks/update', description: 'Edit title/priority/status/due date/tag/assignee, mirrored to Jira when linked.' },
    { name: 'tasks.delete', method: 'POST', path: '/tasks/delete', description: 'Delete a task, deleting its linked Jira issue first (verified).' },
    { name: 'tasks.complete', method: 'POST', path: '/tasks/done', description: "Mark done or in-review, syncing the Jira transition." },

    { name: 'jira.preview', method: 'POST', path: '/jira/preview', description: 'The exact issue that would be created, plus a readiness checklist. Writes nothing.' },
    { name: 'jira.push', method: 'POST', path: '/jira/push', description: 'Create the reviewed issue on the board (blocked unless ready, or force:true).' },

    { name: 'decisions.list', method: 'GET', path: '/decisions', description: 'The org decision log with citing tasks, staleness, and the risk register.' },
    { name: 'decisions.update', method: 'POST', path: '/decisions/update', description: 'Update or append one decision block.' },
  ],
  // Deliverables/documents (lib/deliverables.js, lib/docs.js) are ported but
  // not yet wired to HTTP routes -- they need graphRequest/career/drafts
  // cross-engine wiring that hasn't been designed yet. See the canvas.
};

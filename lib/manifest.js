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
    { name: 'tasks.update', method: 'POST', path: '/tasks/update', description: 'Edit title/priority/status/due date/tag/assignee/deliverable, mirrored to Jira when linked (deliverable is local-only, never mirrored).' },
    { name: 'tasks.delete', method: 'POST', path: '/tasks/delete', description: 'Delete a task, deleting its linked Jira issue first (verified).' },
    { name: 'tasks.complete', method: 'POST', path: '/tasks/done', description: "Mark done or in-review, syncing the Jira transition." },

    { name: 'jira.preview', method: 'POST', path: '/jira/preview', description: 'The exact issue that would be created, plus a readiness checklist. Writes nothing.' },
    { name: 'jira.push', method: 'POST', path: '/jira/push', description: 'Create the reviewed issue on the board (blocked unless ready, or force:true).' },

    { name: 'decisions.list', method: 'GET', path: '/decisions', description: 'The org decision log with citing tasks, staleness, and the risk register.' },
    { name: 'decisions.update', method: 'POST', path: '/decisions/update', description: 'Update or append one decision block.' },
    { name: 'plans.list', method: 'GET', path: '/plans', description: 'The long-game goal board (scope/plans.tsv) -- goals across sprint/cycle/quarter/year+ horizons.' },
    { name: 'plans.add', method: 'POST', path: '/plans/add', description: 'Add a new goal to the plans board.' },
    { name: 'plans.update', method: 'POST', path: '/plans/update', description: 'Update a plan\'s status and/or note.' },

    { name: 'corporate.overview', method: 'GET', path: '/corporate', description: 'Every known engagement (career/_active.yaml orgs registry), with live stats for the active one.' },
    { name: 'corporate.detail', method: 'GET', path: '/corporate/detail', description: 'One engagement in full -- org facts, people, decisions, risks, playbooks, doctrine, task stats.' },

    { name: 'generate.archetypes', method: 'GET', path: '/generate/archetypes', description: 'List document archetypes available to a namespace (engagement id, or "_common"), each with its form field schema.' },
    { name: 'generate.preview', method: 'POST', path: '/generate/preview', description: 'Build {namespace, archetypeId, content} into markdown without writing anything -- for a live preview pane.' },
    { name: 'generate.generate', method: 'POST', path: '/generate', description: 'Build and render {namespace, archetypeId, content, formats:[docx|md|pdf]} to base64 files; write:true+outputRoot also writes to disk.' },
  ],
};

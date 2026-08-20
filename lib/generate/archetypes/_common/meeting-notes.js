'use strict';
/** meeting-notes - BA26081815's "and more" allowance: attendees/agenda/
 *  decisions/action-items is an obvious everyday-document gap the row's
 *  named 4 didn't cover. */

const { heading, bullets, kvList, table, document } = require('../../node-tree');

const REQUIRED = ['meeting_title', 'date', 'attendees', 'decisions'];

function validate(content) {
  const errors = REQUIRED.filter(f => content[f] === undefined || content[f] === null || content[f] === '' || (Array.isArray(content[f]) && !content[f].length))
    .map(f => `missing required field: ${f}`);
  return { valid: errors.length === 0, errors };
}

function build(content) {
  const { valid, errors } = validate(content);
  if (!valid) throw new Error(`meeting-notes: ${errors.join('; ')}`);

  const sections = [
    kvList([['Attendees.', content.attendees.join(', ')]]),
  ];
  if ((content.agenda || []).length) sections.push(heading(2, 'Agenda'), bullets(content.agenda));
  sections.push(heading(2, 'Decisions'), bullets(content.decisions));
  if ((content.action_items || []).length) {
    sections.push(heading(2, 'Action Items'),
      table(['Action', 'Owner'], content.action_items.map(a => [a.action || a.option || '', a.owner || a.detail || ''])));
  }
  if (content.next_meeting) sections.push(heading(2, 'Next Meeting'), kvList([['When.', content.next_meeting]]));

  return document({ headline: content.meeting_title, metaLine: content.date, sections, footerNote: null });
}

const FIELDS = [
  { name: 'meeting_title', label: 'Meeting title', type: 'text', required: true },
  { name: 'date', label: 'Date', type: 'text', required: true },
  { name: 'attendees', label: 'Attendees (one per line)', type: 'list', required: true },
  { name: 'agenda', label: 'Agenda (one per line)', type: 'list' },
  { name: 'decisions', label: 'Decisions (one per line)', type: 'list', required: true },
  { name: 'action_items', label: 'Action items (action | owner, one per line)', type: 'reasoned-list', keys: ['action', 'owner'] },
  { name: 'next_meeting', label: 'Next meeting', type: 'text' },
];

module.exports = {
  id: 'meeting-notes',
  title: 'Meeting Notes',
  governance: false,
  filenameFields: { primary: 'meeting_title', secondary: 'date' },
  fields: FIELDS,
  validate,
  build,
};

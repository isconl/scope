'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { build } = require('../lib/generate/doc-builder');
const { renderMarkdown } = require('../lib/generate/render-markdown');

// Content transcribed from the two Alex-approved sample documents
// (wamca_..._v1_4_0_20260813.docx = master, apma_..._v1_2_0_20260813.docx
// = sister) - the proof case document-generation-build-plan.md Phase 2
// asks for: build both, confirm the sister-site render has zero literal
// [sector-specific]/{sector_label} tokens left in it (the exact bug
// present in the real APMA sample).

const SHARED = {
  page_name: 'Member Services',
  date_readable: 'Thursday 13 August 2026',
  menu_subpage: 'Members / Member Services, at /members/member-services/',
  sections_used: ['2.4 value created', '2.5 role in the ecosystem', '2.6 what we are not',
    '4.1 activity areas', '4.2 described services', '5.2 role of the associations', '5.6 what WAMCA supports'],
  must_not_say: [
    { claim: 'That members hold proven quality systems or standards.', reason: 'Section 9.4 records no certification framework of any kind.' },
    { claim: 'Reliable delivery, or any performance claim about members.', reason: 'Section 10.2.' },
    { claim: 'We successfully delivered 91% of our projects, and the 4.7 rating.', reason: 'Both invented, and an association delivers no projects. Sections 4.4 and 10.2.' },
  ],
};

const WAMCA = {
  ...SHARED,
  site_name: 'WAMCA', url: 'wamcaglobal.org', version: '1.4.0', site_role: 'master',
  site_description: 'WAMCA, wamcaglobal.org',
  focus_paragraphs: [
    'People arrive here because they want to find a manufacturer through us. The page has to say how that actually happens and who does what. It is not a catalogue of what our members sell.',
    'Against its neighbours. Member Overview says who our members are. Member Directory is the searchable list itself. This page is the way in, and it should be the only one of the three that explains the route.',
  ],
  can_say: [
    'A company coming to WAMCA does not need to know which of the nine associations it belongs to. We route the request to the right one.',
    'Partner search runs through the sector association, so an enquiry reaches companies working in the same field rather than a general business list.',
    'Every association offers the same set: networking, partner search, marketing, representation, market information, export support, contact creation, insurance and financial products, and selective advisor access.',
    'The sector associations do the work. WAMCA coordinates them and does not deliver sector services itself.',
    'Advisor access is selective and governed. It is not an open introduction service.',
  ],
};

const APMA = {
  ...SHARED,
  site_name: 'APMA', url: 'apma-association.org', version: '1.2.0', site_role: 'sister',
  sector_label: 'agricultural products manufacturing',
  site_description: 'APMA, Agricultural Products Manufacturers Association, apma-association.org',
  focus_paragraphs: [
    'People arrive here because they want to find a {sector_label} manufacturer through us. The page has to say how that actually happens and who does what. It is not a catalogue of what our members sell.',
    'Against its neighbours. Member Overview says who our members are. Member Directory is the searchable list itself. This page is the way in, and it should be the only one of the three that explains the route.',
  ],
  can_say: [
    'A company coming to APMA reaches {sector_label} manufacturers directly. The association covers {sector_label} itself rather than routing the request onward.',
    'Partner search runs through the association, so an enquiry reaches companies working in {sector_label} rather than a general business list.',
    'Every association offers the same set: networking, partner search, marketing, representation, market information, export support, contact creation, insurance and financial products, and selective advisor access.',
    'APMA delivers these services for {sector_label}. WAMCA coordinates across the nine associations and does not deliver sector services itself.',
    'Advisor access is selective and governed. It is not an open introduction service.',
  ],
};

test('page-truth-brief builds the master (WAMCA) site with no sector placeholder', () => {
  const { tree } = build('viva-valentia', 'page-truth-brief', WAMCA);
  const md = renderMarkdown(tree);
  assert.match(md, /^# WAMCA — Member Services/);
  assert.doesNotMatch(md, /\{sector_label\}|\[sector-specific\]/);
});

test('page-truth-brief builds the sister (APMA) site with the token fully resolved', () => {
  const { tree } = build('viva-valentia', 'page-truth-brief', APMA);
  const md = renderMarkdown(tree);
  assert.match(md, /^# APMA — Member Services/);
  // The exact bug present in the real dropped sample: this must NEVER appear.
  assert.doesNotMatch(md, /\{sector_label\}|\[sector-specific\]/);
  assert.match(md, /agricultural products manufacturing/);
  assert.ok(md.includes('reaches agricultural products manufacturing manufacturers directly'));
});

test('page-truth-brief refuses to build a sister site missing sector_label', () => {
  const bad = { ...APMA, sector_label: undefined };
  assert.throws(() => build('viva-valentia', 'page-truth-brief', bad), /sector_label is missing/);
});

test('page-truth-brief refuses to build with a required field missing', () => {
  const bad = { ...WAMCA, focus_paragraphs: undefined };
  assert.throws(() => build('viva-valentia', 'page-truth-brief', bad), /missing required field: focus_paragraphs/);
});

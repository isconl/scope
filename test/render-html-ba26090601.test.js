'use strict';
/**
 * BA26090601 - proves the HTML renderer round-trips a node tree the same
 * way the docx/markdown/pdf renderers already do (see test/generate.test.js
 * for that established pattern), plus its one structural difference:
 * expandable bullets carrying a per-item `detail`.
 *
 * No code archetype for `weekly-status-brief` exists in this repo yet
 * (see document-generation-canon.md §3.2's note, added alongside this
 * row) so this test builds the node tree directly with node-tree.js's
 * helpers, shaped like that archetype's spec (signal/substance/trajectory
 * + the two new open_questions/suggestions_ideas sections) rather than
 * going through doc-builder.js's registry lookup.
 *
 * No hardcoded identity anywhere in this fixture, per the row's own
 * standing rule - placeholder subject/recipient values only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');
const { document, heading, kvList, bullets, checkedBullets } = require('../lib/generate/node-tree');
const { renderHtml } = require('../lib/generate/render-html');
const { renderPdf } = require('../lib/generate/render-pdf');
const { renderDocx } = require('../lib/generate/render-docx');
const { renderMarkdown } = require('../lib/generate/render-markdown');

function weeklyStatusBriefTree() {
  return document({
    headline: 'sub-0001 — Week of 5 Sep 2026',
    metaLine: 'project | sub-0001 | 5 Sep 2026 | v1.0.0 | Sample Recipient',
    sections: [
      kvList([
        ['Status', 'green'],
        ['One-line summary', 'On track, no blockers this week.'],
        ['Headline metric', '12/14 tasks closed'],
      ]),
      heading(1, 'THIS WEEK'),
      bullets(['Shipped the render-html renderer.', 'Reviewed the fourth-output plan with the team.']),
      bullets(
        ['Decided to keep PDF on its direct pdfkit path rather than route through HTML.'],
      ),
      checkedBullets([
        { text: 'Render output not yet load-tested at scale.', reason: 'no perf pass run yet' },
      ]),
      heading(1, 'NEXT'),
      kvList([
        ['Next actions', 'Wire the archetype build() once it exists.'],
        ['Asks of Sconl', 'None this week.'],
        ['Next brief date', '12 Sep 2026'],
      ]),
      // NEW, BA26090601 -- the two sections this row adds to the archetype.
      heading(1, 'OPEN QUESTIONS'),
      // Second bullet carries a `detail` -- proves the expandable-bullet
      // mechanism: collapsed one-liner in every format, but only HTML
      // exposes the longer explanation via <details>/<summary>.
      bullets(
        ['Should the html output also get pushed to OneDrive at milestone, same as docx?'],
        [null],
      ),
      bullets(
        ['Is the two-week webhook-token expiry (BM26090602) the right window, or should it match each subject\'s own cadence?'],
        ['Longer context: a shorter expiry (1 week) matches the weekly cadence exactly and closes the link faster after a subject goes quiet, ' +
         'but a recipient who is slow to respond (travel, a busy week) could find their own reply link already dead. Worth deciding once ' +
         'BM26090602 is actually being built, not guessed at here -- flagging so it is not silently decided.'],
      ),
      heading(1, 'SUGGESTIONS & IDEAS'),
      bullets(['Consider a dark-mode toggle on the hosted HTML page once BM26090602 ships the public link.']),
    ],
    footerNote: 'Distribution: sub-0001 project channel only. Confidential.',
  });
}

test('render-html: produces a well-formed, self-contained HTML document', () => {
  const tree = weeklyStatusBriefTree();
  const html = renderHtml(tree);

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>sub-0001 — Week of 5 Sep 2026<\/title>/);
  assert.match(html, /<h1>sub-0001 — Week of 5 Sep 2026<\/h1>/);
  assert.match(html, /OPEN QUESTIONS/);
  assert.match(html, /SUGGESTIONS &amp; IDEAS/);
  // No external network/asset dependency -- no <link>, no remote <script src>.
  assert.doesNotMatch(html, /<link[^>]+href=["']https?:/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.match(html, /<style>/);

  // No hardcoded identity -- only the placeholder subject/recipient values.
  assert.doesNotMatch(html, /Sconl Peter/);
});

test('render-html: a bullet with a `detail` renders expandable, one without does not', () => {
  const tree = weeklyStatusBriefTree();
  const html = renderHtml(tree);

  // The plain open-question bullet (detail: null) is a bare <li>, no <details>.
  assert.match(html, /<li>Should the html output also get pushed to OneDrive at milestone, same as docx\?<\/li>/);

  // The one with a real detail is wrapped in <details><summary>...
  assert.match(html, /<details><summary>Is the two-week webhook-token expiry/);
  assert.match(html, /<div class="bullet-detail">Longer context: a shorter expiry/);
});

test('render-html: same node tree still renders correctly on markdown/docx/pdf (fourth output, not a replacement)', () => {
  const tree = weeklyStatusBriefTree();
  const md = renderMarkdown(tree);
  assert.match(md, /^# sub-0001/);
  assert.match(md, /OPEN QUESTIONS/);
  // markdown has no concept of expandable bullets -- the detail text
  // never leaks into any of the other three renderers.
  assert.doesNotMatch(md, /Longer context: a shorter expiry/);

  return Promise.all([renderDocx(tree), renderPdf(tree)]).then(([docxBuf, pdfBuf]) => {
    assert.ok(Buffer.isBuffer(docxBuf) && docxBuf.length > 0);
    assert.ok(Buffer.isBuffer(pdfBuf) && pdfBuf.length > 0);
  });
});

test('render-html: writes a sample file for manual inspection', () => {
  const tree = weeklyStatusBriefTree();
  const html = renderHtml(tree);
  const out = path.join(os.tmpdir(), 'ba26090601-sample-weekly-status-brief.html');
  fs.writeFileSync(out, html);
  assert.ok(fs.existsSync(out));
});

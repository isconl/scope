'use strict';
/**
 * HTML renderer - fourth, independent output alongside docx/markdown/pdf
 * (`render-docx.js`/`render-markdown.js`/`render-pdf.js`), built directly
 * from the same node tree + `style.js` spec per canon §7's "one content
 * tree, N outputs, zero AI calls" pattern. Deliberately NOT a step PDF or
 * docx route through, and does not touch those three files at all -
 * BA26090601's own stated reason: canon §7 already explains PDF renders
 * directly with pdfkit specifically to avoid needing a real browser/
 * LibreOffice install, so piping anything through HTML+headless-Chromium
 * would reintroduce exactly the fragility that was designed out.
 *
 * Structural difference unique to this renderer, per BA26090601: each
 * bullet is individually expandable via a plain `<details>/<summary>`
 * element (no JS framework) - collapsed by default showing the same
 * terse one-line summary docx/pdf show, expandable to reveal an optional
 * per-bullet `detail` (node-tree.js's `bullets(items, details)` second
 * argument) that never appears in the docx/pdf render at all. A bullet
 * with no detail renders as a plain `<li>` - no dead expand affordance.
 *
 * Output is one self-contained .html file - inline <style> only, zero
 * external asset/network dependencies (no CDN fonts, no external CSS/JS).
 */

const { style } = require('./style');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Same lead-in-**bold** convention render-docx.js's parseBoldSegments()
// already established for bullet text - reused here so **bold** phrases
// in bullet/paragraph text render consistently across every format
// rather than showing literal asterisks in HTML.
function inlineMarkup(text) {
  return esc(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderBulletItems(node) {
  const details = node.details || [];
  return node.items.map((item, i) => {
    const detail = details[i];
    if (!detail) return `<li>${inlineMarkup(item)}</li>`;
    return `<li><details><summary>${inlineMarkup(item)}</summary><div class="bullet-detail">${inlineMarkup(detail)}</div></details></li>`;
  }).join('\n');
}

function renderNode(node) {
  switch (node.type) {
    case 'heading':
      return `<h2>${esc(node.text)}</h2>`;
    case 'paragraph':
      return `<p>${inlineMarkup(node.text)}</p>`;
    case 'bullets':
      return `<ul class="bullets">\n${renderBulletItems(node)}\n</ul>`;
    case 'checked_bullets':
      return `<ul class="bullets checked">\n${node.items.map(i =>
        `<li>${inlineMarkup(i.text)}${i.reason ? ` <span class="reason">(${esc(i.reason)})</span>` : ''}</li>`).join('\n')}\n</ul>`;
    case 'kv_list':
      return `<dl class="kv">\n${node.items.map(i =>
        `<div class="kv-row"><dt>${esc(i.label)}</dt><dd>${inlineMarkup(i.value)}</dd></div>`).join('\n')}\n</dl>`;
    case 'truth_check': {
      const parts = [`<p>Sections used: ${esc(node.sectionsUsed.join(', '))}</p>`];
      if (node.mustNotSay.length) {
        parts.push('<p><strong>What we must not say:</strong></p>');
        parts.push(`<ul class="bullets">\n${node.mustNotSay.map(m =>
          `<li>${inlineMarkup(m.claim)}${m.reason ? ` <span class="reason">(${esc(m.reason)})</span>` : ''}</li>`).join('\n')}\n</ul>`);
      }
      return parts.join('\n');
    }
    case 'table':
      return `<table>\n<thead><tr>${node.header.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>\n` +
        `<tbody>${node.rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('\n')}</tbody>\n</table>`;
    default:
      return '';
  }
}

function css() {
  // Same token table docx/pdf read (style.js) - twips -> px at 96dpi/1440
  // twips-per-inch for margins, half-points-equivalent sizing for fonts
  // (docx/pdf both size in points; a browser default is ~96dpi so pt->px
  // is close enough at *4/3, kept simple rather than pixel-perfect since
  // HTML is a different medium, not a pixel clone of the printed page).
  const pt2px = (pt) => Math.round(pt * 4 / 3);
  const marginPx = (twips) => Math.round(twips / 1440 * 96);
  return `
    :root { color-scheme: light; }
    body {
      margin: 0; background: #f4f6fa;
      font-family: '${style.font.family}', Calibri, 'Segoe UI', Arial, sans-serif;
      color: #000; font-size: ${pt2px(style.body.size)}px; line-height: ${style.spacing.bodyLine};
    }
    .page {
      max-width: 900px; margin: 24px auto; background: #fff;
      padding: ${marginPx(style.page.marginTopTwips)}px ${marginPx(style.page.marginRightTwips)}px
               ${marginPx(style.page.marginBottomTwips)}px ${marginPx(style.page.marginLeftTwips)}px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.12);
    }
    h1 {
      font-size: ${pt2px(style.h1.size + 5)}px; color: #${style.h1.color}; font-weight: 700;
      margin: 0 0 4px 0;
    }
    .meta-line {
      font-size: ${pt2px(style.meta.size + 2)}px; color: #${style.meta.color}; margin: 0 0 18px 0;
    }
    h2 {
      font-size: ${pt2px(style.h2.size + 3)}px; color: #${style.h2.color}; font-weight: 700;
      border-bottom: 1px solid #${style.h2.borderColor};
      padding-bottom: 4px; margin: ${marginPx(style.spacing.h2BeforeTwips)}px 0 ${marginPx(style.spacing.h2AfterTwips)}px 0;
    }
    p { margin: 0 0 ${marginPx(style.spacing.bodyAfterTwips)}px 0; }
    ul.bullets { margin: 0 0 10px 0; padding-left: 22px; }
    ul.bullets li { margin: 0 0 6px 0; }
    ul.bullets .reason { color: #${style.meta.color}; font-size: ${pt2px(style.meta.size + 1)}px; }
    dl.kv { margin: 0 0 10px 0; }
    .kv-row { margin: 0 0 6px 0; }
    .kv-row dt { display: inline; font-weight: 700; margin: 0; }
    .kv-row dt::after { content: '  '; }
    .kv-row dd { display: inline; margin: 0; }
    table { border-collapse: collapse; width: 100%; margin: 0 0 12px 0; }
    th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; font-size: ${pt2px(style.body.size)}px; }
    th { background: #f0f2f8; }
    .footer-note {
      margin-top: 24px; padding-top: 10px; border-top: 1px solid #ddd;
      font-size: ${pt2px(style.meta.size + 2)}px; color: #${style.meta.color};
    }
    /* Expandable bullets - the one structural feature unique to this
       renderer (BA26090601): plain semantic <details>/<summary>, no JS. */
    details { margin: 0 0 6px 0; }
    details > summary {
      cursor: pointer; list-style: none;
    }
    details > summary::-webkit-details-marker { display: none; }
    details > summary::before {
      content: '▸  '; color: #${style.h2.color}; font-size: 0.85em;
    }
    details[open] > summary::before { content: '▾  '; }
    .bullet-detail {
      margin: 4px 0 0 18px; padding: 6px 10px;
      background: #f7f8fc; border-left: 2px solid #${style.h2.borderColor};
      font-size: ${pt2px(style.body.size)}px; color: #333;
    }
  `.trim();
}

/** docTree -> a self-contained HTML string (no external asset/network
 *  dependency - inline <style> only). Same node-tree/style.js input as
 *  the docx/markdown/pdf renderers; see the file header for the one
 *  structural difference (expandable bullets). */
function renderHtml(docTree) {
  const body = [
    '<div class="page">',
    `<h1>${esc(docTree.headline)}</h1>`,
    docTree.metaLine ? `<p class="meta-line">${esc(docTree.metaLine)}</p>` : '',
    ...docTree.sections.map(renderNode),
    docTree.footerNote ? `<p class="footer-note">${inlineMarkup(docTree.footerNote)}</p>` : '',
    '</div>',
  ].filter(Boolean).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(docTree.headline)}</title>
<style>
${css()}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

module.exports = { renderHtml };

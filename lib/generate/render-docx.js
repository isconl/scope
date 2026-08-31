'use strict';
/**
 * docx renderer - builds a .docx PROGRAMMATICALLY with the `docx` library,
 * never by templating text into an existing Word file (canon §7). That
 * distinction is the actual fix for the bug already present in the real
 * APMA sample: Word silently splits a sentence across multiple <w:r> runs,
 * and a text-replace against raw XML can miss or corrupt a token sitting
 * across that split. Building fresh from the node tree + style.js sidesteps
 * the failure class entirely - there is no existing XML to corrupt.
 */

const { Document, Packer, Paragraph, TextRun, HeadingLevel, BorderStyle,
  AlignmentType, Table, TableRow, TableCell, WidthType } = require('docx');
const { style } = require('./style');

const half = (pt) => Math.round(pt * 2); // docx sizes are in half-points

function bodyRun(text) {
  return new TextRun({ text, font: style.font.family, size: half(style.body.size) });
}
function bodyPara(text, opts = {}) {
  return new Paragraph({ children: [bodyRun(text)], spacing: { after: style.spacing.bodyAfterTwips }, ...opts });
}

function h2Para(text) {
  return new Paragraph({
    children: [new TextRun({ text, font: style.font.family, size: half(style.h2.size), bold: true, color: style.h2.color })],
    spacing: { before: style.spacing.h2BeforeTwips, after: style.spacing.h2AfterTwips },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, space: 0, color: style.h2.borderColor } },
  });
}

// Splits "lead-in **bold** phrase" into TextRun segments so a bullet can
// mix bold and plain text in one paragraph, same lead-in-bold shape as the
// kv_list label pattern above (line ~49) rather than a new convention.
function parseBoldSegments(text) {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map(part => {
    const m = part.match(/^\*\*([^*]+)\*\*$/);
    return m ? { text: m[1], bold: true } : { text: part, bold: false };
  });
}

function bulletPara(text, opts = {}) {
  const children = parseBoldSegments(text).map(seg => new TextRun({
    text: seg.text, font: style.font.family, size: half(style.body.size), bold: seg.bold,
  }));
  return new Paragraph({ children, spacing: { after: style.spacing.bodyAfterTwips }, ...opts });
}

function metaPara(text) {
  return new Paragraph({
    children: [new TextRun({ text, font: style.font.family, size: half(style.meta.size), color: style.meta.color })],
    spacing: { after: style.spacing.bodyAfterTwips },
  });
}

function renderNodeToParas(node) {
  switch (node.type) {
    case 'heading': return [h2Para(node.text)];
    case 'paragraph': return [bodyPara(node.text)];
    case 'bullets': return node.items.map(i => bulletPara(i, { bullet: { level: 0 } }));
    case 'checked_bullets': return node.items.map(i =>
      bodyPara(i.reason ? `${i.text} (${i.reason})` : i.text, { bullet: { level: 0 } }));
    case 'kv_list': return node.items.map(i => new Paragraph({
      children: [
        new TextRun({ text: `${i.label}  `, font: style.font.family, size: half(style.body.size), bold: true }),
        bodyRun(i.value),
      ],
      spacing: { after: style.spacing.bodyAfterTwips },
    }));
    case 'truth_check': {
      const paras = [bodyPara(`Sections used: ${node.sectionsUsed.join(', ')}`)];
      if (node.mustNotSay.length) {
        paras.push(bodyPara('What we must not say:'));
        for (const m of node.mustNotSay) paras.push(bodyPara(`${m.claim}${m.reason ? ` (${m.reason})` : ''}`, { bullet: { level: 0 } }));
      }
      return paras;
    }
    case 'table': return [new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [node.header, ...node.rows].map((r, ri) => new TableRow({
        children: r.map(c => new TableCell({ children: [bodyPara(c)] })),
      })),
    })];
    default: return [];
  }
}

/** docTree -> a Buffer ready to write to a .docx file. */
async function renderDocx(docTree) {
  const children = [
    new Paragraph({
      children: [new TextRun({ text: docTree.headline, font: style.font.family, size: half(style.h1.size), bold: true, color: style.h1.color })],
      spacing: { after: 20 },
      heading: HeadingLevel.HEADING_1,
    }),
  ];
  if (docTree.metaLine) children.push(metaPara(docTree.metaLine));
  for (const node of docTree.sections) children.push(...renderNodeToParas(node));
  if (docTree.footerNote) children.push(metaPara(docTree.footerNote));

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          size: { width: style.page.widthTwips, height: style.page.heightTwips },
          margin: {
            top: style.page.marginTopTwips, bottom: style.page.marginBottomTwips,
            left: style.page.marginLeftTwips, right: style.page.marginRightTwips,
            header: style.page.headerTwips, footer: style.page.footerTwips,
          },
        },
      },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { renderDocx };

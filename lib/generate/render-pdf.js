'use strict';
/**
 * PDF renderer - built directly from the node tree with `pdfkit`, not by
 * converting the generated .docx (canon §7). This box has no reliable
 * LibreOffice/Word install to shell out to (Docker-less Windows machine,
 * per D:\CLAUDE.md §8), so PDF output must not depend on one - pdfkit is
 * pure JS with no native/system dependency.
 */

const PDFDocument = require('pdfkit');
const { style } = require('./style');

const mm = (twips) => twips / 20;   // twips -> points (pdfkit works in points, 20 twips = 1pt)

function hex(c) { return `#${c}`; }

function renderNode(doc, node) {
  doc.font('Helvetica');
  switch (node.type) {
    case 'heading':
      doc.moveDown(0.6).fontSize(style.h2.size + 3).fillColor(hex(style.h2.color)).font('Helvetica-Bold').text(node.text);
      doc.moveTo(doc.x, doc.y + 2).lineTo(doc.page.width - doc.page.margins.right, doc.y + 2).strokeColor(hex(style.h2.borderColor)).stroke();
      doc.moveDown(0.3);
      break;
    case 'paragraph':
      doc.fontSize(style.body.size + 2).fillColor('#000000').font('Helvetica').text(node.text, { align: 'left' }).moveDown(0.3);
      break;
    case 'bullets':
      doc.fontSize(style.body.size + 2).fillColor('#000000').font('Helvetica');
      for (const i of node.items) doc.text(`•  ${i}`, { indent: 10 }).moveDown(0.15);
      doc.moveDown(0.2);
      break;
    case 'checked_bullets':
      doc.fontSize(style.body.size + 2).fillColor('#000000').font('Helvetica');
      for (const i of node.items) doc.text(`•  ${i.text}${i.reason ? ` (${i.reason})` : ''}`, { indent: 10 }).moveDown(0.15);
      doc.moveDown(0.2);
      break;
    case 'kv_list':
      for (const i of node.items) {
        doc.fontSize(style.body.size + 2).fillColor('#000000')
          .font('Helvetica-Bold').text(`${i.label}  `, { continued: true })
          .font('Helvetica').text(i.value);
        doc.moveDown(0.2);
      }
      break;
    case 'truth_check':
      doc.fontSize(style.body.size + 2).fillColor('#000000').font('Helvetica')
        .text(`Sections used: ${node.sectionsUsed.join(', ')}`).moveDown(0.3);
      if (node.mustNotSay.length) {
        doc.font('Helvetica-Bold').text('What we must not say:').font('Helvetica');
        for (const m of node.mustNotSay) doc.text(`•  ${m.claim}${m.reason ? ` (${m.reason})` : ''}`, { indent: 10 }).moveDown(0.15);
      }
      doc.moveDown(0.2);
      break;
    case 'table':
      doc.fontSize(style.body.size + 2).fillColor('#000000').font('Helvetica-Bold').text(node.header.join('  |  ')).font('Helvetica');
      for (const r of node.rows) doc.text(r.join('  |  '));
      doc.moveDown(0.3);
      break;
  }
}

/** docTree -> a Buffer ready to write to a .pdf file. Resolves once
 *  pdfkit finishes streaming (it's a stream-based API, not a one-shot
 *  buffer builder, so this wraps that in a Promise). */
function renderPdf(docTree) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: style.page.size,
      margins: {
        top: mm(style.page.marginTopTwips), bottom: mm(style.page.marginBottomTwips),
        left: mm(style.page.marginLeftTwips), right: mm(style.page.marginRightTwips),
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(style.h1.size + 5).fillColor(hex(style.h1.color)).font('Helvetica-Bold').text(docTree.headline);
    if (docTree.metaLine) {
      doc.moveDown(0.2).fontSize(style.meta.size + 2).fillColor(hex(style.meta.color)).font('Helvetica').text(docTree.metaLine);
    }
    doc.moveDown(0.4);
    for (const node of docTree.sections) renderNode(doc, node);
    if (docTree.footerNote) {
      doc.moveDown(0.4).fontSize(style.meta.size + 2).fillColor(hex(style.meta.color)).font('Helvetica').text(docTree.footerNote);
    }
    doc.end();
  });
}

module.exports = { renderPdf };

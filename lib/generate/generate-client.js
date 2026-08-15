'use strict';
/**
 * The HTTP-facing aggregator for the document-generation engine: build a
 * node tree (doc-builder) then render it into whichever formats were
 * asked for. Buffers are always returned (base64) rather than assuming
 * the caller shares a filesystem with this engine - vault/lib/store.js's
 * own header comment already flagged that assumption as a real bug once
 * (engines don't share a host on Render). Writing to disk (career/.../
 * deliverables/) is opt-in on top of that, via `write`+`outputRoot`.
 */

const { build } = require('./doc-builder');
const { renderMarkdown } = require('./render-markdown');
const { renderDocx } = require('./render-docx');
const { renderPdf } = require('./render-pdf');
const { filename } = require('./naming');
const { writeOutputs } = require('./output');
const { listArchetypes } = require('./registry');

const RENDERERS = {
  md: async (tree) => Buffer.from(renderMarkdown(tree), 'utf8'),
  docx: (tree) => renderDocx(tree),
  pdf: (tree) => renderPdf(tree),
};

function createGenerateClient({ auditLog = { log: () => {} } } = {}) {
  /** {namespace, archetypeId, content, version, date, formats, write, outputRoot} */
  async function generate(p) {
    const namespace = String(p.namespace || '');
    const archetypeId = String(p.archetypeId || '');
    const content = p.content || {};
    const version = p.version || '0.1.0';
    const date = p.date || new Date().toISOString().slice(0, 10);
    const formats = (p.formats && p.formats.length ? p.formats : ['md']).filter(f => RENDERERS[f]);
    if (!formats.length) throw new Error('no valid formats requested (docx, md, pdf)');

    const { archetype, tree } = build(namespace, archetypeId, content);

    const buffers = {};
    for (const fmt of formats) buffers[fmt] = await RENDERERS[fmt](tree);

    const files = {};
    for (const fmt of formats) {
      files[fmt] = {
        filename: filename(archetype, content, { version, date, ext: fmt }),
        base64: buffers[fmt].toString('base64'),
        bytes: buffers[fmt].length,
      };
    }

    let written = null;
    if (p.write && p.outputRoot) {
      written = await writeOutputs({ outputRoot: p.outputRoot, archetype, content, version, date, buffers });
    }

    auditLog.log('document_generated', { namespace, archetypeId, formats, written: !!written });
    return { archetype: { id: archetype.id, title: archetype.title }, files, written };
  }

  async function preview(p) {
    const { tree } = build(String(p.namespace || ''), String(p.archetypeId || ''), p.content || {});
    return { markdown: renderMarkdown(tree) };
  }

  function archetypes(namespace) {
    return listArchetypes(String(namespace || '_common'));
  }

  return { generate, preview, archetypes };
}

module.exports = { createGenerateClient };

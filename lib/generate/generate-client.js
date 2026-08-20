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

function createGenerateClient({ auditLog = { log: () => {} }, docsRegistry = null, outputRoot = null } = {}) {
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

    // Always written to local disk now (BA26081811 needs a real file to
    // index) -- outputRoot is server-controlled (constructor option), never
    // client-supplied, same reasoning `p.write`/`p.outputRoot` never being
    // wired from the caller side used to leave this off entirely: a client
    // shouldn't get to dictate a server-side filesystem path. p.write/
    // p.outputRoot are kept as an override for tests/callers that want a
    // different root, but the default is now "always write."
    let written = null;
    let docId = null;
    let onedriveWebUrl = null;   // BA26081813 -- General targets only, see docs-registry.js's pushToOneDrive()
    const root = p.outputRoot || outputRoot;
    if (p.write !== false && root) {
      written = await writeOutputs({ outputRoot: root, archetype, content, version, date, buffers });
      if (written && docsRegistry) {
        const recorded = await docsRegistry.recordGenerated({
          archetypeId: archetype.id, targetKind: p.targetKind, targetId: p.targetId, targetLabel: p.targetLabel,
          written, version,
        }).catch(e => { auditLog.log('generated_docs_index_failed', { error: String(e.message || e) }); return null; });
        if (recorded) { docId = recorded.id; onedriveWebUrl = recorded.webUrl; }
      }
    }

    auditLog.log('document_generated', { namespace, archetypeId, formats, written: !!written, docId, onedriveWebUrl: !!onedriveWebUrl });
    return { archetype: { id: archetype.id, title: archetype.title }, files, written, docId, onedriveWebUrl };
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

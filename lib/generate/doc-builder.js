'use strict';
/**
 * doc-builder: archetype + content -> a document node tree. The one place
 * that merges "what shape does this document type have" (the archetype)
 * with "what does THIS document actually say" (content), per
 * document-generation-canon.md §1. No AI call anywhere in this path -
 * that's the whole design.
 */

const { getArchetype } = require('./registry');

/** namespace = engagement/project id ("viva-valentia") or "_common".
 *  archetypeId = e.g. "page-truth-brief". content = plain object matching
 *  that archetype's schema. Throws on invalid content - a document
 *  missing a required field fails loudly here, before any renderer runs,
 *  per canon §3 point 7. */
function build(namespace, archetypeId, content) {
  const archetype = getArchetype(namespace, archetypeId);
  const tree = archetype.build(content);
  return { archetype, tree };
}

module.exports = { build };

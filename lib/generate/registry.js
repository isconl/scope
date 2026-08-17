'use strict';
/**
 * The archetype registry - namespaced per engagement/project per canon
 * §1/§3, never a flat global list. `_common/` holds archetypes genuinely
 * reusable across engagements (the resume archetype lives there); a named
 * folder holds archetypes scoped to that one engagement.
 *
 * Deliberately a plain require-time scan, not a database - archetypes are
 * code (each one is a validator + a build() function), so "what
 * archetypes exist" is answered by what files are on disk, same
 * philosophy as scope's capability manifest pattern.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'archetypes');

function scan() {
  const byNamespace = {};
  if (!fs.existsSync(ROOT)) return byNamespace;
  for (const ns of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!ns.isDirectory()) continue;
    const nsDir = path.join(ROOT, ns.name);
    byNamespace[ns.name] = {};
    for (const f of fs.readdirSync(nsDir)) {
      if (!f.endsWith('.js')) continue;
      const mod = require(path.join(nsDir, f));
      if (mod && mod.id) byNamespace[ns.name][mod.id] = mod;
    }
  }
  return byNamespace;
}

let CACHE = null;

/** One archetype, looked up by namespace (engagement/project id, or
 *  "_common") + archetype id. Throws with a specific, actionable message
 *  rather than returning undefined - a caller building a document wants
 *  to know immediately if it asked for something that doesn't exist. */
function getArchetype(namespace, archetypeId) {
  if (!CACHE) CACHE = scan();
  const ns = CACHE[namespace];
  if (!ns) throw new Error(`no archetype namespace "${namespace}" - known namespaces: ${Object.keys(CACHE).join(', ') || '(none)'}`);
  const a = ns[archetypeId] || CACHE._common?.[archetypeId];
  if (!a) throw new Error(`no archetype "${archetypeId}" in namespace "${namespace}" or _common`);
  return a;
}

/** `fields`/`filenameFields` included so a UI (hub's Writer space) can
 *  render a content form and show which two values become the filename
 *  slots, without a second round-trip per archetype. */
function listArchetypes(namespace) {
  if (!CACHE) CACHE = scan();
  const ns = { ...(CACHE._common || {}), ...(CACHE[namespace] || {}) };
  return Object.values(ns).map(a => ({
    id: a.id, title: a.title, governance: !!a.governance,
    fields: a.fields || [], filenameFields: a.filenameFields || null,
  }));
}

/** Test-only: force a re-scan (archetype files rarely change at runtime,
 *  but a test suite adding a fixture archetype needs this). */
function _resetCache() { CACHE = null; }

module.exports = { getArchetype, listArchetypes, _resetCache };

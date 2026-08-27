'use strict';
/**
 * BA26082403: Writer binder-tree first slice -- lists episodes of "The
 * Decision Architect" LinkedIn series from the real OneDrive canon at
 * Sconl/Core/Axial/Innovator/Architect/architect-decision/Publication/
 * publication-content/, and compiles a selected episode's existing
 * Section 10.3 (CURATED, ~750w) into ready-to-paste LinkedIn-post text.
 *
 * Schema confirmed by reading the real canon documents (not guessed):
 * canvas filenames are `{date}_canon_episode_{n_n_n}_{status-slug}_v{ver}.md`;
 * a canvas is plain Markdown with one embedded ```yaml block under
 * "## 1. EPISODE OVERVIEW" (final_title, status, etc); Section "10.3
 * CURATED" is already the LinkedIn-ready form -- a bold title line plus
 * continuous prose, no further transformation needed for v1's "basic
 * compile" bar. Reuses BA26082401/BA26082402's existing OneDrive-via-vault
 * cross-engine pattern (this is NOT a standalone engine, per Architect's own
 * 24 Aug placement decision).
 */

const BINDER_PATH = 'Sconl/Core/Axial/Innovator/Architect/architect-decision/Publication/publication-content';

const FILENAME_RE = /^\d{8}_canon_episode_([\d_]+)_(.+)_v(\d+\.\d+\.\d+)\.md$/;

function episodeIdFromSlug(slug) {
  return slug.split('_').join('.');
}

/** Groups filenames by episode ID, keeping only the highest version per
 *  episode -- a canvas is revised in place (see 1.4.3's 4 versions),
 *  the binder shows the current state, not every draft. */
function groupLatestPerEpisode(items) {
  const byEpisode = new Map();
  for (const item of items) {
    const m = FILENAME_RE.exec(item.name || '');
    if (!m) continue;
    const episodeId = episodeIdFromSlug(m[1]);
    const version = m[3];
    const existing = byEpisode.get(episodeId);
    if (!existing || version > existing.version) {
      byEpisode.set(episodeId, { episodeId, version, itemId: item.id, name: item.name, lastModified: item.lastModifiedDateTime });
    }
  }
  return [...byEpisode.values()].sort((a, b) => a.episodeId.localeCompare(b.episodeId, undefined, { numeric: true }));
}

/** Section "10.3 CURATED" (or "10.3. CURATED", headings vary slightly) up
 *  to the next `##`/`###` heading -- confirmed this is already the
 *  LinkedIn-ready form, per the row's own "basic compile" v1 bar. */
function extractCuratedSection(markdown) {
  const m = markdown.match(/#{2,3}\s*10\.3[.\s]*CURATED[^\n]*\n([\s\S]*?)(?=\n#{2,3}\s|$)/i);
  return m ? m[1].trim() : null;
}

function extractYamlField(markdown, field) {
  const m = markdown.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

function createWriterBinderClient(opts) {
  const { callVault, auditLog = { log: () => {} } } = opts;
  if (!callVault) throw new Error('createWriterBinderClient requires callVault');

  async function listEpisodes() {
    const r = await callVault('GET', '/onedrive/browse', { path: BINDER_PATH });
    if (!r.ok) return { ok: false, error: r.error || 'could not list the binder folder' };
    const items = (r.data && r.data.items) || [];
    return { ok: true, episodes: groupLatestPerEpisode(items) };
  }

  async function compileEpisode(itemId) {
    if (!itemId) return { ok: false, error: 'itemId required' };
    const r = await callVault('GET', '/onedrive/item-preview', { id: itemId });
    if (!r.ok) return { ok: false, error: r.error || 'could not read the episode canvas' };
    const text = r.data && r.data.textContent;
    if (!text) return { ok: false, error: 'episode canvas has no readable text content' };
    const curated = extractCuratedSection(text);
    if (!curated) return { ok: false, error: 'no Section 10.3 (CURATED) found in this canvas -- may not be compiled yet' };
    auditLog.log('writer_binder_compiled', { itemId });
    return {
      ok: true,
      title: extractYamlField(text, 'final_title') || extractYamlField(text, 'provisional_title'),
      status: extractYamlField(text, 'status'),
      linkedinPost: curated,
    };
  }

  return { listEpisodes, compileEpisode };
}

module.exports = { createWriterBinderClient, groupLatestPerEpisode, extractCuratedSection, extractYamlField, BINDER_PATH };

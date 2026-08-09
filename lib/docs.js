'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Related documents - a task's paper trail, previewed in place
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A task like "Offer Alex a pre-filled approver block for the Truth Document" is
 * unactionable without the Truth Document open, and opening it means leaving the
 * app, finding the folder, and losing the thread. This finds the documents a task
 * is actually about and reads enough of them to be useful in place.
 *
 * .docx and .xlsx are ZIP archives, so their text comes out with nothing but the
 * `zlib` already in Node - no dependency, in a repo that carries exactly one.
 * Legacy binary .doc is a different format entirely and is NOT decoded here: it is
 * reported honestly as "no preview" rather than shown as the mojibake you get from
 * treating OLE2 as text. Where a .txt twin of the same document exists, that is
 * found and previewed instead, which covers the Truth Document in practice.
 *
 * Everything is read-only and path-confined to declared roots.
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_PREVIEW_CHARS = 4000;
const MAX_IMAGE_BYTES   = 900 * 1024;   // beyond this, link rather than inline

// ── MINIMAL ZIP ──────────────────────────────────────────────────────────────
// Enough of the format to pull one named entry out of an Office file. Reads the
// central directory rather than scanning for local headers, because only the
// central directory is authoritative about sizes.

function findEOCD(buf) {
  // Comment field can be up to 64k, so scan back from the end for the signature.
  const min = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** Raw bytes of one entry, or null. */
function zipEntry(buf, wanted) {
  const eocd = findEOCD(buf);
  if (eocd < 0) return null;

  const count  = buf.readUInt16LE(eocd + 10);
  let offset   = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) return null;
    const method   = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen  = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const cmtLen   = buf.readUInt16LE(offset + 32);
    const local    = buf.readUInt32LE(offset + 42);
    const name     = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    if (name === wanted) {
      if (buf.readUInt32LE(local) !== 0x04034b50) return null;
      // The local header repeats the name and extra fields, at its own lengths.
      const lNameLen  = buf.readUInt16LE(local + 26);
      const lExtraLen = buf.readUInt16LE(local + 28);
      const start = local + 30 + lNameLen + lExtraLen;
      const data  = buf.subarray(start, start + compSize);
      try {
        return method === 0 ? data : zlib.inflateRawSync(data);
      } catch { return null; }
    }
    offset += 46 + nameLen + extraLen + cmtLen;
  }
  return null;
}

/**
 * Every entry in an archive: name and true size, straight off the central
 * directory. A zip that previews as "no preview for this type" hides exactly
 * the question its reader has - what is IN it - when the answer is sitting in
 * 46 bytes per entry.
 */
function zipList(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let offset  = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) break;
    const size     = buf.readUInt32LE(offset + 24);
    const nameLen  = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const cmtLen   = buf.readUInt16LE(offset + 32);
    out.push({ name: buf.toString('utf8', offset + 46, offset + 46 + nameLen), size });
    offset += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

// ── TEXT EXTRACTION ──────────────────────────────────────────────────────────

function xmlToText(xml) {
  return String(xml)
    // Word paragraph and break boundaries are the only structure worth keeping.
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function previewDocx(fp) {
  const raw = zipEntry(fs.readFileSync(fp), 'word/document.xml');
  if (!raw) return { text: '', note: 'Could not read the document body' };
  const text = xmlToText(raw.toString('utf8'));
  return { text: text.slice(0, MAX_PREVIEW_CHARS), truncated: text.length > MAX_PREVIEW_CHARS,
           words: text.split(/\s+/).filter(Boolean).length };
}

function previewXlsx(fp) {
  const raw = zipEntry(fs.readFileSync(fp), 'xl/sharedStrings.xml');
  if (!raw) return { text: '', note: 'No shared strings - the sheet may hold only numbers or formulas' };
  const cells = [...raw.toString('utf8').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => m[1]);
  const text = cells.join(' · ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return { text: text.slice(0, MAX_PREVIEW_CHARS), truncated: text.length > MAX_PREVIEW_CHARS,
           cells: cells.length };
}

function previewPlain(fp) {
  // Files exported from Word carry a UTF-8 BOM, which renders as a stray "ï»¿" at
  // the head of the preview if it is not stripped.
  const text = fs.readFileSync(fp, 'utf8').replace(/^﻿/, '');
  return { text: text.slice(0, MAX_PREVIEW_CHARS), truncated: text.length > MAX_PREVIEW_CHARS,
           words: text.split(/\s+/).filter(Boolean).length };
}

const IMAGE_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                     '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

/**
 * One document, described as fully as its format allows and no further.
 * A format we cannot read says so; it never guesses.
 */
function describe(fp) {
  const ext  = path.extname(fp).toLowerCase();
  const st   = fs.statSync(fp);
  const base = {
    path: fp,
    name: path.basename(fp),
    ext,
    bytes: st.size,
    modified: st.mtime.toISOString().slice(0, 10),
    kind: 'file',
  };

  try {
    if (ext === '.docx') return { ...base, kind: 'doc',   preview: previewDocx(fp) };
    if (ext === '.xlsx') return { ...base, kind: 'sheet', preview: previewXlsx(fp) };
    if (/\.(txt|md|markdown|mdown|mkd|csv|tsv|yml|yaml|json|py|js|ts|jsx|tsx|html|css|sh|ps1|bat|xml|log|rst|ini|conf|toml|sql)$/i.test(ext)) {
      return { ...base, kind: 'text', preview: previewPlain(fp) };
    }
    if (IMAGE_MIME[ext]) {
      if (st.size <= MAX_IMAGE_BYTES) {
        return { ...base, kind: 'image',
                 dataUri: `data:${IMAGE_MIME[ext]};base64,${fs.readFileSync(fp).toString('base64')}` };
      }
      return { ...base, kind: 'image', note: 'Too large to inline' };
    }
    if (ext === '.doc') {
      return { ...base, kind: 'doc',
               note: 'Legacy Word binary - not readable here. Open it, or use the .txt copy if one exists.' };
    }
    if (ext === '.pdf') {
      return { ...base, kind: 'pdf', note: 'PDF - open to read.' };
    }
    if (ext === '.zip') {
      // The archive's own table of contents IS the preview.
      const entries = zipList(fs.readFileSync(fp));
      if (entries && entries.length) {
        const mb = (b) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
        const shown = entries.slice(0, 120);
        const text = `${entries.length} files inside:\n\n`
          + shown.map(e => `${mb(e.size).padStart(9)}  ${e.name}`).join('\n')
          + (entries.length > shown.length ? `\n… and ${entries.length - shown.length} more` : '');
        return { ...base, kind: 'archive',
                 preview: { text: text.slice(0, MAX_PREVIEW_CHARS), truncated: text.length > MAX_PREVIEW_CHARS,
                            entries: entries.length } };
      }
      return { ...base, kind: 'archive', note: 'Could not read the archive directory.' };
    }
    return { ...base, note: 'No preview for this type.' };
  } catch (e) {
    return { ...base, note: `Could not read: ${String(e.message || e).slice(0, 80)}` };
  }
}

// ── DISCOVERY ────────────────────────────────────────────────────────────────

const STOP = new Set(('the a an and or of for to in on with from is are be as at by that this it '
  + 'not but if then than so into over under about after before across our your their his her '
  + 'them they we i you he she who whom which what when where why how all any both each few more '
  + 'most other some such only own same too very can will just should now via per new get got '
  + 'raise send ask offer write build make deliver fix open resolve confirm update sync').split(/\s+/));

function keywords(text) {
  return [...new Set(String(text).toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [])]
    .filter(w => !STOP.has(w) && w.length >= 4);
}

function walk(root, out = [], depth = 0) {
  if (depth > 4) return out;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const fp = path.join(root, e.name);
    if (e.isDirectory()) {
      if (/^(node_modules|\.git|dist|__pycache__)$/i.test(e.name)) continue;
      walk(fp, out, depth + 1);
    } else if (e.isFile()) {
      out.push(fp);
    }
  }
  return out;
}

/**
 * Documents this task is plausibly about.
 *
 * Scored on filename keyword overlap only - never on content, because reading every
 * document in the tree to answer one screen is not a trade worth making, and the
 * naming convention here is descriptive enough that filenames carry the signal.
 * Explicit attachments always win and are never filtered out.
 */
/**
 * A readable copy of an unreadable document.
 *
 * The Truth Document is filed as legacy .doc in the work folder and as .txt in the
 * career reference, under the naming convention with only the class token differing
 * (`wcds` vs `career`). Three tasks turn on that document, so showing "no preview"
 * next to a copy we can read would be an own goal.
 *
 * Matched on the date prefix plus shared significant tokens, never on the class
 * token, and only ever used to preview - the original stays the thing being linked.
 */
function findTwin(fp, pool) {
  const stem = path.basename(fp, path.extname(fp)).toLowerCase();
  const date = (stem.match(/^(\d{8})/) || [])[1];
  if (!date) return null;
  const tokens = new Set(stem.split(/[_-]+/).filter(t => t.length >= 5 && !/^\d+$/.test(t)));
  if (!tokens.size) return null;

  for (const cand of pool) {
    if (cand === fp) continue;
    if (!/\.(txt|md)$/i.test(cand)) continue;
    const cstem = path.basename(cand, path.extname(cand)).toLowerCase();
    if (!cstem.startsWith(date)) continue;
    const ctokens = cstem.split(/[_-]+/).filter(t => t.length >= 5);
    const shared = ctokens.filter(t => tokens.has(t)).length;
    if (shared >= 2) return cand;
  }
  return null;
}

function findRelated(task, roots, attachments = [], limit = 6) {
  const kw = keywords(`${task.TITLE || ''}`);
  const scored = [];
  const pool = [];

  for (const root of roots) {
    for (const fp of walk(root)) {
      pool.push(fp);
      const name = path.basename(fp).toLowerCase();
      if (/^\./.test(path.basename(fp))) continue;
      if (/\.(log|ps1|lock)$/i.test(name)) continue;
      let score = 0;
      for (const w of kw) if (name.includes(w)) score += w.length >= 7 ? 3 : 1;
      if (score > 0) scored.push({ fp, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.fp.localeCompare(b.fp));

  const picked = [];
  const seen = new Set();
  for (const fp of attachments) {
    if (fs.existsSync(fp) && !seen.has(fp)) { seen.add(fp); picked.push({ fp, attached: true }); }
  }
  for (const s of scored) {
    if (picked.length >= limit) break;
    if (seen.has(s.fp)) continue;
    seen.add(s.fp);
    picked.push({ fp: s.fp, score: s.score });
  }

  return picked.map(p => {
    const d = { ...describe(p.fp), attached: Boolean(p.attached), score: p.score || 0 };
    if (!d.preview?.text) {
      const twin = findTwin(p.fp, pool);
      if (twin) {
        try {
          d.preview = previewPlain(twin);
          d.previewFrom = path.basename(twin);
        } catch { /* the original's note already explains there is nothing to show */ }
      }
    }
    return d;
  });
}

module.exports = { describe, findRelated, zipEntry, zipList, keywords };

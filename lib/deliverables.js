'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Deliverables - the files a task actually produced, attached to it always
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * For half these tasks the drafted document IS the task. "Deliver the gap register"
 * is not finished when something is understood, it is finished when a named file
 * exists and a named person has it. So the file cannot be a thing you go and look
 * for; it has to be sitting on the task, open, every time the task is opened.
 *
 * It was not. `docs.findRelated()` has always taken an `attachments` argument whose
 * whole purpose is "these win and are never filtered out", and every caller left it
 * empty - so a task's own DELIVERABLE column was ignored and the files appeared only
 * when filename keyword scoring happened to rank them. Ten of twenty-eight rows
 * carry explicit links; they showed up by luck. `Viva/work-documents`, where the
 * weekly snapshot lives, was not even in the search roots.
 *
 * This module is the one place that answers "what belongs to this task", so there is
 * no second answer to drift from it. Everything here is read-only, path-confined to
 * declared roots, and free of network calls - the OneDrive twin is resolved by the
 * caller, which is the only layer that has a Graph client.
 *
 * Plane B: these are internal documents. Nothing here is sent to a model.
 */

const fs   = require('fs');
const path = require('path');
const docs = require('./docs');

// The work folders, declared rather than discovered, so a walk can never wander out
// into the rest of the disk. work-documents was the missing one.
function rootsFor(workspace, engineDir) {
  return [
    path.join(workspace, 'Viva', 'work-tasks'),
    path.join(workspace, 'Viva', 'work_tasks'),      // the folder on disk uses an underscore
    path.join(workspace, 'Viva', 'work-documents'),  // the weekly snapshots live here
    path.join(workspace, 'Viva', 'work-meetings'),
    engineDir ? path.join(engineDir, 'docs', 'career') : null,
  ].filter(Boolean).filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
}

/**
 * Something he could hand to a supervisor.
 *
 * Source files, config and dependency trees are not: discovery was offering
 * reference.ts and jira.ts as the documents for the gap register, which is worse
 * than offering nothing because it makes the whole list look unreliable.
 */
function isDeliverable(d) {
  const name  = String(d?.name || '');
  const where = String(d?.path || d?.rel || '');
  if (!/\.(md|docx?|pptx?|xlsx?|pdf|txt)$/i.test(name)) return false;
  if (/node_modules|[\\/]\.cache|[\\/]build[\\/]|[\\/]dist[\\/]|_archive|superseded/i.test(where)) return false;
  if (/\.(conflict|incoming|backup)[-.\d]/i.test(name)) return false;
  // Engine and tooling docs are documentation, not deliverables.
  if (/^(README|CLAUDE|CHANGELOG|CONTRIBUTING|DEPLOY|ONBOARDING|SKILL|ARCHITECTURE|TAXONOMY|POSITIONING)\.md$/i.test(name)) return false;
  return true;
}

// ── THE NAMING CONVENTION ────────────────────────────────────────────────────
// `YYYYMMDD_class_type_project_descriptor_vM_m_p.ext`. It is followed strictly
// enough here that the type token can be trusted, which is what lets a covering
// note be told apart from the thing it covers without opening either.

const NOTE_TYPES = new Set(['message', 'reply', 'note', 'caption', 'email', 'cover']);

function parseName(name) {
  const stem = String(name).replace(/\.[^.]+$/, '');
  const m = stem.match(/^(\d{8})_([a-z0-9]+)_([a-z0-9]+)_([a-z0-9]+)_(.+?)(?:_v\d+(?:_\d+)*)?$/i);
  if (!m) return { conventional: false, tokens: stem.toLowerCase().split(/[_-]+/).filter(Boolean) };
  return {
    conventional: true,
    date: m[1], cls: m[2].toLowerCase(), type: m[3].toLowerCase(),
    project: m[4].toLowerCase(), descriptor: m[5].toLowerCase(),
    tokens: m[5].toLowerCase().split(/[_-]+/).filter(Boolean),
  };
}

/** 'note' for a covering message, 'deliverable' for the thing being handed over. */
function roleOf(name) {
  const p = parseName(name);
  if (p.conventional && NOTE_TYPES.has(p.type)) return 'note';
  if (!p.conventional && /(^|[_-])(message|reply|caption)([_-]|$)/i.test(String(name))) return 'note';
  return 'deliverable';
}

/**
 * Which deliverable a covering note is the note FOR.
 *
 * Same project token plus overlapping descriptor words: the gap-register submission
 * message names `gap` and `register`, and so does the register itself. Returns the
 * best match's `rel`, or null - a note that covers nothing in particular is still a
 * note, and guessing a pairing would be worse than leaving it unpaired.
 */
function pairNote(note, candidates) {
  const n = parseName(note.name);
  if (!n.tokens.length) return null;
  const want = new Set(n.tokens.filter(t => t.length >= 3));
  let best = null, bestScore = 0;
  for (const c of candidates) {
    if (c.rel === note.rel) continue;
    if (roleOf(c.name) === 'note') continue;
    const p = parseName(c.name);
    if (n.conventional && p.conventional && n.project !== p.project) continue;
    const score = p.tokens.filter(t => want.has(t)).length;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return bestScore >= 1 ? best.rel : null;
}

// ── LINKS ────────────────────────────────────────────────────────────────────

/** The explicit DELIVERABLE column, split and checked against the disk. */
function readLinks(task) {
  return String(task?.DELIVERABLE || '')
    .split('|').map(s => s.trim().replace(/\\/g, '/'))
    .filter(s => s && s !== '-');
}

const relOf = (workspace, abs) => path.relative(workspace, abs).replace(/\\/g, '/');

/**
 * Everything that belongs to one task.
 *
 * Order is the whole point: linked files first, because those are certain and are
 * usually the deliverable itself; then whatever discovery found, labelled as a
 * guess. Dead links are reported, never silently dropped - a link that rots sends
 * him hunting for a file the record promised him, which is worse than no link.
 *
 * Returns { deliverables, notes, related, all, dead, linked }, every entry carrying
 * `rel`, `role`, `source`, and a preview where the format allows one.
 */
function collect(task, { workspace, engineDir, limit = 6 } = {}) {
  const roots = rootsFor(workspace, engineDir);
  const links = readLinks(task);

  const dead = [];
  const attachments = [];
  for (const rel of links) {
    const abs = path.resolve(workspace, rel);
    // Confined to the declared roots even when the column says otherwise: the
    // board is a file he edits, and a path in it is not a licence to read anywhere.
    const inside = roots.some(r => abs === path.resolve(r) || abs.startsWith(path.resolve(r) + path.sep));
    if (!inside) { dead.push(rel); continue; }
    if (!fs.existsSync(abs)) { dead.push(rel); continue; }
    attachments.push(abs);
  }

  // THE FIX. `attachments` is what makes the task's own files win outright; every
  // caller used to leave it empty and then wonder where the documents went.
  let found = [];
  try { found = docs.findRelated(task, roots, attachments, Math.max(limit, attachments.length + 4)) || []; }
  catch { found = []; }

  const seen = new Set();
  const all = [];
  for (const d of found) {
    if (!d?.path) continue;
    const rel = relOf(workspace, d.path);
    if (seen.has(rel)) continue;
    const attached = Boolean(d.attached) || attachments.includes(path.resolve(d.path));
    // Discovery is filtered to real deliverables; an attached file is never
    // filtered, because he attached it on purpose.
    if (!attached && !isDeliverable({ ...d, rel })) continue;
    seen.add(rel);
    all.push({ ...d, rel, attached, source: attached ? 'linked' : 'found', role: roleOf(d.name) });
  }

  // A file linked on the row but unreadable by describe() still has to appear.
  for (const abs of attachments) {
    const rel = relOf(workspace, abs);
    if (seen.has(rel)) continue;
    seen.add(rel);
    try {
      all.push({ ...docs.describe(abs), rel, attached: true, source: 'linked', role: roleOf(path.basename(abs)) });
    } catch { /* it was on disk a moment ago; nothing useful to add */ }
  }

  for (const d of all) if (d.role === 'note') d.covers = pairNote(d, all);

  const rank = (d) => (d.source === 'linked' ? 0 : 1);
  all.sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)));

  return {
    deliverables: all.filter(d => d.role === 'deliverable'),
    notes:        all.filter(d => d.role === 'note'),
    related:      all.filter(d => d.source === 'found'),
    all,
    dead,
    linked: links.length,
  };
}

// ── THE COVERING NOTE, ALWAYS DRAFTED ────────────────────────────────────────
// A deliverable never travels alone: handing someone a file with no words is not
// how ARCHITECT submits work. The rule is a strict ladder, so there is always exactly
// one answer to "what do I say when I send this":
//
//   1. a note FILE he (or the agent) already wrote  - the authored words win
//   2. a cached model draft for this task           - written in the register
//   3. a deterministic compose from the record      - always available, no model
//
// Rung 3 is what makes "always" true on a host with no local model. It states only
// what the record states: the files by name, the decision ids on the row, the ask.

function fullText(abs) {
  // The preview caps at 4000 chars for the card; the note IS the message, so it
  // is read whole. BOM stripped for the same reason as everywhere else.
  return fs.readFileSync(abs, 'utf8').replace(/^﻿/, '').trim();
}

function composeNote(task, files, recipient) {
  const names = files.map(f => f.name);
  const ids = [...new Set((String(task.TITLE || '').match(/\b[DRP]-\d{1,3}\b/g) || []))];
  const who = recipient ? recipient.split(/\s+/)[0] : null;
  const L = [];
  if (who) L.push(`${who},`);
  if (names.length === 1) {
    L.push(`Here is ${names[0]}${ids.length ? ` (${ids.join(', ')})` : ''}.`);
  } else if (names.length > 1) {
    L.push(`Here are the ${names.length} files for this${ids.length ? ` (${ids.join(', ')})` : ''}:`);
    for (const n of names) L.push(`- ${n}`);
  } else {
    L.push(`Following up on: ${task.TITLE}.`);
  }
  L.push('Happy to adjust anything - one line back with changes is enough.');
  return L.join('\n');
}

/**
 * The one answer. `drafts` is the parsed task_drafts.json store, passed in so this
 * stays a pure function of its inputs.
 */
function resolveNote(task, collected, { workspace, drafts = {}, recipient = null } = {}) {
  // Rung 1: an authored note file on the task.
  const noteFile = (collected.notes || [])[0];
  if (noteFile) {
    try {
      const text = fullText(path.resolve(workspace, noteFile.rel));
      if (text) {
        return { source: 'file', file: noteFile.rel, name: noteFile.name,
                 covers: noteFile.covers || null, text };
      }
    } catch { /* fall through - the file vanished between collect and read */ }
  }

  // Rung 2: the newest cached model draft for this task, whatever the channel.
  const key = Object.keys(drafts)
    .filter(k => k.startsWith(`${task.ID}:`) && drafts[k]?.current?.body)
    .sort((a, b) => String(drafts[b].current.generatedAt).localeCompare(String(drafts[a].current.generatedAt)))[0];
  if (key) {
    const d = drafts[key].current;
    return { source: 'draft', to: d.to, channel: d.channel, subject: d.subject || '',
             text: d.body, why: d.why || '', generatedAt: d.generatedAt };
  }

  // Rung 3: deterministic, grounded only in the record. Never fails.
  return { source: 'composed', text: composeNote(task, collected.deliverables || [], recipient),
           note: 'Composed from the record - no model involved. Edit before sending.' };
}

module.exports = { collect, readLinks, rootsFor, isDeliverable, roleOf, parseName,
                   pairNote, relOf, resolveNote, composeNote };

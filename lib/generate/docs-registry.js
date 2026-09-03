'use strict';
/**
 * BA26081811 -- indexes every document Writer generates into
 * scope/generated_docs.tsv (schema: vault/lib/default-schema.js), so
 * there's finally a list of what's been generated. writeOutputs() (output.js)
 * only ever wrote files to local disk with no index at all -- this is that
 * index, plus soft-delete/archive/task-attach on top of it.
 *
 * One row per generate() call, not per rendered format -- LOCAL_PATH/
 * FILENAME point at the "primary" format (docx > md > pdf preference,
 * whichever actually rendered) for the Download action; DIR (not in the
 * row's own listed schema, added here since it's genuinely needed) keeps
 * the full output directory so every rendered format stays reachable.
 */

const fs = require('fs');
const path = require('path');

const FORMAT_PREFERENCE = ['docx', 'md', 'pdf'];
const CONTENT_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  md: 'text/markdown',
  pdf: 'application/pdf',
};

function nextId(rows) {
  const n = rows.reduce((m, r) => Math.max(m, parseInt(String(r.ID).replace(/\D/g, ''), 10) || 0), 0) + 1;
  return `GD${String(n).padStart(4, '0')}`;
}

function createDocsRegistryClient(opts) {
  const {
    readTSV, appendTSV, rewriteTSV,
    docsFile = 'scope/generated_docs.tsv',
    tasksFile = 'scope/tasks.tsv',
    uploadFile = null,          // BA26081813: vault's binary OneDrive upload, injected (store.uploadFile)
    generalRoot = 'Sconl/Core/Axial/Visionary/Writer/general',
    corporateRoot = 'Sconl/Core/Axial/Visionary/Corporate',
    // BA26081803: resolves an engagement's real OneDrive folder name
    // (year-prefixed, e.g. `2026-viva-valentia` -- the same folder
    // BC26082006's discovery scanned) from its org id. Injected rather
    // than importing corporate.js directly, same reasoning getCareerContext
    // is injected everywhere else in this engine: keeps this module testable
    // without a live circle. Falls back to the bare org id when unset/
    // unresolvable (a hand-added engagement with no discovery record).
    resolveEngagementFolder = async (orgId) => orgId,
    // BA26082402: resolves a venture's real, already-absolute OneDrive
    // folder path (pulse/finance/ventures.tsv's own FOLDER column, e.g.
    // `Sconl/Core/Axial/Innovator/Engineer/engineer-systems/Portfolio/
    // aquifer-content`) from its venture id. Unlike resolveEngagementFolder,
    // this returns null (not a guessed fallback) when the venture has no
    // FOLDER set (`-`) or isn't found -- a venture that's never had a
    // folder assigned has no sane default to guess, unlike an org id that
    // can at least stand in for itself.
    resolveProjectFolder = async () => null,
    // BA26083107: vault's /onedrive/browse, injected the same way
    // uploadFile is -- lists a live OneDrive folder's contents, used to
    // surface every real document in an engagement's work-documents/
    // folder, not just the ones Writer itself generated. Returns
    // {ok, items:[{id,name,size,lastModifiedDateTime,webUrl,downloadUrl,folder}]}
    // per vault/lib/onedrive-browse.js's shapeItem(); a no-op stub (never
    // wired) returns ok:false so callers degrade to generated-only.
    browseFolder = async () => ({ ok: false, error: 'browseFolder not configured' }),
  } = opts;
  if (!readTSV || !appendTSV || !rewriteTSV) throw new Error('createDocsRegistryClient requires readTSV/appendTSV/rewriteTSV');

  /** BA26081813 (general), extended by BA26081803 (engagement) once
   *  BC26082006's org discovery landed, and BA26082402 (project) once
   *  Writer's Project picker's real data source (pulse's
   *  `finance/ventures.tsv`, discovered live 20 Aug -- not a work-project
   *  file the row originally assumed) was confirmed to already carry its
   *  own FOLDER column, an absolute OneDrive path, no root-prefixing needed
   *  the way general/engagement's bare ids do. */
  async function pushToOneDrive({ targetKind, targetId, buffer, fileName, contentType }) {
    if (!uploadFile) return null;
    let folderPath;
    if (targetKind === 'general') {
      folderPath = generalRoot;
    } else if (targetKind === 'engagement' && targetId) {
      const folder = await resolveEngagementFolder(targetId).catch(() => targetId);
      folderPath = `${corporateRoot}/${folder || targetId}`;
    } else if (targetKind === 'project' && targetId) {
      // No fallback guess on purpose (see resolveProjectFolder's own
      // comment) -- a venture with FOLDER:'-' refuses the push rather than
      // writing to a wrong/empty path; the local write and TSV row still
      // happen, ONEDRIVE_WEBURL just stays '-'.
      folderPath = await resolveProjectFolder(targetId).catch(() => null);
      if (!folderPath) return null;
    } else {
      return null;
    }
    return uploadFile(folderPath, fileName, buffer, contentType).catch(() => null);
  }

  /** Called right after a successful writeOutputs() -- p: {archetypeId, targetKind, targetId, targetLabel, written:{dir,files}, version}. */
  async function recordGenerated(p) {
    const written = p.written;
    if (!written || !written.files) return null;
    const primaryExt = FORMAT_PREFERENCE.find(f => written.files[f]) || Object.keys(written.files).find(f => f !== 'content.json');
    if (!primaryExt) return null;
    const rows = await readTSV(docsFile);
    const id = nextId(rows);
    const localPath = written.files[primaryExt];
    const filename = path.basename(localPath);

    // Failure handling per the row: a failed/skipped push never blocks the
    // local write, which is already done by this point -- ONEDRIVE_WEBURL
    // just stays '-' (the Documents list already renders that as
    // "not yet uploaded" territory, no separate visible state needed for v1).
    let webUrl = null;
    try {
      const buffer = fs.readFileSync(localPath);
      webUrl = await pushToOneDrive({ targetKind: p.targetKind, targetId: p.targetId, buffer, fileName: filename, contentType: CONTENT_TYPES[primaryExt] || 'application/octet-stream' });
    } catch { /* local file read failed -- leave webUrl null, still index the row */ }

    const row = {
      ID: id,
      ARCHETYPE_ID: p.archetypeId,
      TARGET_KIND: p.targetKind || 'general',
      TARGET_ID: p.targetId || '-',
      TARGET_LABEL: p.targetLabel || '-',
      FILENAME: filename,
      VERSION: p.version || '0.1.0',
      LOCAL_PATH: localPath,
      CONTENT_JSON_PATH: written.files['content.json'] || '-',
      ONEDRIVE_WEBURL: webUrl || '-',
      TASK_ID: '-',
      STATUS: 'active',
      CREATED_AT: new Date().toISOString().slice(0, 10),
      ARCHIVED_AT: '-',
    };
    await appendTSV(docsFile, row);
    return { id, webUrl };
  }

  /** {archetypeId?, targetKind?, status?} -- status defaults to excluding 'deleted', matching the fleet's soft-delete convention elsewhere. Every row gets SOURCE:'generated' so the frontend can tell it apart from a merged-in OneDrive-only entry (listDocsMerged below). */
  async function listDocs(filter = {}) {
    const rows = await readTSV(docsFile);
    return rows
      .filter(r => !filter.archetypeId || r.ARCHETYPE_ID === filter.archetypeId)
      .filter(r => !filter.targetKind || r.TARGET_KIND === filter.targetKind)
      .filter(r => filter.status ? r.STATUS === filter.status : r.STATUS !== 'deleted')
      .sort((a, b) => (b.CREATED_AT || '').localeCompare(a.CREATED_AT || ''))
      .map(r => ({ ...r, SOURCE: 'generated' }));
  }

  /** BA26083107: an OneDrive-only entry, shaped enough like a `generated_docs.tsv`
   *  row for renderWriterDocuments() to group/search it the same way, but
   *  with no LOCAL_PATH/CONTENT_JSON_PATH (nothing to re-open in the Edit
   *  studio -- it was never generated through Writer) and SOURCE:'onedrive'
   *  so the frontend can offer Open-in-OneDrive + download but not Edit. */
  function shapeOnedriveEntry(item, { targetKind, targetId, targetLabel }) {
    return {
      ID: `OD-${item.id}`,
      ARCHETYPE_ID: '-',
      TARGET_KIND: targetKind,
      TARGET_ID: targetId,
      TARGET_LABEL: targetLabel,
      FILENAME: item.name,
      VERSION: '-',
      LOCAL_PATH: '-',
      CONTENT_JSON_PATH: '-',
      ONEDRIVE_WEBURL: item.webUrl || '-',
      ONEDRIVE_DOWNLOAD_URL: item.downloadUrl || null,
      TASK_ID: '-',
      STATUS: 'active',
      CREATED_AT: (item.lastModifiedDateTime || '').slice(0, 10),
      ARCHIVED_AT: '-',
      SOURCE: 'onedrive',
    };
  }

  /** listDocs(filter) merged with a live listing of one engagement's
   *  OneDrive work-documents/ folder, for the "surface every real
   *  document, not just Writer-generated ones" ask (BA26083107).
   *
   *  `filter` is passed to listDocs() completely unmodified -- it must
   *  NOT be narrowed to force an engagement scope, or a blank/no-filter
   *  request (today's "show everything" default) would silently stop
   *  showing general/project-target generated docs, a real regression
   *  against "generating a new document through Writer still appears
   *  immediately, same as today." The engagement to merge OneDrive
   *  contents FOR is a separate, explicit `mergeEngagement` argument
   *  ({id, label}) -- the caller (server.js) decides that (an explicit
   *  targetId=engagement query, or the active org by default), it is not
   *  inferred from `filter.targetKind`/`filter.targetId` here.
   *
   *  Never lets a browseFolder failure (folder not found, vault
   *  unreachable, no Graph auth) hide the generated docs that DO exist --
   *  falls back to listDocs()'s result alone, silently, same "a failed
   *  push never blocks the local write" tolerance recordGenerated already
   *  applies elsewhere in this file. Dedupes by filename against the
   *  generated rows, since Writer's own generated docs already live in
   *  this same OneDrive folder (pushToOneDrive) and would otherwise
   *  double-list once as 'generated' and again as 'onedrive'. */
  async function listDocsMerged(filter = {}, mergeEngagement = null) {
    const generated = await listDocs(filter);
    if (!mergeEngagement || !mergeEngagement.id) return generated;
    // If the caller already scoped filter.targetKind away from
    // 'engagement' (explicitly wants only general/project docs), an
    // engagement-only OneDrive merge would be out of scope too.
    if (filter.targetKind && filter.targetKind !== 'engagement') return generated;

    const folder = await resolveEngagementFolder(mergeEngagement.id).catch(() => mergeEngagement.id);
    const folderPath = `${corporateRoot}/${folder || mergeEngagement.id}/work-documents`;
    const result = await browseFolder(folderPath).catch((e) => ({ ok: false, error: String(e.message || e) }));
    if (!result || !result.ok || !Array.isArray(result.items)) return generated;

    const knownFilenames = new Set(generated.filter(r => r.TARGET_KIND === 'engagement' && r.TARGET_ID === mergeEngagement.id).map(r => r.FILENAME));
    const onedriveOnly = result.items
      .filter(i => !i.folder)                       // real files only, not subfolders
      .filter(i => !knownFilenames.has(i.name))
      .map(i => shapeOnedriveEntry(i, { targetKind: 'engagement', targetId: mergeEngagement.id, targetLabel: mergeEngagement.label || folder || mergeEngagement.id }));

    return [...generated, ...onedriveOnly].sort((a, b) => (b.CREATED_AT || '').localeCompare(a.CREATED_AT || ''));
  }

  /** patch: {status?, taskId?} -- archiving/restoring sets ARCHIVED_AT; deleting also best-effort unlinks the local files (never throws on a missing file -- it may have already been cleaned up by hand). */
  async function updateDoc(id, patch) {
    let found = null;
    await rewriteTSV(docsFile, rows => rows.map(r => {
      if (r.ID !== id) return r;
      found = r;
      const next = { ...r };
      if (patch.status !== undefined) {
        next.STATUS = patch.status;
        next.ARCHIVED_AT = patch.status === 'archived' ? new Date().toISOString().slice(0, 10) : (patch.status === 'active' ? '-' : next.ARCHIVED_AT);
      }
      if (patch.taskId !== undefined) next.TASK_ID = patch.taskId || '-';
      return next;
    }));
    if (!found) throw new Error(`No generated doc ${id}`);
    if (patch.status === 'deleted') {
      const dir = path.dirname(found.LOCAL_PATH);
      for (const f of [found.LOCAL_PATH, found.CONTENT_JSON_PATH]) {
        if (!f || f === '-') continue;
        try { fs.unlinkSync(f); } catch { /* already gone, or never existed -- not fatal */ }
      }
      // Only remove the directory if generate() left nothing else behind in it.
      try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* not empty, or gone -- fine either way */ }
    }
    return { success: true };
  }

  /** Base64 bytes for the Download action -- the browser already knows how
   *  to turn base64 into a Blob download (downloadWriterFile() does this
   *  for a fresh generate already); reusing that path here means no new
   *  binary-streaming route on either engine. */
  async function downloadDoc(id) {
    const rows = await readTSV(docsFile);
    const row = rows.find(r => r.ID === id);
    if (!row) throw new Error(`No generated doc ${id}`);
    if (!fs.existsSync(row.LOCAL_PATH)) throw new Error('The file is no longer on disk -- it may have been deleted outside this app');
    const ext = path.extname(row.FILENAME).replace('.', '');
    return {
      filename: row.FILENAME,
      contentType: CONTENT_TYPES[ext] || 'application/octet-stream',
      base64: fs.readFileSync(row.LOCAL_PATH).toString('base64'),
    };
  }

  /** Edit action (BA26081811): the .content.json IS the source of truth
   *  per output.js's own doc comment -- "editing a document means editing
   *  that file and re-running this, never hand-editing the .docx." This
   *  reads it back so the wizard's studio step can be re-opened pre-filled,
   *  which is genuinely just "re-run generate with the stored content
   *  pre-loaded," not a new capability. */
  async function getContent(id) {
    const rows = await readTSV(docsFile);
    const row = rows.find(r => r.ID === id);
    if (!row) throw new Error(`No generated doc ${id}`);
    if (!row.CONTENT_JSON_PATH || row.CONTENT_JSON_PATH === '-' || !fs.existsSync(row.CONTENT_JSON_PATH)) {
      throw new Error('No content.json on disk for this document -- it may have been generated before this feature existed, or moved');
    }
    const parsed = JSON.parse(fs.readFileSync(row.CONTENT_JSON_PATH, 'utf8'));
    return { archetypeId: row.ARCHETYPE_ID, targetKind: row.TARGET_KIND, targetId: row.TARGET_ID, targetLabel: row.TARGET_LABEL, content: parsed.content || {} };
  }

  /** Task dropdown for "Attach to task" -- scoped to the doc's own
   *  TARGET_ID when the target kind is 'project' (TARGET_ID IS a
   *  scope/tasks.tsv PROJECT_ID directly in that case); for 'engagement'/
   *  'general' targets there's no unambiguous PROJECT_ID to scope by, so
   *  this returns an empty list and the UI disables the action rather than
   *  guessing which project a corporate-engagement or general doc belongs to. */
  async function tasksForDoc(id) {
    const rows = await readTSV(docsFile);
    const row = rows.find(r => r.ID === id);
    if (!row || row.TARGET_KIND !== 'project' || !row.TARGET_ID || row.TARGET_ID === '-') return [];
    const tasks = await readTSV(tasksFile);
    return tasks.filter(t => t.PROJECT_ID === row.TARGET_ID);
  }

  /** Writes the picked task's DELIVERABLE column (real, already-used field)
   *  and this doc's own TASK_ID -- "attach" is a two-way pointer. */
  async function attachToTask(id, taskId) {
    const rows = await readTSV(docsFile);
    const row = rows.find(r => r.ID === id);
    if (!row) throw new Error(`No generated doc ${id}`);
    await updateDoc(id, { taskId });
    if (row.ONEDRIVE_WEBURL && row.ONEDRIVE_WEBURL !== '-') {
      await rewriteTSV(tasksFile, rows => rows.map(t => t.ID === taskId ? { ...t, DELIVERABLE: row.ONEDRIVE_WEBURL } : t));
    }
    return { success: true };
  }

  return { recordGenerated, listDocs, listDocsMerged, updateDoc, downloadDoc, getContent, tasksForDoc, attachToTask };
}

module.exports = { createDocsRegistryClient };

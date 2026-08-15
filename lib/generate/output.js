'use strict';
/**
 * Writes the rendered outputs (docx/md/pdf + the content.json source of
 * truth) to disk, per canon §6's shape:
 *   <outputRoot>/<primary_slug>/<secondary_slug>/<filename>.<ext>
 *
 * `outputRoot` is always passed in, never hardcoded - canon §10 flags the
 * exact output root (career/orgs/<org>/deliverables vs career/resume/
 * deliverables, depending on the archetype namespace) as still open, so
 * this file has no opinion about it. The .content.json written alongside
 * the rendered files IS the source of truth per canon §8 - editing a
 * document means editing that file and re-running this, never hand-
 * editing the .docx.
 */

const fs = require('fs');
const path = require('path');
const { filename: nameFile, slugify } = require('./naming');

async function writeOutputs({ outputRoot, archetype, content, version, date, buffers }) {
  const { primary, secondary } = archetype.filenameFields;
  const dir = path.join(outputRoot, slugify(content[primary]), slugify(content[secondary]));
  fs.mkdirSync(dir, { recursive: true });

  const written = {};
  for (const [ext, buf] of Object.entries(buffers)) {
    if (buf == null) continue;
    const fname = nameFile(archetype, content, { version, date, ext });
    const fp = path.join(dir, fname);
    fs.writeFileSync(fp, buf);
    written[ext] = fp;
  }

  const jsonName = nameFile(archetype, content, { version, date, ext: 'content.json' });
  const jsonPath = path.join(dir, jsonName);
  fs.writeFileSync(jsonPath, JSON.stringify({ archetype: archetype.id, version, date: date instanceof Date ? date.toISOString().slice(0, 10) : date, content }, null, 2));
  written['content.json'] = jsonPath;

  return { dir, files: written };
}

module.exports = { writeOutputs };

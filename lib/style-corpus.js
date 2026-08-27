'use strict';
/**
 * BM26082412 v1: perpetual-learning style corpus + per-contact tailoring.
 * Per Architect: "this engine has to always keep learning from interactions
 * with me... perpetually ever improving." v1 scope is the existing-data
 * corpus + a general style model + per-contact tailoring -- session-
 * transcript capture (Claude sessions feeding the corpus) is a real,
 * unbuilt capability gap, deliberately split to its own plan.md row
 * rather than guessed at here (see PM26082705).
 *
 * Ingests ONLY Architect's own OUTBOUND text (scope/inbox.tsv rows with
 * DIRECTION:'out') -- never inbound messages from other people, which
 * would teach the model to imitate someone else's voice, not his own.
 * Re-runnable: each inbox row is ingested at most once, tracked by its
 * own ID (SOURCE_ID column), so new messages arriving over time keep
 * growing the corpus without re-processing what's already in it -- the
 * "perpetually learning" requirement for v1's existing data sources.
 *
 * The "model" is deliberately simple, interpretable statistics (sentence
 * length, vocabulary, openers, punctuation habits) rather than an ML
 * pipeline -- the row explicitly left the modeling approach as the build
 * session's call, and a real but simple v1 beats an unbuilt sophisticated
 * one. Per-contact tailoring layers the same stats scoped to just that
 * person's outbound messages over the general profile.
 */

function clean(s) { return String(s || '').replace(/[\t\r\n]+/g, ' ').trim() || '-'; }

function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

function styleStats(texts) {
  const sentences = texts.flatMap(splitSentences);
  const words = texts.flatMap(t => String(t).toLowerCase().match(/[a-z0-9']+/g) || []);
  const wordCount = {};
  for (const w of words) wordCount[w] = (wordCount[w] || 0) + 1;
  const commonWords = Object.entries(wordCount).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([w]) => w);
  const openers = {};
  for (const s of sentences) {
    const first = (s.match(/^[a-zA-Z']+/) || [''])[0].toLowerCase();
    if (first) openers[first] = (openers[first] || 0) + 1;
  }
  const commonOpeners = Object.entries(openers).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
  const avgSentenceWords = sentences.length ? words.length / sentences.length : 0;
  const avgWordLength = words.length ? words.reduce((s, w) => s + w.length, 0) / words.length : 0;
  const exclamations = texts.join(' ').split('!').length - 1;
  const questions = texts.join(' ').split('?').length - 1;
  return {
    messageCount: texts.length,
    sentenceCount: sentences.length,
    avgSentenceWords: Math.round(avgSentenceWords * 10) / 10,
    avgWordLength: Math.round(avgWordLength * 10) / 10,
    commonWords, commonOpeners,
    exclamationsPer100Words: words.length ? Math.round((exclamations / words.length) * 1000) / 10 : 0,
    questionsPer100Words: words.length ? Math.round((questions / words.length) * 1000) / 10 : 0,
  };
}

function createStyleCorpusClient(opts) {
  const {
    readTSV, appendTSV,
    auditLog = { log: () => {} },
    corpusFile = 'scope/style_corpus.tsv',
    inboxFile = 'scope/inbox.tsv',
  } = opts;
  if (!readTSV || !appendTSV) throw new Error('createStyleCorpusClient requires readTSV/appendTSV');

  /** Idempotent: ingests every outbound inbox row not already in the
   *  corpus. Safe to call repeatedly (e.g. from a periodic sync loop, or
   *  manually) -- this is what makes v1 "perpetually learning" from the
   *  data sources it already has, without a session-capture mechanism. */
  async function ingestNew() {
    const [inbox, existing] = await Promise.all([readTSV(inboxFile), readTSV(corpusFile)]);
    const alreadyIngested = new Set(existing.map(r => r.SOURCE_ID));
    const outbound = inbox.filter(r => r.DIRECTION === 'out' && r.BODY && r.BODY !== '-');
    let ingested = 0;
    const today = new Date().toISOString().slice(0, 10);
    for (const row of outbound) {
      if (alreadyIngested.has(row.ID)) continue;
      await appendTSV(corpusFile, {
        ID: `SC${row.ID}`,
        SOURCE: row.CHANNEL || 'unknown',
        PERSON_ID: row.PERSON_ID && row.PERSON_ID !== '-' ? row.PERSON_ID : '-',
        SOURCE_ID: row.ID,
        TEXT: clean(row.BODY),
        WORD_COUNT: String((String(row.BODY).match(/\S+/g) || []).length),
        CAPTURED_AT: row.CAPTURED_AT || row.RECEIVED_AT || today,
        INGESTED_AT: today,
      });
      ingested += 1;
    }
    auditLog.log('style_corpus_ingested', { ingested, totalOutbound: outbound.length });
    return { ingested, corpusSize: existing.length + ingested };
  }

  /** General style profile from the whole corpus, or a per-contact one
   *  overlaid on it when personId is given -- "how he talks generally"
   *  plus "how he specifically talks to this person", per the row's own
   *  tailoring requirement. */
  async function getStyleProfile(personId) {
    const corpus = await readTSV(corpusFile);
    const general = styleStats(corpus.map(r => r.TEXT));
    if (!personId) return { general };
    const personTexts = corpus.filter(r => r.PERSON_ID === personId).map(r => r.TEXT);
    if (!personTexts.length) return { general, personId, perContact: null, note: 'no outbound history with this contact yet -- general style only' };
    return { general, personId, perContact: styleStats(personTexts) };
  }

  return { ingestNew, getStyleProfile, styleStats };
}

module.exports = { createStyleCorpusClient, styleStats };

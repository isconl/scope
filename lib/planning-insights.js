'use strict';
/**
 * BT26082601: curated planning-insight database. A one-time build+run
 * against current data (`learning/campus.tsv` / `scope/theme_days.tsv` /
 * `scope/plans.tsv`), promoting a raw row into `scope/planning_insights.tsv`
 * only when it clears all three of the row's confirmed criteria. This is
 * NOT the ongoing daily cron `PT26082003` (plan.md) sketches -- that's a
 * separate, still-blocked row sharing this same schema.
 *
 * WI26091504 (16 Sep 2026) added the daily half below: rescorePlanningInsights()
 * re-validates and re-scores what is already curated, and runDaily() pairs it
 * with the promotion pass so one call does the whole job. The promotion pass
 * above is unchanged -- it appends, it never revisits, which is exactly why a
 * separate re-score was needed for the database to improve rather than only
 * grow.
 *
 * INSIGHT is derived deterministically from the source row's own text
 * field (WHY for campus, NOTE for plans, PHRASE for theme_days -- the row
 * didn't name a field for theme_days since it has no WHY/NOTE column; this
 * is the one judgment call made at build time, flagged in done.md), never
 * LLM-rewritten -- no cross-engine AI call was named in the row's scope,
 * and inventing one is out of scope for a one-time deterministic pass.
 */

const RECENCY_DAYS_CAMPUS = 14;
const RECENCY_DAYS_PLANS = 30;
const MIN_TEXT_LEN = 20;
const SIMILARITY_THRESHOLD = 0.8;

function daysAgo(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return Infinity;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}

/** One line, no tabs/newlines, capped so the TSV stays sane. */
function oneLine(text, maxLen = 160) {
  const clean = String(text || '').replace(/[\t\r\n]+/g, ' ').trim();
  return clean.length > maxLen ? clean.slice(0, maxLen - 1).trimEnd() + '…' : clean;
}

/** Cheap string-similarity check: normalized token overlap (Jaccard).
 *  Good enough for "is this a near-duplicate of something already
 *  curated" -- not a semantic dedupe, deliberately, since this is a
 *  one-time deterministic pass, not an AI-backed one. */
function similarity(a, b) {
  const tokens = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]+/g) || []);
  const ta = tokens(a), tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap / new Set([...ta, ...tb]).size;
}

function confidenceFor(textLen, recencyDaysUsed, maxRecencyDays) {
  // Deterministic, not tuned against real usage yet -- base 50, up to +30
  // for a long/detailed source text, up to +20 for freshness within the
  // recency window. Flagged as a first-pass heuristic, not a validated
  // model.
  const textScore = Math.min(30, Math.floor(textLen / 20) * 5);
  const freshScore = Math.round(20 * (1 - Math.min(1, recencyDaysUsed / maxRecencyDays)));
  return Math.min(100, 50 + textScore + freshScore);
}

async function curatePlanningInsights({ readTSV, appendTSV, insightsFile = 'scope/planning_insights.tsv' }) {
  if (!readTSV || !appendTSV) throw new Error('curatePlanningInsights requires readTSV/appendTSV');

  const [campus, themeDays, plans, existing] = await Promise.all([
    readTSV('learning/campus.tsv'),
    readTSV('scope/theme_days.tsv'),
    readTSV('scope/plans.tsv'),
    readTSV(insightsFile),
  ]);

  const candidates = [];

  for (const row of campus) {
    const age = daysAgo(row.UPDATED_AT);
    if (age > RECENCY_DAYS_CAMPUS) continue;
    const text = row.WHY;
    if (!text || text === '-' || text.length <= MIN_TEXT_LEN) continue;
    candidates.push({
      source: 'campus', sourceId: row.ID, text,
      confidence: confidenceFor(text.length, age, RECENCY_DAYS_CAMPUS),
    });
  }

  for (const row of themeDays) {
    const age = daysAgo(row.ADDED_AT);
    if (age > RECENCY_DAYS_CAMPUS) continue; // no dedicated window named for this source; reuse campus's
    const text = row.PHRASE; // theme_days has no WHY/NOTE column -- PHRASE is its only text field
    if (!text || text === '-' || text.length <= MIN_TEXT_LEN) continue;
    candidates.push({
      source: 'theme_days', sourceId: row.DATE, text,
      confidence: confidenceFor(text.length, age, RECENCY_DAYS_CAMPUS),
    });
  }

  for (const row of plans) {
    if (row.STATUS !== 'active') continue;
    const age = daysAgo(row.CREATED_AT);
    if (age > RECENCY_DAYS_PLANS) continue;
    const text = row.NOTE;
    if (!text || text === '-' || text.length <= MIN_TEXT_LEN) continue;
    candidates.push({
      source: 'plans', sourceId: row.ID, text,
      confidence: confidenceFor(text.length, age, RECENCY_DAYS_PLANS),
    });
  }

  const existingInsights = existing.map(r => r.INSIGHT).filter(Boolean);
  const promoted = [];
  const today = new Date().toISOString().slice(0, 10);
  let n = existing.reduce((m, r) => Math.max(m, parseInt(String(r.ID).replace(/\D/g, ''), 10) || 0), 0);

  for (const c of candidates) {
    const insight = oneLine(c.text);
    const isDup = existingInsights.some(e => similarity(e, insight) >= SIMILARITY_THRESHOLD)
      || promoted.some(p => similarity(p.INSIGHT, insight) >= SIMILARITY_THRESHOLD);
    if (isDup) continue;
    n += 1;
    const row = {
      ID: `PI${String(n).padStart(4, '0')}`,
      SOURCE: c.source,
      SOURCE_ID: c.sourceId,
      INSIGHT: insight,
      CONFIDENCE: String(c.confidence),
      LAST_VALIDATED: today,
      STATUS: 'active',
      PROMOTED_AT: today,
    };
    promoted.push(row);
    existingInsights.push(insight);
  }

  for (const row of promoted) await appendTSV(insightsFile, row);

  return { promoted: promoted.length, evaluated: candidates.length, rows: promoted };
}

/** Where each source's text and timestamp live, and how long a row from it
 *  stays inside its recency window. Single table so the promotion pass and
 *  the re-score below cannot drift apart on what "recent" means per source. */
const SOURCES = {
  campus: { file: 'learning/campus.tsv', idField: 'ID', textField: 'WHY', dateField: 'UPDATED_AT', window: RECENCY_DAYS_CAMPUS },
  theme_days: { file: 'scope/theme_days.tsv', idField: 'DATE', textField: 'PHRASE', dateField: 'ADDED_AT', window: RECENCY_DAYS_CAMPUS },
  plans: { file: 'scope/plans.tsv', idField: 'ID', textField: 'NOTE', dateField: 'CREATED_AT', window: RECENCY_DAYS_PLANS },
};

/**
 * WI26091504: re-validate and re-score every already-curated insight against
 * its source row as it stands today.
 *
 * Three outcomes per row, and none of them is deletion -- the schema has no
 * audit trail of its own, so a removed row would leave no evidence it ever
 * existed or why it went:
 *   - source row gone entirely  -> STATUS 'retired' (terminal; a row whose
 *     source was deleted does not come back, because there is nothing left to
 *     re-validate it against)
 *   - source row aged past its recency window -> STATUS 'stale' (reversible:
 *     if the source is edited and its timestamp moves back inside the window,
 *     the next run revives it, which is the "self-improving" part -- an
 *     insight going quiet is not the same as an insight being wrong)
 *   - source row still inside its window -> stays/returns to 'active',
 *     CONFIDENCE recomputed from the source's CURRENT text and age
 *
 * LAST_VALIDATED is bumped on every row this pass touches, which is
 * deliberately how the run is observable: the freshest LAST_VALIDATED in the
 * collection IS the last-run date. WI26091504's own acceptance note -- "a run
 * that leaves no trace is indistinguishable from a run that never happened" --
 * is answered by the data rather than by separate telemetry that can itself
 * fail silently.
 */
async function rescorePlanningInsights({ readTSV, rewriteTSV, insightsFile = 'scope/planning_insights.tsv' }) {
  if (!readTSV || !rewriteTSV) throw new Error('rescorePlanningInsights requires readTSV/rewriteTSV');

  const names = Object.keys(SOURCES);
  const loaded = await Promise.all(names.map(n => readTSV(SOURCES[n].file)));
  const bySource = {};
  names.forEach((n, i) => {
    const cfg = SOURCES[n];
    const index = new Map();
    for (const row of loaded[i]) index.set(String(row[cfg.idField]), row);
    bySource[n] = index;
  });

  const today = new Date().toISOString().slice(0, 10);
  const counts = { examined: 0, rescored: 0, retired: 0, staled: 0, revived: 0, unchanged: 0 };

  await rewriteTSV(insightsFile, (rows) => rows.map((row) => {
    // A row whose source this pass does not understand is left exactly as it
    // is. Re-scoring is not a licence to rewrite rows written by something
    // else -- silently normalising an unknown SOURCE would destroy data this
    // function has no basis to judge.
    const cfg = SOURCES[row.SOURCE];
    if (!cfg) return row;
    counts.examined += 1;

    if (row.STATUS === 'retired') { counts.unchanged += 1; return row; }

    const source = bySource[row.SOURCE].get(String(row.SOURCE_ID));
    if (!source) {
      counts.retired += 1;
      return { ...row, STATUS: 'retired', LAST_VALIDATED: today };
    }

    const text = source[cfg.textField];
    if (!text || text === '-' || text.length <= MIN_TEXT_LEN) {
      // The source still exists but no longer carries usable text -- the same
      // bar the promotion pass applies, applied again on the way back.
      counts.retired += 1;
      return { ...row, STATUS: 'retired', LAST_VALIDATED: today };
    }

    const age = daysAgo(source[cfg.dateField]);
    if (age > cfg.window) {
      if (row.STATUS !== 'stale') counts.staled += 1; else counts.unchanged += 1;
      return { ...row, STATUS: 'stale', LAST_VALIDATED: today };
    }

    if (row.STATUS === 'stale') counts.revived += 1;
    const confidence = String(confidenceFor(text.length, age, cfg.window));
    const insight = oneLine(text);
    if (confidence !== row.CONFIDENCE || insight !== row.INSIGHT) counts.rescored += 1;
    return { ...row, INSIGHT: insight, CONFIDENCE: confidence, STATUS: 'active', LAST_VALIDATED: today };
  }));

  return counts;
}

function createPlanningInsightsClient(opts) {
  const { readTSV, appendTSV, rewriteTSV, auditLog = { log: () => {} } } = opts;

  async function runCuration() {
    const result = await curatePlanningInsights({ readTSV, appendTSV });
    auditLog.log('planning_insights_curated', { promoted: result.promoted, evaluated: result.evaluated });
    return result;
  }

  return {
    runCuration,

    async runRescore() {
      const counts = await rescorePlanningInsights({ readTSV, rewriteTSV });
      auditLog.log('planning_insights_rescored', counts);
      return counts;
    },

    /**
     * WI26091504's daily job, in one call so a timer is a one-line curl and
     * not a sequence something can execute half of.
     *
     * Order matters and is not arbitrary: re-score FIRST, then promote. A row
     * promoted moments earlier has nothing to re-validate against that the
     * promotion pass did not just check, so scoring it again is wasted work --
     * and worse, running promotion first then re-scoring would bump
     * LAST_VALIDATED on brand-new rows, making "promoted today" and
     * "re-validated today" indistinguishable in the data.
     */
    async runDaily() {
      const startedAt = new Date().toISOString();
      const rescored = await rescorePlanningInsights({ readTSV, rewriteTSV });
      const curated = await curatePlanningInsights({ readTSV, appendTSV });
      const result = {
        ok: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        rescored,
        promoted: curated.promoted,
        evaluated: curated.evaluated,
      };
      auditLog.log('planning_insights_daily_run', {
        promoted: result.promoted, evaluated: result.evaluated, ...rescored,
      });
      return result;
    },

    async listInsights() {
      const rows = await readTSV('scope/planning_insights.tsv');
      // lastValidatedAt doubles as "when did the daily job last run" -- see
      // rescorePlanningInsights' header for why the data is the trace.
      const lastValidatedAt = rows.reduce(
        (max, r) => (r.LAST_VALIDATED && r.LAST_VALIDATED > max ? r.LAST_VALIDATED : max), '');
      return { insights: rows, lastValidatedAt: lastValidatedAt || null };
    },
  };
}

module.exports = { createPlanningInsightsClient, curatePlanningInsights, rescorePlanningInsights };

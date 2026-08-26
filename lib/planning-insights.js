'use strict';
/**
 * BT26082601: curated planning-insight database. A one-time build+run
 * against current data (`learning/campus.tsv` / `scope/theme_days.tsv` /
 * `scope/plans.tsv`), promoting a raw row into `scope/planning_insights.tsv`
 * only when it clears all three of the row's confirmed criteria. This is
 * NOT the ongoing daily cron `PT26082003` (plan.md) sketches -- that's a
 * separate, still-blocked row sharing this same schema.
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

function createPlanningInsightsClient(opts) {
  const { readTSV, appendTSV, auditLog = { log: () => {} } } = opts;
  return {
    async runCuration() {
      const result = await curatePlanningInsights({ readTSV, appendTSV });
      auditLog.log('planning_insights_curated', { promoted: result.promoted, evaluated: result.evaluated });
      return result;
    },
    async listInsights() {
      const rows = await readTSV('scope/planning_insights.tsv');
      return { insights: rows };
    },
  };
}

module.exports = { createPlanningInsightsClient, curatePlanningInsights };

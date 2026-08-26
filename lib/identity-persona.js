'use strict';
/**
 * BT26082415: 60/30/10 identity-persona ring -- the day's whole split
 * (public face / inner circle / internal-private), fed by each block's
 * PERSONA column (vault/lib/default-schema.js). Read-only v1, per the
 * row's own recommended default -- an interactive rebalance is a natural
 * v2, not required for the widget to be useful. Designed to be
 * persona-set-agnostic: whatever PERSONA values exist in blocks.tsv are
 * what gets summed and shown, nothing hardcoded to exactly these three.
 */

const TARGET_PCT = { public: 60, inner_circle: 30, internal_private: 10 };
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** A block's duration, handling the one overnight wrap (Rest, e.g.
 *  21:00-05:00) -- excluded from the split anyway (PERSONA:'-'), but
 *  computed correctly in case a future persona set ever assigns one. */
function durationMinutes(block) {
  const start = toMinutes(block.START), end = toMinutes(block.END);
  return end > start ? end - start : (24 * 60 - start) + end;
}

async function computePersonaSplit({ readTSV, day }) {
  const blocks = await readTSV('scope/blocks.tsv');
  const targetDay = day || DAY_NAMES[new Date().getDay()];
  const dayBlocks = blocks.filter(b => b.DAY === targetDay && b.PERSONA && b.PERSONA !== '-');

  const minutesByPersona = {};
  for (const b of dayBlocks) {
    minutesByPersona[b.PERSONA] = (minutesByPersona[b.PERSONA] || 0) + durationMinutes(b);
  }
  const totalMinutes = Object.values(minutesByPersona).reduce((a, n) => a + n, 0);

  const personas = Object.keys(minutesByPersona).map(persona => ({
    persona,
    minutes: minutesByPersona[persona],
    actualPct: totalMinutes ? Math.round((minutesByPersona[persona] / totalMinutes) * 100) : 0,
    targetPct: TARGET_PCT[persona] ?? null,
  }));

  return { day: targetDay, totalMinutes, personas, blockCount: dayBlocks.length };
}

module.exports = { computePersonaSplit, TARGET_PCT };

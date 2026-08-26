'use strict';
/**
 * BT26082414: block-adherence analysis from real start/stop data (BT26082413's
 * per-task SESSIONS array) against blocks.tsv's 8-8-8 day structure -- where
 * time actually went vs. where each block says it should, plus plain-text
 * recommendations. Depends on BT26082413's real session data existing.
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function clean(s) { return String(s || '').replace(/[\t\r\n]+/g, ' ').trim() || '-'; }

function minutesBetween(startIso, stopIso) {
  const s = new Date(startIso), e = new Date(stopIso);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return 0;
  return Math.max(0, (e.getTime() - s.getTime()) / 60000);
}

function timeOfDayMinutes(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.getHours() * 60 + d.getMinutes();
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Which block (if any) a session's start time falls into, matched by
 *  day-of-week + time-of-day range. A session spanning multiple blocks is
 *  attributed to the block its START falls in -- good enough for an
 *  adherence signal, not a minute-perfect ledger. */
function blockFor(blocks, startIso) {
  const d = new Date(startIso);
  if (isNaN(d.getTime())) return null;
  const day = DAY_NAMES[d.getDay()];
  const tod = timeOfDayMinutes(startIso);
  return blocks.find(b => b.DAY === day && b.ACTIVE === 'yes' && tod >= toMinutes(b.START) && tod < toMinutes(b.END)) || null;
}

function matchesBlock(block, taskTitle) {
  const keywords = String(block.MATCH || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  if (!keywords.length) return null; // block has no keyword list (e.g. Protected/Flex/Lunch) -- adherence not meaningful
  const title = String(taskTitle || '').toLowerCase();
  return keywords.some(k => title.includes(k));
}

function parseSessions(row) {
  if (!row.SESSIONS || row.SESSIONS === '-') return [];
  try { return JSON.parse(row.SESSIONS) || []; } catch { return []; }
}

async function computeAdherence({ readTSV, days = 7 }) {
  const [tasks, blocks] = await Promise.all([readTSV('scope/tasks.tsv'), readTSV('scope/blocks.tsv')]);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const byBlock = new Map(); // ID -> { block, loggedMinutes, matchedMinutes, sessionCount }
  for (const b of blocks) byBlock.set(b.ID, { block: b, loggedMinutes: 0, matchedMinutes: 0, sessionCount: 0 });

  for (const task of tasks) {
    for (const session of parseSessions(task)) {
      if (!session.stop) continue; // still open, not a completed sitting
      const startTime = new Date(session.start).getTime();
      if (isNaN(startTime) || startTime < cutoff) continue;
      const block = blockFor(blocks, session.start);
      if (!block) continue;
      const entry = byBlock.get(block.ID);
      const mins = minutesBetween(session.start, session.stop);
      entry.loggedMinutes += mins;
      entry.sessionCount += 1;
      const matched = matchesBlock(block, task.TITLE);
      if (matched) entry.matchedMinutes += mins;
    }
  }

  const perBlock = [...byBlock.values()].map(({ block, loggedMinutes, matchedMinutes, sessionCount }) => {
    const capacityMinutes = toMinutes(block.END) - toMinutes(block.START);
    const hasKeywords = String(block.MATCH || '').trim().length > 0;
    return {
      blockId: block.ID,
      day: block.DAY,
      name: block.NAME,
      axis: block.AXIS,
      window: `${block.START}-${block.END}`,
      loggedMinutes: Math.round(loggedMinutes),
      capacityMinutes,
      utilization: capacityMinutes ? Math.round((loggedMinutes / capacityMinutes) * 100) : null,
      adherencePct: hasKeywords && loggedMinutes > 0 ? Math.round((matchedMinutes / loggedMinutes) * 100) : null,
      sessionCount,
    };
  });

  const recommendations = [];
  for (const b of perBlock) {
    if (b.sessionCount === 0 && b.axis !== 'protected' && b.axis !== 'flex' && b.axis !== 'lunch') {
      recommendations.push(`${b.day} ${b.name} (${b.window}): no logged sessions in the last ${days} days -- either this block isn't being used, or work happening there isn't being tracked with start/stop.`);
    } else if (b.adherencePct !== null && b.adherencePct < 50) {
      recommendations.push(`${b.day} ${b.name} (${b.window}): only ${b.adherencePct}% of logged time matched this block's own purpose (${b.axis}) -- most of the work happening here belongs to a different block.`);
    } else if (b.utilization !== null && b.utilization > 150) {
      recommendations.push(`${b.day} ${b.name} (${b.window}): logged ${b.utilization}% of its capacity -- consistently overrunning into adjacent time.`);
    }
  }

  return { days, perBlock, recommendations };
}

module.exports = { computeAdherence, blockFor, matchesBlock };

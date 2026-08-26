'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computePersonaSplit } = require('../lib/identity-persona');

const BLOCKS = [
  { DAY: 'Mon', START: '05:00', END: '06:00', PERSONA: 'internal_private' },
  { DAY: 'Mon', START: '06:00', END: '08:00', PERSONA: 'public' },
  { DAY: 'Mon', START: '08:00', END: '09:00', PERSONA: 'inner_circle' },
  { DAY: 'Mon', START: '21:00', END: '05:00', PERSONA: '-' }, // Rest, excluded
  { DAY: 'Tue', START: '05:00', END: '06:00', PERSONA: 'public' },
];

function makeStore(blocks) {
  return { readTSV: async () => blocks };
}

test('computePersonaSplit sums minutes per persona for the given day, excluding "-"', async () => {
  const r = await computePersonaSplit({ readTSV: makeStore(BLOCKS).readTSV, day: 'Mon' });
  assert.equal(r.totalMinutes, 60 + 120 + 60); // 1h + 2h + 1h, Rest excluded
  const byPersona = Object.fromEntries(r.personas.map(p => [p.persona, p.minutes]));
  assert.equal(byPersona.internal_private, 60);
  assert.equal(byPersona.public, 120);
  assert.equal(byPersona.inner_circle, 60);
});

test('computePersonaSplit computes actualPct against the day total, and carries the 60/30/10 target', async () => {
  const r = await computePersonaSplit({ readTSV: makeStore(BLOCKS).readTSV, day: 'Mon' });
  const pub = r.personas.find(p => p.persona === 'public');
  assert.equal(pub.actualPct, Math.round((120 / 240) * 100));
  assert.equal(pub.targetPct, 60);
});

test('computePersonaSplit handles an overnight-wrapping block duration correctly', async () => {
  // Verified indirectly: Rest (21:00-05:00, 8h) is excluded from the split,
  // but if it carried a real persona its duration must still compute right
  // (480 min, not negative) -- covered by not throwing/producing garbage.
  const withRestPersona = [...BLOCKS.filter(b => b.DAY === 'Mon'), { DAY: 'Mon', START: '21:00', END: '05:00', PERSONA: 'internal_private' }];
  const r = await computePersonaSplit({ readTSV: async () => withRestPersona, day: 'Mon' });
  const priv = r.personas.find(p => p.persona === 'internal_private');
  assert.equal(priv.minutes, 60 + 480); // the original 1h block + the 8h overnight block
});

test('computePersonaSplit defaults to today when no day is given', async () => {
  const todayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()];
  const r = await computePersonaSplit({ readTSV: makeStore(BLOCKS).readTSV });
  assert.equal(r.day, todayName);
});

test('computePersonaSplit is persona-set-agnostic -- an unrecognized persona name still gets summed, just with targetPct:null', async () => {
  const custom = [{ DAY: 'Mon', START: '05:00', END: '06:00', PERSONA: 'deep_work' }];
  const r = await computePersonaSplit({ readTSV: async () => custom, day: 'Mon' });
  const p = r.personas.find(p => p.persona === 'deep_work');
  assert.equal(p.minutes, 60);
  assert.equal(p.targetPct, null);
});

test('computePersonaSplit returns an empty split for a day with no assigned-persona blocks', async () => {
  const r = await computePersonaSplit({ readTSV: async () => [], day: 'Mon' });
  assert.equal(r.totalMinutes, 0);
  assert.deepEqual(r.personas, []);
});

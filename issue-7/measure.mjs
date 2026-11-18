import { writeFileSync } from 'node:fs';
import { launch, at } from './lib.mjs';

const [url, outFile] = process.argv.slice(2);
const b = await launch();
await b.load(url, at('00:00'));

const probe = (day0, minutes) => `(() => {
  const svg = document.querySelector('#clock');
  const box = e => { const q = e.getBBox(); return {x0: q.x, y0: q.y, x1: q.x + q.width, y1: q.y + q.height}; };
  const hit = (a, c) => a.x0 < c.x1 && c.x0 < a.x1 && a.y0 < c.y1 && c.y0 < a.y1;
  const gap = (a, c) => Math.max(c.x0 - a.x1, a.x0 - c.x1, c.y0 - a.y1, a.y0 - c.y1);
  const inside = (a, o) => a.x0 >= o.x0 && a.y0 >= o.y0 && a.x1 <= o.x1 && a.y1 <= o.y1;
  const segHit = (l, a) => {
    const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map(k => +l.getAttribute(k));
    let t0 = 0, t1 = 1; const dx = x2 - x1, dy = y2 - y1;
    for (const [p, q] of [[-dx, x1 - a.x0], [dx, a.x1 - x1], [-dy, y1 - a.y0], [dy, a.y1 - y1]]) {
      if (p === 0) { if (q < 0) return false; } else { const t = q / p; if (p < 0) { if (t > t1) return false; t0 = Math.max(t0, t); } else { if (t < t0) return false; t1 = Math.min(t1, t); } }
    }
    return t0 <= t1;
  };
  const out = [];
  for (const m of ${JSON.stringify(minutes)}) {
    window.__T = Date.parse('2026-11-19T00:00:00+09:00') + m * 60000;
    draw();
    const pill = svg.querySelector('rect[rx="9"]'), txt = svg.querySelector('text.now');
    const row = { m, hhmm: String(m / 60 | 0).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') };
    if (!pill || !txt) { row.missing = true; out.push(row); continue; }
    const pb = box(pill), tb = box(txt), vb = {x0: 0, y0: 0, x1: 440, y1: 440};
    const hours = [...svg.querySelectorAll('.hour')].map(box);
    const ticks = [...svg.querySelectorAll('line[stroke="#8a7b66"]')];
    const sr = svg.getBoundingClientRect();
    const labels = [...svg.querySelectorAll('.label')].map(e => { const q = e.getBoundingClientRect(); return {x0: q.x - sr.x, y0: q.y - sr.y, x1: q.right - sr.x, y1: q.bottom - sr.y}; });
    const handles = [...svg.querySelectorAll('.handle')].map(h => ({x0: +h.getAttribute('cx') - 7, y0: +h.getAttribute('cy') - 7, x1: +h.getAttribute('cx') + 7, y1: +h.getAttribute('cy') + 7}));
    Object.assign(row, {
      textOk: txt.textContent === row.hhmm,
      pillInViewBox: inside(pb, vb), textInViewBox: inside(tb, vb), textInPill: inside(tb, pb),
      hourOverlaps: hours.filter(h => hit(pb, h)).length,
      minHourGap: Math.min(...hours.map(h => gap(pb, h))),
      tickOverlaps: ticks.filter(l => segHit(l, pb)).length,
      sliceLabelOverlaps: labels.filter(l => hit(pb, l)).length,
      handleOverlaps: handles.filter(h => hit(pb, h)).length,
      placement: (Math.hypot(+pill.getAttribute('x') + 20 - 220, +pill.getAttribute('y') + 9 - 220) > 170 ? 'outer' : 'inner'),
      pill: pb, text: tb,
    });
    out.push(row);
  }
  return out;
})()`;

const clean = r => !r.missing && r.textOk && r.pillInViewBox && r.textInViewBox && r.textInPill && r.hourOverlaps === 0;
const steps144 = Array.from({ length: 144 }, (_, i) => i * 10);
const extras = [5, 1439, 1, 719, 725, 1435];
const r144 = await b.evalJs(probe(0, steps144));
const rExtra = await b.evalJs(probe(0, extras));
const rAll = await b.evalJs(probe(0, Array.from({ length: 1440 }, (_, i) => i)));

const summarize = rows => ({
  total: rows.length,
  pass: rows.filter(clean).length,
  failures: rows.filter(r => !clean(r)).map(r => ({ hhmm: r.hhmm, missing: r.missing, textOk: r.textOk, pillInViewBox: r.pillInViewBox, textInViewBox: r.textInViewBox, textInPill: r.textInPill, hourOverlaps: r.hourOverlaps })),
  placements: rows.reduce((a, r) => (a[r.placement] = (a[r.placement] || 0) + 1, a), {}),
  minHourGapPx: Math.min(...rows.map(r => r.minHourGap)),
  minPillMargin: Math.min(...rows.map(r => Math.min(r.pill.x0, r.pill.y0, 440 - r.pill.x1, 440 - r.pill.y1))),
  pillWidthRange: [Math.min(...rows.map(r => r.pill.x1 - r.pill.x0)), Math.max(...rows.map(r => r.pill.x1 - r.pill.x0))],
  textBox: { minW: Math.min(...rows.map(r => r.text.x1 - r.text.x0)), maxW: Math.max(...rows.map(r => r.text.x1 - r.text.x0)), maxH: Math.max(...rows.map(r => r.text.y1 - r.text.y0)) },
  minTextMarginInPill: Math.min(...rows.map(r => Math.min(r.text.x0 - r.pill.x0, r.pill.x1 - r.text.x1))),
  ticksCoveredAtLeastOnce: rows.filter(r => r.tickOverlaps > 0).length,
  sliceLabelOverlapTimes: rows.filter(r => r.sliceLabelOverlaps > 0).length,
  handleOverlapTimes: rows.filter(r => r.handleOverlaps > 0).length,
});
const result = {
  url,
  exceptions: [...b.st.exceptions],
  every10min: summarize(r144),
  extraMinutes: rExtra.map(r => ({ hhmm: r.hhmm, ok: clean(r), placement: r.placement, minHourGap: r.minHourGap })),
  everyMinute: summarize(rAll),
  sample: Object.fromEntries(['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00', '00:40', '01:00', '01:20', '01:30'].map(h => [h, rAll.find(r => r.hhmm === h)])),
};
writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, sample: undefined }, null, 2));
b.close();

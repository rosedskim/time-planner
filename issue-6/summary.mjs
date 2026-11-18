import { readFileSync } from 'node:fs';
const names = ['before', 'cand-A1', 'cand-A2', 'cand-B', 'after'];
const rs = names.map(n => JSON.parse(readFileSync(new URL(n + '-result.json', import.meta.url))));
const walk = (o, acc) => { if (o && typeof o === 'object') { if ('visualMatchesStartOrder' in o) acc.push(o); else Object.values(o).forEach(v => walk(v, acc)); } };
const find = p => Object.keys(rs[0].scenarios).find(k => k.startsWith(p));
console.log('Snapshots whose visual row order differs from the start-time order, per scenario (bad/total).');
console.log(['scenario', ...names].join(' | '));
for (const k of Object.keys(rs[0].scenarios)) {
  console.log([k.slice(0, 70), ...rs.map(r => { const a = []; walk(r.scenarios[k], a); return `${a.filter(x => !x.visualMatchesStartOrder).length}/${a.length}${r.scenarios[k].exceptions.length ? ' EXC' : ''}`; })].join(' | '));
}
console.log('\nTyped value in the 밤 start box (S2), expected 11:00 -> 01:00 -> 00:00 -> 00:10, and S8 final value (expected 00:00).');
rs.forEach((r, i) => {
  const s2 = r.scenarios[find('S2')], s8 = r.scenarios[find('S8')], g = x => x.timeBoxes['밤'].split('~')[0];
  console.log(`${names[i]}: S2 ${['afterAmPm', 'afterDigit1', 'afterDigit2', 'afterMinuteArrowUp'].map(k => g(s2[k])).join(' -> ')} | S8 ${g(s8.after)}`);
});
console.log('\nS9 Tab order after 밤 moved to the top (visual order 밤, 새벽, 오전).');
rs.forEach((r, i) => { const s9 = r.scenarios[find('S9')]; console.log(`${names[i]}: Tab from 밤/name: ${s9.tabForwardFromFirstVisualRowName.slice(0, 8).join(' ')} ... | Shift+Tab from 새벽/name: ${s9.shiftTabFromSecondVisualRowName.slice(0, 4).join(' ')}`); });
console.log('\nS13 the keystroke that crosses 00:00: DOM mutations and focus events.');
rs.forEach((r, i) => { const s = r.scenarios[find('S13')]; console.log(`${names[i]}: ${JSON.stringify(s.mutations)} events=${s.events} focus=${s.after.focus}`); });
console.log('\nS12 a time edit that does not reorder: DOM mutations.');
rs.forEach((r, i) => console.log(`${names[i]}: ${JSON.stringify(r.scenarios[find('S12')].mutations)}`));
console.log('\nS0 layout rects [x, y, w, h].');
rs.forEach((r, i) => console.log(`${names[i]}: ${JSON.stringify(r.scenarios[find('S0')].rects)}`));

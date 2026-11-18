import { readFileSync } from 'node:fs';
const names = process.argv.slice(2);
const rs = names.map(n => JSON.parse(readFileSync(n + '-result.json')));
const walk = (o, path, acc) => {
  if (o && typeof o === 'object' && 'visualMatchesStartOrder' in o) acc.push([path, o]);
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, path ? path + '.' + k : k, acc);
};
const keys = Object.keys(rs[0].scenarios);
for (const k of keys) {
  console.log('\n### ' + k);
  rs.forEach((r, i) => {
    const sc = r.scenarios[k]; if (!sc) return;
    const acc = []; walk(sc, '', acc);
    console.log(' [' + names[i] + '] ' + acc.map(([p, s]) => `${p}:${s.visualMatchesStartOrder ? 'OK' : 'BAD'}(${s.visual})@${s.focus}${s.sameFocusedNode ? '*' : ''}${s.timeBoxes ? ' ' + Object.values(s.timeBoxes).filter((_, j) => 1).map(x => x.split('~')[0]).join('/') : ''}`).join(' | '));
    const extra = Object.fromEntries(Object.entries(sc).filter(([kk, v]) => !JSON.stringify(v).includes('visualMatchesStartOrder') && kk !== 'exceptions'));
    if (Object.keys(extra).length) console.log('    extra: ' + JSON.stringify(extra));
    if (sc.exceptions?.length) console.log('    EXCEPTIONS ' + JSON.stringify(sc.exceptions));
  });
}

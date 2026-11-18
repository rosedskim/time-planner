import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, at, sleep } from './lib.mjs';

const [url, out, exampleJson] = process.argv.slice(2);
const b = await launch();
const { evalJs } = b;

const dom = () => evalJs(`(() => {
  const svg = document.querySelector('#clock');
  const cb = document.querySelector('#shownow');
  return {
    checkbox: cb ? cb.checked : null,
    redLines: [...svg.querySelectorAll('line')].filter(l => l.getAttribute('stroke') === '#e5484d').length,
    pills: svg.querySelectorAll('rect[fill="#d6343a"]').length,
    pillTexts: [...svg.querySelectorAll('text.now')].map(t => t.textContent),
    anyTimeText: [...svg.querySelectorAll('text')].map(t => t.textContent).filter(s => /^\\d\\d:\\d\\d$/.test(s)),
    center: [...svg.querySelectorAll('text.center')].map(t => t.textContent),
    dirty, msg: document.querySelector('#msg').textContent,
    tables: store.tables.length, current: cur.name,
  };
})()`);
const exportJson = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-'));
  await b.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
  await b.clickSel('#exp'); await sleep(1000);
  const f = readdirSync(dir)[0];
  return JSON.parse(readFileSync(join(dir, f), 'utf8'));
};
const keysOf = j => ({ top: Object.keys(j), table: Object.keys(j.tables[0]), block: Object.keys(j.tables[0].blocks[0]) });
const fresh = async t => { await b.load(url, at(t)); await b.send('Browser.setDownloadBehavior', { behavior: 'deny' }); };

const R = { url, scenarios: {} };
const S = R.scenarios;
const hasBox = await (async () => { await fresh('09:10'); return evalJs(`!!document.querySelector('#shownow')`); })();

// E: export baseline on a fresh page
S.E0_export_keys_fresh = keysOf(await exportJson());
const exportA = await exportJson();

if (hasBox) {
  // T1: mouse toggle
  await fresh('09:10');
  S.T1a_initial = await dom();
  await b.shot(`${out}-on-0910.png`, null);
  await b.clickSel('#shownow');
  S.T1b_after_click_off = await dom();
  await b.shot(`${out}-off-0910.png`, null);
  await b.clickSel('#shownow');
  S.T1c_after_click_on = await dom();

  // T2: keyboard (Space on the focused checkbox)
  await fresh('09:10');
  await evalJs(`document.querySelector('#shownow').focus()`);
  await b.key('Space');
  S.T2a_space_off = await dom();
  await b.key('Space');
  S.T2b_space_on = await dom();
  S.T2c_label_click = await (async () => { await b.clickSel('#bar label'); return dom(); })();
  await b.clickSel('#bar label');

  // T3: the 60 second refresh under a controlled clock (calls the callback the app registered with setInterval)
  await fresh('09:10');
  S.T3_interval_registered = await evalJs(`window.__intervals.map(i => i.ms)`);
  const tick = (t) => evalJs(`window.__T = ${at(t)}; window.__intervals.find(i => i.ms === 60000).fn(); 0`);
  await tick('09:11'); S.T3a_on_tick_0911 = await dom();
  await b.clickSel('#shownow');
  await tick('09:12'); S.T3b_off_tick_0912 = await dom();
  await tick('09:13'); S.T3c_off_tick_0913 = await dom();
  await b.clickSel('#shownow');
  S.T3d_on_again_shows_current_clock = await dom();
  await tick('09:14'); S.T3e_on_tick_0914 = await dom();

  // T4: dirty
  await fresh('09:10');
  S.T4a_fresh_dirty = await evalJs(`dirty`);
  await b.clickSel('#shownow'); await b.clickSel('#shownow');
  S.T4b_after_two_toggles_dirty = await evalJs(`dirty`);
  await b.clickSel('.row[data-id="1"] [data-f=name]');
  await evalJs(`(() => { const i = document.querySelector('.row[data-id="1"] [data-f=name]'); i.value = '잠자기'; i.dispatchEvent(new Event('input', {bubbles: true})); })()`);
  S.T4c_after_edit_dirty = await evalJs(`dirty`);
  await exportJson();
  S.T4d_after_export_dirty = await evalJs(`dirty`);
  await b.clickSel('#shownow');
  S.T4e_after_export_then_toggle_dirty = await evalJs(`dirty`);
  await b.clickSel('#shownow');

  // T5: exported JSON identical regardless of the setting, same keys as before the change
  await fresh('09:10');
  const onJson = await exportJson();
  await b.clickSel('#shownow');
  const offJson = await exportJson();
  S.T5_export = {
    keysNow: keysOf(onJson), keysBefore: S.E0_export_keys_fresh,
    sameKeysAsBefore: JSON.stringify(keysOf(onJson)) === JSON.stringify(S.E0_export_keys_fresh),
    onEqualsOff: JSON.stringify(onJson) === JSON.stringify(offJson),
    equalsBeforeChangeExport: JSON.stringify(onJson) === JSON.stringify(exportA),
    textMentionsShow: /show|now/i.test(JSON.stringify(onJson)),
  };

  // T6: setting survives other actions (start OFF, repeat flows; then ON)
  for (const want of [false, true]) {
    await fresh('09:10');
    if (!want) await b.clickSel('#shownow');
    const tag = want ? 'ON' : 'OFF';
    const check = async name => { const d = await dom(); S[`T6_${tag}_${name}`] = { checkbox: d.checkbox, redLines: d.redLines, pills: d.pills, pillTexts: d.pillTexts, center: d.center, tables: d.tables, current: d.current, dirty: d.dirty }; };
    // select a block by clicking the slice
    const sl = await evalJs(`(() => { const e = document.querySelector('.slice[data-id="3"]'); const r = e.getBoundingClientRect(); const p = pt(117, 10 * 60 + 30); const s = document.querySelector('#clock').getBoundingClientRect(); return {x: s.x + p[0], y: s.y + p[1]}; })()`);
    await b.click(sl.x, sl.y); await check('select_block');
    // drag handle at 09:00 to 09:20
    const from = await b.minuteXY(540), to = await b.minuteXY(560);
    await b.drag(from, to);
    S[`T6_${tag}_drag_result`] = await evalJs(`({gongbu: blocks.find(x => x.id === 3).start, fmt: fmt(blocks.find(x => x.id === 3).start)})`);
    await check('drag_handle');
    // hover cursor over a handle and pointer-through of the pill
    const hv = await b.minuteXY(560);
    await b.mouse('mouseMoved', hv.x, hv.y);
    S[`T6_${tag}_hover`] = await evalJs(`(() => { const s = document.querySelector('#clock').getBoundingClientRect(); const el = document.elementFromPoint(${hv.x}, ${hv.y}); return {cls: el.getAttribute('class'), cursor: getComputedStyle(el).cursor}; })()`);
    // new table, switch back through the select
    await b.clickSel('#newt'); await check('new_table');
    await evalJs(`(() => { const s = document.querySelector('#tables'); s.value = store.tables[0].id; s.dispatchEvent(new Event('change')); })()`);
    await check('switch_table');
    // import example.json
    const doc = await b.send('DOM.getDocument', {});
    const q = await b.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#impfile' });
    await b.send('DOM.setFileInputFiles', { files: [exampleJson], nodeId: q.result.nodeId });
    await sleep(500);
    await check('import_example');
    S[`T6_${tag}_exceptions`] = [...b.st.exceptions];
    S[`T6_${tag}_dialogs`] = [...b.st.dialogs];
    await b.shot(`${out}-${tag.toLowerCase()}-after-flows.png`, null);
  }

  // T7: pill must not intercept pointer input (click on the pill selects the slice below; handle under a pill stays grabbable)
  await fresh('09:10');
  const pc = await evalJs(`(() => { const r = document.querySelector('#clock rect[fill="#d6343a"]').getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
  S.T7_elementFromPoint_at_pill_center = await evalJs(`(() => { const e = document.elementFromPoint(${pc.x}, ${pc.y}); return e.getAttribute('class') || e.tagName; })()`);
  await b.click(pc.x, pc.y);
  S.T7_click_on_pill_selected = await evalJs(`({sel, name: (blocks.find(x => x.id === sel) || {}).name})`);

  // T8: selected block center label
  await fresh('09:10');
  await b.clickSel('.row[data-id="3"]');
  S.T8_center_label_on = (await dom()).center;
  await b.shot(`${out}-on-selected-0910.png`, null);
  await b.clickSel('#shownow');
  S.T8_center_label_off = (await dom()).center;
  await b.shot(`${out}-off-selected-0910.png`, null);

  // narrow viewport: checkbox label wrapping
  await b.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: false });
  await fresh('09:10');
  await b.shot(`${out}-on-375px.png`, { x: 0, y: 0, width: 375, height: 380 });
}
R.exceptions = [...b.st.exceptions];
writeFileSync(`${out}-verify-result.json`, JSON.stringify(R, null, 2));
console.log(JSON.stringify(R, null, 2));
b.close();

import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [url, out, exampleJson, only] = process.argv.slice(2);
const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 9333 + Math.floor(Math.random() * 500);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-'))}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch {}
}
if (!target) { chrome.kill(); throw new Error('chrome did not start'); }

const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 1 << 28 });
await new Promise(r => ws.on('open', r));
let id = 0; const pending = new Map(); const waiters = []; let exceptions = []; let dialogs = [];
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Page.javascriptDialogOpening') { dialogs.push({ type: m.params.type, message: m.params.message }); send('Page.handleJavaScriptDialog', { accept: true }); }
  waiters.filter(w => w.method === m.method).forEach(w => w.resolve(m));
});
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const waitEvent = method => new Promise(resolve => waiters.push({ method, resolve }));
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;
const shot = async name => writeFileSync(`${out}-${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));

const KEYS = { Backspace: 8, Tab: 9, Enter: 13, ArrowUp: 38, ArrowDown: 40, End: 35 };
const key = async (k, text) => {
  const vk = KEYS[k];
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk, text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk });
  await sleep(80);
};
const typeText = async s => {
  for (const ch of s) {
    const up = ch.toUpperCase();
    const code = /\d/.test(ch) ? `Digit${ch}` : `Key${up}`;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: up.charCodeAt(0) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: up.charCodeAt(0) });
    await sleep(60);
  }
};
const mouse = (type, x, y, buttons = 0) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
const click = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 1); await mouse('mouseReleased', x, y, 0); await sleep(150); };
const center = sel => evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.x + 12}; })()`);
const clickSel = async (sel, atLeft = false) => { const c = await center(sel); if (!c) throw new Error('no element ' + sel); await click(atLeft ? c.left : c.x, c.y); };
const blur = () => clickSel('.hint');
const F = (rid, f) => `.row[data-id="${rid}"] [data-f=${f}]`;
const focusSeg = async (rid, f, seg) => { await clickSel(F(rid, f), true); for (let i = 0; i < seg; i++) await key('Tab'); }; // 0 = AM/PM, 1 = hour, 2 = minute
const minuteXY = (m, rad = 'R') => evalJs(`(() => { const s = document.querySelector('#clock'), p = s.createSVGPoint(); [p.x, p.y] = pt(${rad}, ${m}); const q = p.matrixTransform(s.getScreenCTM()); return {x: q.x, y: q.y}; })()`);

await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Browser.setDownloadBehavior', { behavior: 'deny' });
await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 940, deviceScaleFactor: 1, mobile: false });
await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Seoul' });

let scriptId = null;
const load = async (o) => {
  const { time = "2026-11-19T09:10:00+09:00", file = null, example = false } = o || {};
  if (scriptId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
  scriptId = (await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const T = ${Date.parse(time)}, R = Date; class D extends R { constructor(...a) { a.length ? super(...a) : super(T); } static now() { return T; } } window.Date = D; })();` })).result.identifier;
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url }); await loaded; await sleep(300);
  exceptions = []; dialogs = [];
  await evalJs(`window.__saved = []; window.__names = []; const o = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function() { const n = this.download; window.__names.push(n); window.__savedPending = fetch(this.href).then(r => r.text()).then(t => window.__saved.push({name: n, text: t})); return o.call(this); };`);
  if (file || example) await importFile(example ? exampleJson : join(HERE, 'files', file));
};
const importFile = async path => {
  const doc = await send('DOM.getDocument', {});
  const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#impfile' });
  await send('DOM.setFileInputFiles', { files: [path], nodeId: q.result.nodeId });
  await sleep(500);
};
const saveClick = async () => {
  await clickSel('#exp'); await sleep(400);
  await evalJs(`window.__savedPending`);
  const s = await evalJs(`window.__saved`);
  const last = s[s.length - 1] || {};
  let json = null; try { json = JSON.parse(last.text); } catch {}
  return { name: last.name, json, text: last.text };
};
const nowInfo = () => evalJs(`(() => {
  const svg = document.querySelector('#clock');
  const line = [...svg.querySelectorAll('line')].find(l => l.getAttribute('stroke') === '#e5484d');
  const pill = svg.querySelector('text.now');
  const rect = pill && pill.previousElementSibling;
  return { hasLine: !!line, lineStroke: line && line.getAttribute('stroke'), pillText: pill ? pill.textContent : null, pillFill: rect && rect.getAttribute('fill'),
    checkbox: {exists: !!document.querySelector('#shownow'), checked: document.querySelector('#shownow')?.checked, label: document.querySelector('#shownow')?.parentElement.textContent.trim()}, dirty };
})()`);
const rowsSnap = () => evalJs(`(() => {
  const rows = [...document.querySelectorAll('.row')];
  const nameOf = r => blocks.find(b => b.id === +r.dataset.id).name;
  const visual = rows.map(r => [r.getBoundingClientRect().top, r]).sort((a, b) => a[0] - b[0]).map(([, r]) => nameOf(r));
  const expected = [...blocks].sort((a, b) => a.start - b.start).map(b => b.name);
  return { visual: visual.join(','), expected: expected.join(','), visualMatchesStartOrder: visual.join() === expected.join(),
    timeBoxes: Object.fromEntries(rows.map(r => [nameOf(r), r.querySelector('[data-f=start]').value + '~' + r.querySelector('[data-f=end]').value])),
    msg: document.querySelector('#msg').textContent };
})()`);
const labels = () => evalJs(`[...document.querySelectorAll('#clock text.label')].map(t => t.textContent)`);
const take = async fn => {
  let r;
  try { r = await fn(); } catch (e) { r = { error: String(e) }; }
  r.exceptions = exceptions.splice(0); r.dialogs = dialogs.splice(0);
  return r;
};

const result = { url, locale: null, scenarios: {} };
const S = result.scenarios;
const run = async (name, opts, fn) => {
  if (only && !new RegExp(only).test(name)) return;
  await load(opts);
  if (!result.locale) result.locale = await evalJs(`({lang: navigator.language, hour12: new Intl.DateTimeFormat(navigator.language, {hour: 'numeric'}).resolvedOptions().hour12})`);
  S[name] = await take(fn);
};
const EX = { example: true };

await run('N1 now line, pill and checkbox at 09:10', EX, async () => {
  const on = await nowInfo(); await shot('N1-on');
  await clickSel('#shownow'); const off = await nowInfo(); const dirtyAfterOff = await evalJs('dirty'); await shot('N1-off');
  await clickSel('#shownow'); const on2 = await nowInfo();
  return { on, off, on2, dirtyAfterToggle: dirtyAfterOff };
});
await run('N2 checkbox off then reload: not remembered', EX, async () => {
  await clickSel('#shownow'); const off = await nowInfo();
  const loaded = waitEvent('Page.loadEventFired'); await send('Page.reload'); await loaded; await sleep(300);
  const afterReload = await nowInfo();
  return { off: off.checkbox, afterReload: afterReload.checkbox, hasLineAfterReload: afterReload.hasLine };
});
await run('N3 saved file does not contain the checkbox state', EX, async () => {
  await clickSel('#shownow'); const sv = await saveClick();
  return { name: sv.name, topKeys: Object.keys(sv.json || {}), tableKeys: Object.keys(sv.json?.tables?.[0] || {}), blockKeys: Object.keys(sv.json?.tables?.[0]?.blocks?.[0] || {}), hasShowNow: /shownow|showNow|현재/.test(sv.text || '') };
});
await run('N4 pill text at several times (clean spot check)', null, async () => {
  const r = {};
  for (const t of ['2026-11-19T10:30:00+09:00', '2026-11-19T14:20:00+09:00', '2026-11-19T00:05:00+09:00', '2026-11-19T23:59:00+09:00']) {
    await load({ time: t, example: true }); r[t] = (await nowInfo()).pillText;
  }
  return r;
});

await run('F1 export file name uses the local date (00:30 KST = 15:30 UTC on the 18th)', { time: '2026-11-19T00:30:00+09:00' }, async () => {
  const before = await evalJs(`document.body.innerText`); const domBefore = await evalJs(`document.body.querySelectorAll('*').length`);
  const sv = await saveClick();
  const after = await evalJs(`document.body.innerText`); const domAfter = await evalJs(`document.body.querySelectorAll('*').length`);
  return { name: sv.name, utcDate: new Date(Date.parse('2026-11-19T00:30:00+09:00')).toISOString().slice(0, 10), msgAfter: await evalJs(`document.querySelector('#msg').textContent`), bodyTextUnchanged: before === after, domCountUnchanged: domBefore === domAfter, dirtyAfter: await evalJs('dirty') };
});
await run('F2 saved file shape matches the README block, empty detail line is not saved', EX, async () => {
  await clickSel(F(4, "name")); // 오전 업무 선택
  await clickSel('.row.sel [data-addd]'); // 빈 세부사항 줄이 생기고 포커스가 들어감
  const mid = await evalJs(`blocks.find(b => b.name === '오전 업무').details`);
  const sv = await saveClick();
  const t0 = sv.json?.tables?.[0];
  return { detailsInMemoryAtSave: mid, savedName: sv.name, topKeys: Object.keys(sv.json || {}), version: sv.json?.version, tableCount: sv.json?.tables?.length, firstBlockKeys: Object.keys(t0?.blocks?.[0] || {}), savedDetailsOfOfficeBlock: t0?.blocks?.find(b => b.name === '오전 업무')?.details, anyEmptyDetailInFile: JSON.stringify(sv.json).includes('""') };
});

await run('L1 leaving the page with unsaved changes: no warning', EX, async () => {
  await clickSel(F(2, 'name')); await key('End'); await send('Input.insertText', { text: 'x' }); await blur();
  const dirtyBefore = await evalJs('dirty');
  const ev = await evalJs(`(() => { const e = new Event('beforeunload', {cancelable: true}); window.dispatchEvent(e); return {defaultPrevented: e.defaultPrevented, returnValue: e.returnValue, onbeforeunload: String(window.onbeforeunload)}; })()`);
  const loaded = waitEvent('Page.loadEventFired'); await send('Page.navigate', { url: 'about:blank' }); await loaded; await sleep(300);
  return { dirtyBefore, ev, navigatedTo: await evalJs('location.href') };
});

await run('D1 empty detail line disappears on blur', EX, async () => {
  await clickSel(F(4, "name"));
  const before = await evalJs(`document.querySelectorAll('.row.sel .d').length`);
  await clickSel('.row.sel [data-addd]');
  const afterAdd = await evalJs(`({lines: document.querySelectorAll('.row.sel .d').length, focusedIsDetail: document.activeElement.dataset.d})`);
  await shot('D1-empty-line'); await blur(); await sleep(200);
  const afterBlur = await evalJs(`({lines: document.querySelectorAll('.row.sel .d').length, mem: blocks.find(b => b.name === '오전 업무').details})`);
  return { before, afterAdd, afterBlur };
});
await run('D2 Enter in a detail line adds the next line; typed-then-cleared line also disappears', EX, async () => {
  await clickSel(F(4, "name"));
  await clickSel('.row.sel [data-d="0"]'); await key('Enter');
  const afterEnter = await evalJs(`({lines: document.querySelectorAll('.row.sel .d').length, focusedIdx: document.activeElement.dataset.d, focusedValue: document.activeElement.value})`);
  await typeText('ab'); await key('Backspace'); await key('Backspace');
  const typedCleared = await evalJs(`({lines: document.querySelectorAll('.row.sel .d').length, mem: blocks.find(b => b.name === '오전 업무').details})`);
  await blur(); await sleep(200);
  return { afterEnter, typedCleared, afterBlur: await evalJs(`({lines: document.querySelectorAll('.row.sel .d').length, mem: blocks.find(b => b.name === '오전 업무').details})`) };
});

await run('R1 typing: 잠 start 23:00 -> hour ArrowUp -> 00:00, list re-sorts without blur', EX, async () => {
  const before = await rowsSnap();
  await focusSeg(1, 'start', 1);
  const focusStart = await evalJs(`document.activeElement.dataset.f + ' ' + document.activeElement.closest('.row').dataset.id`);
  await key('ArrowUp'); const after = await rowsSnap();
  const stillFocused = await evalJs(`document.activeElement.dataset.f`);
  await shot('R1-after-hour-ArrowUp');
  return { before, focusStart, after, stillFocused };
});
await run('R2 drag: shared handle 23:00 dragged across 00:00 with the real mouse', EX, async () => {
  const before = await rowsSnap();
  const p0 = await minuteXY(1380);
  await mouse('mouseMoved', p0.x, p0.y); await mouse('mousePressed', p0.x, p0.y, 1);
  const moves = [];
  for (const m of [1410, 1439, 0, 30]) { const p = await minuteXY(m); await mouse('mouseMoved', p.x, p.y, 1); await sleep(80); moves.push({ to: m, ...(await rowsSnap()) }); }
  const pe = await minuteXY(30); await mouse('mouseReleased', pe.x, pe.y, 0); await sleep(100);
  return { before, moves, afterRelease: await rowsSnap() };
});
await run('R3 time box: clear the hour, click elsewhere, old time comes back', EX, async () => {
  const before = await evalJs(`document.querySelector('${F(2, 'start')}').value`);
  await focusSeg(2, 'start', 1);
  await key('Backspace');
  const cleared = await evalJs(`document.querySelector('${F(2, 'start')}').value`);
  await blur(); await sleep(200);
  const after = await evalJs(`document.querySelector('${F(2, 'start')}').value`);
  const mem = await evalJs(`fmt(blocks.find(b => b.id === 2).start)`);
  return { before, valueWhileCleared: cleared, after, mem };
});

await run('U1 10 minute unit: typed minute 05 is rounded', EX, async () => {
  await focusSeg(2, 'start', 2);
  await typeText('05');
  await blur(); await sleep(200);
  return { value: await evalJs(`document.querySelector('${F(2, 'start')}').value`), mem: await evalJs(`fmt(blocks.find(b => b.id === 2).start)`), stepAttr: await evalJs(`document.querySelector('${F(2, 'start')}').step`) };
});
await run('U2 push neighbour with end-minute ArrowUp (10 min steps), refuse when neighbour < 10 min, circle label hidden under 40 min', EX, async () => {
  const steps = [];
  await focusSeg(4, 'end', 2); // 오전 업무 end 12:00 minute segment
  for (let i = 1; i <= 7; i++) {
    await key('ArrowUp');
    const s = await rowsSnap();
    const lab = await labels();
    steps.push({ i, office: s.timeBoxes['오전 업무'], lunch: s.timeBoxes['점심'], msg: s.msg, lunchLabelOnCircle: lab.includes('점심') });
  }
  await shot('U2-after-steps');
  return { steps };
});
await run('U2b typing: 오전 업무 end hour ArrowUp 12:00 -> 13:00 would erase 점심, refused', EX, async () => {
  await focusSeg(4, 'end', 1); await key('ArrowUp');
  await shot('U2b-refused');
  const s = await rowsSnap();
  return { office: s.timeBoxes['오전 업무'], lunch: s.timeBoxes['점심'], msg: s.msg, msgColor: await evalJs(`getComputedStyle(document.querySelector('#msg')).color`) };
});
await run('U2c drag: handle 13:00 (점심 end, 오후 업무 start) pulled back toward 12:00; 점심 can shrink to 10 min and no further', EX, async () => {
  const p0 = await minuteXY(780);
  await mouse('mouseMoved', p0.x, p0.y); await mouse('mousePressed', p0.x, p0.y, 1);
  const moves = [];
  for (const m of [770, 750, 730, 725, 720]) { const p = await minuteXY(m); await mouse('mouseMoved', p.x, p.y, 1); await sleep(80); const s = await rowsSnap(); moves.push({ to: m, lunch: s.timeBoxes['점심'], afternoon: s.timeBoxes['오후 업무'], msg: s.msg }); }
  const pe = await minuteXY(720); await mouse('mouseReleased', pe.x, pe.y, 0);
  return { moves };
});
await run('U3 add: fills widest gap, up to 1 hour; shorter when the gap is shorter; no free time message', null, async () => {
  const a = await (async () => { await clickSel('#add'); return evalJs(`(() => { const b = blocks.at(-1); return {name: b.name, start: fmt(b.start), end: fmt(b.end), blocks: blocks.length}; })()`); })();
  await load({ example: true });
  const full = await (async () => { await clickSel('#add'); return evalJs(`({msg: document.querySelector('#msg').textContent, blocks: blocks.length})`); })();
  await focusSeg(1, 'start', 2); await key('ArrowUp'); // 잠 start 23:00 -> 23:10, leaves a 10 minute gap
  const gapMsg = await evalJs(`document.querySelector('#msg').textContent`);
  await blur(); await clickSel('#add');
  const short = await evalJs(`(() => { const b = blocks.at(-1); return {name: b.name, start: fmt(b.start), end: fmt(b.end), blocks: blocks.length}; })()`);
  return { defaultTableAdd: a, fullDayAdd: full, gapMsg, tenMinuteGapAdd: short };
});
await run('U4 single table cannot be deleted; new table is empty; copy; name limits', null, async () => {
  await clickSel('#delt'); const msg1 = await evalJs(`document.querySelector('#msg').textContent`);
  await clickSel('#newt'); const newT = await evalJs(`({tables: store.tables.length, blocks: blocks.length, name: cur.name})`);
  await clickSel('#copyt'); const copy = await evalJs(`({tables: store.tables.length, name: cur.name})`);
  const attrs = await evalJs(`({tname: document.querySelector('#tname').maxLength, blockName: document.querySelector('.row [data-f=name]')?.maxLength})`);
  await load({ example: true });
  const attrs2 = await evalJs(`({blockName: document.querySelector('.row [data-f=name]').maxLength})`);
  await clickSel(F(2, 'name')); await send('Input.insertText', { text: '가나다라마바사아자차카타파하' });
  const typed = await evalJs(`document.querySelector('${F(2, 'name')}').value.length`);
  await clickSel('#tname'); await key('End'); await send('Input.insertText', { text: '가나다라마바사아자차카타파하가나다라마바사아자차' });
  const typedT = await evalJs(`document.querySelector('#tname').value.length`);
  const circleLabel = await labels();
  return { msgSingleTableDelete: msg1, newT, copy, attrs, attrs2, blockNameLenAfterInsert14More: typed, tableNameLenAfterInsertLong: typedT, circleLabelsAre7CharsMax: circleLabel };
});
await run('U5 select by clicking a slice with the real mouse shows details; clicking a row selects too', EX, async () => {
  const p = await minuteXY(630, '(R + r) / 2'); await click(p.x, p.y);
  const bySlice = await evalJs(`({sel: document.querySelector('.row.sel')?.querySelector('[data-f=name]').value, center: [...document.querySelectorAll('#clock text.center')].map(t => t.textContent), detailsVisible: getComputedStyle(document.querySelector('.row.sel .details')).display})`);
  return { bySlice };
});

const imp = async (name, file, preDirty = false) => run(name, EX, async () => {
  if (preDirty) { await clickSel(F(2, 'name')); await key('End'); await send('Input.insertText', { text: 'x' }); await blur(); }
  dialogs.length = 0;
  await importFile(join(HERE, 'files', file));
  return { tables: await evalJs(`store.tables.map(t => t.name)`), dirtyAfter: await evalJs('dirty'), shown: await evalJs(`document.querySelector('#tname').value`) };
});
await imp('I1 import: only off-step time (5 min) table', 'off-only.json');
await imp('I2 import: mixed (good, off-step, overlap, bad color)', 'mixed.json');
await imp('I3 import: overlap only', 'overlap-only.json');
await imp('I4 import: not JSON', 'notjson.json');
await imp('I5 import: empty file', 'empty.json');
await imp('I6 import: no tables', 'no-tables.json');
await run('I7 import while dirty asks first, not dirty does not', EX, async () => {
  await importFile(join(HERE, 'files', 'mixed.json')); const clean = { dialogs: dialogs.splice(0) };
  await clickSel(F(1, 'name')); await key('End'); await send('Input.insertText', { text: 'x' }); await blur();
  dialogs.length = 0;
  await importFile(join(HERE, 'files', 'mixed.json'));
  return { cleanImportDialogs: clean.dialogs, dirtyImportDialogs: dialogs.slice(), dirtyAfter: await evalJs('dirty') };
});

result.chromeVersion = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).Browser;
writeFileSync(`${out}-result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
ws.close(); chrome.kill();

import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [url, out, only] = process.argv.slice(2);
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
  if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); send('Page.handleJavaScriptDialog', { accept: true }); }
  waiters.filter(w => w.method === m.method).forEach(w => w.resolve(m));
});
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const waitEvent = method => new Promise(resolve => waiters.push({ method, resolve }));
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;
const shot = async name => writeFileSync(`${out}-${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));

const KEYS = { Backspace: 8, Tab: 9, Enter: 13, ArrowUp: 38, ArrowDown: 40, End: 35 };
const key = async (k, shift = false) => {
  const vk = KEYS[k], modifiers = shift ? 8 : 0;
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk, modifiers });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk, modifiers });
  await sleep(80);
};
const typeText = async s => {
  for (const ch of s) {
    const up = ch.toUpperCase();
    const code = /\d/.test(ch) ? `Digit${ch}` : `Key${up}`;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: up.charCodeAt(0) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: up.charCodeAt(0) });
    await sleep(80);
  }
};
const mouse = (type, x, y, buttons = 0) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
const click = async (x, y) => { await mouse('mousePressed', x, y, 1); await mouse('mouseReleased', x, y, 0); await sleep(150); };
const center = sel => evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.x + 12}; })()`);
const clickSel = async (sel, atLeft = false) => { const c = await center(sel); if (!c) throw new Error('no element ' + sel); await click(atLeft ? c.left : c.x, c.y); };
const blur = () => clickSel('.hint');
const F = (rid, f) => `.row[data-id="${rid}"] [data-f=${f}]`;
const focusSeg = async (rid, f, seg) => { await clickSel(F(rid, f), true); for (let i = 0; i < seg; i++) await key('Tab'); }; // seg 0 = AM/PM, 1 = hour, 2 = minute (ko-KR 12h)
const minuteXY = m => evalJs(`(() => { const s = document.querySelector('#clock'), p = s.createSVGPoint(); [p.x, p.y] = pt(R, ${m}); const q = p.matrixTransform(s.getScreenCTM()); return {x: q.x, y: q.y}; })()`);

await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 940, deviceScaleFactor: 1, mobile: false });

const load = async (file) => {
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url }); await loaded; await sleep(300);
  exceptions = []; dialogs = [];
  await evalJs(`window.__ev = []; for (const t of ['focusin', 'focusout', 'change']) document.addEventListener(t, e => window.__ev.push(t + ':' + (e.target.dataset ? (e.target.dataset.f || (e.target.dataset.d !== undefined ? 'detail' : e.target.tagName)) : '?')), true);`);
  if (file) {
    const doc = await send('DOM.getDocument', {});
    const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#impfile' });
    await send('DOM.setFileInputFiles', { files: [join(HERE, 'files', file)], nodeId: q.result.nodeId });
    await sleep(400);
  }
};
const events = () => evalJs(`window.__ev.splice(0).join(' ')`);

const snap = () => evalJs(`(() => {
  const ae = document.activeElement, rows = [...document.querySelectorAll('.row')];
  const nameOf = r => blocks.find(b => b.id === +r.dataset.id).name;
  const visual = rows.map(r => [r.getBoundingClientRect().top, r]).sort((a, b) => a[0] - b[0]).map(([, r]) => nameOf(r)).join(',');
  const expected = [...blocks].sort((a, b) => a.start - b.start).map(b => b.name).join(',');
  const row = ae.closest && ae.closest('.row');
  return {
    visual, dom: rows.map(nameOf).join(','), expected, visualMatchesStartOrder: visual === expected,
    starts: Object.fromEntries(blocks.map(b => [b.name, fmt(b.start)])),
    timeBoxes: Object.fromEntries(rows.map(r => [nameOf(r), r.querySelector('[data-f=start]').value + '~' + r.querySelector('[data-f=end]').value])),
    focus: row ? nameOf(row) + ' / ' + (ae.dataset.f || (ae.dataset.d !== undefined ? 'detail#' + ae.dataset.d + ' ' + JSON.stringify(ae.value) : ae.tagName)) : ae.tagName,
    sameFocusedNode: !!ae.__mark,
    msg: document.querySelector('#msg').textContent,
  };
})()`);
const mark = () => evalJs(`document.activeElement.__mark = true`);

const take = async fn => {
  let r;
  try { r = await fn(); } catch (e) { r = { error: String(e) }; }
  r.exceptions = exceptions.splice(0);
  return r;
};
const result = { url, locale: null, scenarios: {} };
const S = result.scenarios;
const run = async (name, file, fn) => {
  if (only && !new RegExp(only).test(name)) return;
  await load(file);
  if (!result.locale) result.locale = await evalJs(`({lang: navigator.language, hour12: new Intl.DateTimeFormat(navigator.language, {hour: 'numeric'}).resolvedOptions().hour12})`);
  S[name] = await take(fn);
};

// default table ids: 잠1 아침2 공부3 점심4 놀기5 저녁6.  T3 ids: 새벽1 오전2 밤3.  T4 ids: A저녁1 B밤2 C낮3.
run.layout = 0;
await run('S0 initial layout (rects of first row, last row, #add)', null, async () => ({
  snap: await snap(),
  rects: await evalJs(`(() => { const rs = [...document.querySelectorAll('.row')], q = e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(v => Math.round(v * 10) / 10); }; return {first: q(rs[0]), last: q(rs.at(-1)), add: q(document.querySelector('#add')), list: q(document.querySelector('#list'))}; })()`),
}));

await run('S1a default: 잠 start hour ArrowUp x3 (22:30 -> ?)', null, async () => {
  await focusSeg(1, 'start', 1); await mark();
  const steps = [{ before: await snap() }];
  for (let i = 0; i < 3; i++) { await key('ArrowUp'); steps.push({ i: i + 1, ...(await snap()), events: await events() }); }
  return { steps };
});

await run('S1b T3: 밤 start hour ArrowUp (23:00 -> 00:00) then minute ArrowUp, keys on segments', 'T3.json', async () => {
  const before = await snap();
  await focusSeg(3, 'start', 1); await mark(); await events();
  await key('ArrowUp'); const afterHour = { ...(await snap()), events: await events() };
  await shot('S1b-after-hour-ArrowUp');
  await key('Tab'); await key('ArrowUp'); const afterMinuteUp = { ...(await snap()), events: await events() };
  return { before, afterHour, afterMinuteUp };
});

await run('S2 T3: 밤 start AM/PM ArrowUp, hour typed "12", then ArrowUp (acts on the minute segment if focus stayed there)', 'T3.json', async () => {
  const before = await snap();
  await focusSeg(3, 'start', 0); await mark(); await events();
  await key('ArrowUp'); const afterAmPm = { ...(await snap()), events: await events() };
  await key('Tab');
  await typeText('1'); const afterDigit1 = { ...(await snap()), events: await events() };
  await typeText('2'); const afterDigit2 = { ...(await snap()), events: await events() };
  await key('ArrowUp'); const afterMinuteArrowUp = { ...(await snap()), events: await events() };
  await shot('S2-after-typing');
  await blur(); const afterBlur = await snap();
  return { before, afterAmPm, afterDigit1, afterDigit2, afterMinuteArrowUp, afterBlur, expectedFinalValue: '00:10' };
});

await run('S3 default: drag 잠 start handle 22:30 -> 23:30 -> 00:30 -> 01:00 (real mouse moves)', null, async () => {
  const before = await snap();
  const p0 = await minuteXY(1350);
  await mouse('mouseMoved', p0.x, p0.y); await mouse('mousePressed', p0.x, p0.y, 1);
  const moves = [];
  for (const m of [1380, 1410, 1439 + 1, 30, 60]) {
    const p = await minuteXY(m % 1440);
    await mouse('mouseMoved', p.x, p.y, 1); await sleep(80);
    moves.push({ to: fmt0(m % 1440), ...(await snap()) });
  }
  await mouse('mouseReleased', (await minuteXY(60)).x, (await minuteXY(60)).y, 0); await sleep(100);
  const afterRelease = await snap();
  await shot('S3-after-release');
  return { before, moves, afterRelease };
});
function fmt0(m) { return String(m / 60 | 0).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }

await run('S3b default: focus in 잠 name input, drag its start handle across 00:00', null, async () => {
  await clickSel(F(1, 'name')); await mark(); await events();
  const before = await snap();
  const p0 = await minuteXY(1350);
  await mouse('mouseMoved', p0.x, p0.y); await mouse('mousePressed', p0.x, p0.y, 1);
  const afterPress = { ...(await snap()), events: await events() };
  for (const m of [1380, 1410, 0, 30]) { const p = await minuteXY(m); await mouse('mouseMoved', p.x, p.y, 1); await sleep(80); }
  const afterDrag = { ...(await snap()), events: await events() };
  const pe = await minuteXY(30); await mouse('mouseReleased', pe.x, pe.y, 0); await sleep(100);
  await typeText('X');
  return { before, afterPress, afterDrag, afterTypingX: { ...(await snap()), name1: await evalJs(`blocks.find(b => b.id === 1).name`) } };
});

await run('S3c default: focus in a detail input of 잠 ("abc"), drag across 00:00, then type "d"', null, async () => {
  await clickSel(F(1, 'name')); await clickSel('.row.sel [data-addd]'); await typeText('abc'); await mark(); await events();
  const before = await snap();
  const p0 = await minuteXY(1350);
  await mouse('mouseMoved', p0.x, p0.y); await mouse('mousePressed', p0.x, p0.y, 1);
  for (const m of [1380, 1410, 0, 30]) { const p = await minuteXY(m); await mouse('mouseMoved', p.x, p.y, 1); await sleep(80); }
  const pe = await minuteXY(30); await mouse('mouseReleased', pe.x, pe.y, 0); await sleep(150);
  const afterDrag = { ...(await snap()), events: await events() };
  await typeText('d');
  return { before, afterDrag, afterTypingD: await snap(), details: await evalJs(`blocks.find(b => b.id === 1).details`) };
});

await run('S3d T4: drag shared handle 23:00 (A저녁 end + B밤 start) to 00:30', 'T4.json', async () => {
  const before = await snap();
  const p0 = await minuteXY(1380);
  await mouse('mouseMoved', p0.x, p0.y); await mouse('mousePressed', p0.x, p0.y, 1);
  const moves = [];
  for (const m of [1410, 0, 30]) { const p = await minuteXY(m); await mouse('mouseMoved', p.x, p.y, 1); await sleep(80); moves.push({ to: fmt0(m), ...(await snap()) }); }
  const pe = await minuteXY(30); await mouse('mouseReleased', pe.x, pe.y, 0); await sleep(100);
  return { before, moves, afterRelease: await snap() };
});

await run('S4 default: change END only (공부 end hour ArrowDown 12:00 -> 11:00)', null, async () => {
  const before = await snap();
  await focusSeg(3, 'end', 1); await mark(); await key('ArrowDown');
  return { before, after: await snap() };
});

await run('S5 default: 잠 (start 1350) sorts last; change 잠 end (07:00 -> 06:00) keeps it last', null, async () => {
  const before = await snap();
  await focusSeg(1, 'end', 1); await key('ArrowDown');
  return { before, after: await snap() };
});

await run('S6 default: rejected edit (공부 start hour ArrowDown x2 into 아침) then click elsewhere', null, async () => {
  const before = await snap();
  await focusSeg(3, 'start', 1); await mark(); await key('ArrowDown'); const afterOk = await snap();
  await key('ArrowDown'); const afterReject = await snap();
  await shot('S6-after-reject');
  await blur();
  return { before, afterFirstDown: afterOk, afterRejected: afterReject, afterBlur: await snap() };
});

await run('S7 default: add then delete blocks', null, async () => {
  const before = await snap();
  await clickSel('#add'); const afterAdd = await snap();
  await clickSel('.row[data-id="3"] [data-del]'); const afterDelete = await snap();
  return { before, afterAdd, afterDelete };
});

await run('S7b T3: after a reorder, add a block and delete another (renderList rebuild must still sort)', 'T3.json', async () => {
  await focusSeg(3, 'start', 1); await key('ArrowUp'); await blur();
  const afterReorder = await snap();
  await clickSel('#add'); const afterAdd = await snap();
  await clickSel('.row[data-id="2"] [data-del]'); const afterDelete = await snap();
  await clickSel('#copyt'); const afterCopyTable = await snap();
  return { afterReorder, afterAdd, afterDelete, afterCopyTable };
});

await run('S8 T3: detail "keepme" typed in 새벽, then 밤 start edit reorders; details intact', 'T3.json', async () => {
  await clickSel(F(1, 'name')); await clickSel('.row.sel [data-addd]'); await typeText('keepme');
  await clickSel(F(2, 'name')); await clickSel('.row.sel [data-addd]'); await typeText('also');
  const before = await snap();
  await focusSeg(3, 'start', 0); await key('ArrowUp'); await key('Tab'); await typeText('1'); await typeText('2');
  const after = await snap();
  return { before, after, details: await evalJs(`blocks.map(b => [b.name, b.details])`), detailInputs: await evalJs(`[...document.querySelectorAll('.row')].map(r => [r.querySelector('[data-f=name]').value, [...r.querySelectorAll('[data-d]')].map(i => i.value)])`) };
});

await run('S9 T3: Tab order after the 밤 row moves to the top', 'T3.json', async () => {
  await focusSeg(3, 'start', 1); await key('ArrowUp'); // 밤 23:00 -> 00:00, first by start
  const afterReorder = await snap();
  await blur();
  const stop = () => evalJs(`(() => { const ae = document.activeElement, r = ae.closest('.row'); return r ? blocks.find(b => b.id === +r.dataset.id).name + '/' + (ae.dataset.f || (ae.dataset.del !== undefined ? 'del' : ae.dataset.addd !== undefined ? 'addd' : ae.tagName)) : ae.id || ae.tagName; })()`);
  await clickSel(F(3, 'name'));
  const forward = [await stop()];
  for (let i = 0; i < 40; i++) { await key('Tab'); forward.push(await stop()); }
  await clickSel(F(1, 'name'));
  const back = [await stop()];
  for (let i = 0; i < 12; i++) { await key('Tab', true); back.push(await stop()); }
  const dedupe = a => a.filter((v, i) => v !== a[i - 1]);
  return { afterReorder, tabForwardFromFirstVisualRowName: dedupe(forward), shiftTabFromSecondVisualRowName: dedupe(back) };
});

await run('S10 default: clear start box (3 segments) then click elsewhere restores it (#3)', null, async () => {
  await focusSeg(3, 'start', 0);
  for (let sg = 0; sg < 3; sg++) { if (sg) await key('Tab'); await key('Backspace'); }
  const whileEditing = await snap(); await blur();
  return { whileEditing, afterBlur: await snap() };
});
await run('S10b T3: after a reorder, clear 새벽 start box then click elsewhere restores it', 'T3.json', async () => {
  await focusSeg(3, 'start', 0); await key('ArrowUp'); await key('Tab'); await key('ArrowUp'); await blur();
  const afterReorder = await snap();
  await focusSeg(1, 'start', 0);
  for (let sg = 0; sg < 3; sg++) { if (sg) await key('Tab'); await key('Backspace'); }
  await blur();
  return { afterReorder, afterBlur: await snap() };
});

await run('S11 default: empty detail line is swept after click elsewhere (#5)', null, async () => {
  await clickSel(F(3, 'name')); await clickSel('.row.sel [data-addd]');
  const afterAdd = await snap(); await blur();
  return { afterAdd, afterBlur: await snap(), details: await evalJs(`blocks.find(b => b.id === 3).details`), emptyLines: await evalJs(`document.querySelectorAll('.d').length`) };
});
await run('S11b T3: empty detail line in 새벽 focused while 밤 start is reordered by drag', 'T3.json', async () => {
  await clickSel(F(1, 'name')); await clickSel('.row.sel [data-addd]'); await mark();
  const before = await snap();
  const p0 = await minuteXY(1380);
  await mouse('mouseMoved', p0.x, p0.y); await mouse('mousePressed', p0.x, p0.y, 1);
  for (const m of [1410, 0, 30]) { const p = await minuteXY(m); await mouse('mouseMoved', p.x, p.y, 1); await sleep(80); }
  const pe = await minuteXY(30); await mouse('mouseReleased', pe.x, pe.y, 0); await sleep(300);
  return { before, afterDragAndSweep: await snap(), details: await evalJs(`blocks.find(b => b.id === 1).details`) };
});

await run('S12 default: non-reordering time edit mutates how much DOM? (공부 start hour ArrowUp)', null, async () => {
  await evalJs(`window.__mut = {childList: 0, attributes: 0}; new MutationObserver(rs => rs.forEach(r => window.__mut[r.type]++)).observe(document.querySelector('#list'), {childList: true, attributes: true, subtree: true, attributeFilter: ['style']});`);
  await focusSeg(3, 'start', 1); await mark(); await key('ArrowUp'); await sleep(100);
  return { after: await snap(), mutations: await evalJs(`window.__mut`) };
});

await run('S13 default: cost of the one keystroke that crosses 00:00 (잠 start 23:30 -> 00:30): DOM mutations and focus events', null, async () => {
  await focusSeg(1, 'start', 1); await mark(); await key('ArrowUp'); await events();
  await evalJs(`window.__mut = {childList: 0, attributes: 0}; window.__rec = []; new MutationObserver(rs => rs.forEach(r => { window.__mut[r.type]++; })).observe(document.querySelector('#list'), {childList: true, attributes: true, subtree: true, attributeFilter: ['style']});`);
  await key('ArrowUp'); await sleep(100);
  return { after: await snap(), mutations: await evalJs(`window.__mut`), events: await events() };
});

writeFileSync(`${out}-result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1));
ws.close(); chrome.kill();

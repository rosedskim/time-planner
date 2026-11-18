import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, out, exampleJson] = process.argv.slice(2);
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

const KEYS = { Backspace: [8, ''], Enter: [13, '\r'], End: [35, ''] };
const key = async k => {
  const [vk, text] = KEYS[k];
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code: k, text, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk });
  await sleep(80);
};
const typeText = async s => { await send('Input.insertText', { text: s }); await sleep(80); };
const click = async (x, y, hold = 0) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  if (hold) await sleep(hold);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(150);
};
const center = sel => evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.x + 12}; })()`);
const clickSel = async (sel, hold = 0, atLeft = false) => {
  const c = await center(sel);
  if (!c) throw new Error('no element ' + sel);
  await click(atLeft ? c.left : c.x, c.y, hold);
};
const blur = () => clickSel('.hint');

await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Browser.setDownloadBehavior', { behavior: 'deny' });
await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 940, deviceScaleFactor: 1, mobile: false });

const load = async () => {
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url }); await loaded; await sleep(300);
  exceptions = []; dialogs = [];
  await evalJs(`window.__saved = []; const o = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function() { const n = this.download; window.__savedPending = fetch(this.href).then(r => r.text()).then(t => window.__saved.push({name: n, text: t})); return o.call(this); };`);
};
const snap = () => evalJs(`(() => {
  const ae = document.activeElement, row = document.querySelector('.row.sel');
  return {
    rows: document.querySelectorAll('.row').length,
    sel,
    details: blocks.filter(b => b.details !== undefined).map(b => [b.id, b.details]),
    domLines: row ? [...row.querySelectorAll('.d')].map(d => ({ d: d.querySelector('[data-d]').dataset.d, del: d.querySelector('[data-deld]').dataset.deld, v: d.querySelector('[data-d]').value })) : null,
    focus: ae.dataset.d !== undefined ? 'detail#' + ae.dataset.d + ' value=' + JSON.stringify(ae.value) : ae.dataset.f ? 'f=' + ae.dataset.f : ae.dataset.addd !== undefined ? 'addd button' : ae.tagName,
    dirty,
  };
})()`);
const saved = async () => {
  await evalJs(`window.__savedPending`);
  const s = await evalJs(`window.__saved`);
  return s.map(x => ({ name: x.name, blocks: JSON.parse(x.text).tables.map(t => t.blocks.map(b => ({ name: b.name, details: b.details }))) }));
};
const take = async fn => {
  await load();
  let r;
  try { r = await fn(); } catch (e) { r = { error: String(e) }; }
  r.exceptions = exceptions.splice(0);
  return r;
};

const SEL = id => `.row[data-id="${id}"] [data-f=name]`;
const ADD = '.row.sel [data-addd]';
const LINE = i => `.row.sel [data-d="${i}"]`;
const DEL = i => `.row.sel [data-deld="${i}"]`;
const result = { url, scenarios: {} };
const S = result.scenarios;

S['S1 add detail, leave empty, click elsewhere'] = await take(async () => {
  await clickSel(SEL(3)); await clickSel(ADD);
  const afterAdd = await snap(); await shot('S1-1-empty-line-focused');
  await blur();
  const afterBlur = await snap(); await shot('S1-2-after-click-elsewhere');
  return { afterAdd, afterBlur };
});

S['S2 add detail, type text, click elsewhere'] = await take(async () => {
  await clickSel(SEL(3)); await clickSel(ADD); await typeText('abc');
  const typed = await snap(); await blur();
  return { typed, afterBlur: await snap() };
});

S['S3 Enter on empty line twice, click elsewhere'] = await take(async () => {
  await clickSel(SEL(3)); await clickSel(ADD);
  await key('Enter'); const afterEnter1 = await snap();
  await key('Enter'); const afterEnter2 = await snap();
  await blur();
  return { afterEnter1, afterEnter2, afterBlur: await snap() };
});

for (const hold of [0, 200]) {
  S[`S4 empty line focused, click + 세부사항 (mouse hold ${hold}ms)`] = await take(async () => {
    await clickSel(SEL(3)); await clickSel(ADD);
    const before = await snap();
    await clickSel(ADD, hold);
    return { before, afterClick: await snap() };
  });
  S[`S4b non-empty line then empty line focused, click + 세부사항 (hold ${hold}ms)`] = await take(async () => {
    await clickSel(SEL(3)); await clickSel(ADD); await typeText('a'); await key('Enter');
    const before = await snap();
    await clickSel(ADD, hold);
    return { before, afterClick: await snap() };
  });
}

const build3 = async () => {
  await clickSel(SEL(3)); await clickSel(ADD);
  await typeText('one'); await key('Enter'); await typeText('two'); await key('Enter'); await typeText('three');
  await clickSel(LINE(1)); await key('End'); for (let i = 0; i < 3; i++) await key('Backspace');
  return snap();
};
S['S5a empty middle line focused, click x on the last line (hold 200ms)'] = await take(async () => {
  const before = await build3();
  await clickSel(DEL(2), 200);
  return { before, afterClick: await snap() };
});
S['S5b empty middle line focused, click x on the first line (hold 200ms)'] = await take(async () => {
  const before = await build3();
  await clickSel(DEL(0), 200);
  return { before, afterClick: await snap() };
});
S['S5c empty middle line blurred to the name input, then click x on the line "three"'] = await take(async () => {
  const before = await build3();
  await clickSel(SEL(3));
  const afterBlur = await snap();
  const idx = await evalJs(`[...document.querySelectorAll('.row.sel .d')].findIndex(d => d.querySelector('[data-d]').value === 'three')`);
  await clickSel(`.row.sel .d:nth-of-type(${idx + 1}) [data-deld]`, 200);
  return { before, afterBlur, indexOfThreeBeforeDelete: idx, afterClick: await snap() };
});

S['S8 empty line focused, click + 일정 추가 (hold 200ms)'] = await take(async () => {
  await clickSel(SEL(3)); await clickSel(ADD);
  const before = await snap();
  await clickSel('#add', 200);
  return { before, afterClick: await snap(), rows3Details: await evalJs(`blocks.find(b => b.id === 3).details`) };
});
S['S9 empty line focused, click the name input of another row'] = await take(async () => {
  await clickSel(SEL(3)); await clickSel(ADD);
  const before = await snap();
  await clickSel(SEL(5), 200);
  return { before, afterClick: await snap(), block3Details: await evalJs(`blocks.find(b => b.id === 3).details`) };
});
S['S10 empty line focused, click the own x of that empty line (hold 200ms)'] = await take(async () => {
  await clickSel(SEL(3)); await clickSel(ADD); await typeText('keep'); await key('Enter');
  const before = await snap();
  await clickSel(DEL(1), 200);
  return { before, afterClick: await snap() };
});
S['S11 empty line focused, press Tab to move to the next control'] = await take(async () => {
  await clickSel(SEL(3)); await clickSel(ADD); await typeText('keep'); await key('Enter');
  const before = await snap();
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await sleep(100);
  return { before, afterTab: await snap() };
});

S['S6a export clicked while an empty line is focused'] = await take(async () => {
  await clickSel(SEL(3)); await clickSel(ADD); await typeText('keep'); await key('Enter');
  const before = await snap();
  await clickSel('#exp'); await sleep(300);
  return { before, afterExport: await snap(), saved: await saved() };
});
S['S6b export with empty strings stored by other means'] = await take(async () => {
  await evalJs(`blocks.find(b => b.id === 3).details = ['a', '', 'b', '']; blocks.find(b => b.id === 4).details = ['', '']; blocks.find(b => b.id === 5).details = [];`);
  const live = await snap();
  await clickSel('#exp'); await sleep(300);
  const sv = await saved();
  return { liveBeforeExport: live, liveAfterExport: await snap(), saved: sv, savedBlocksWithDetailsKey: sv.map(s => s.blocks[0].filter(b => 'details' in b).map(b => [b.name, b.details])) };
});

S['S7 Enter on a non-empty line adds a focused empty line'] = await take(async () => {
  await clickSel(SEL(3)); await clickSel(ADD); await typeText('abc');
  await key('Enter');
  return { afterEnter: await snap() };
});

S['R1 name edit'] = await take(async () => {
  await clickSel(SEL(3)); await key('End'); await typeText('X'); await blur();
  return { name: await evalJs(`blocks.find(b => b.id === 3).name`), rowInput: await evalJs(`document.querySelector('${SEL(3)}').value`), center: await evalJs(`document.querySelector('#clock').textContent.includes('공부X')`) };
});
S['R2 color edit (input event dispatched, native picker not drivable)'] = await take(async () => {
  await evalJs(`const c = document.querySelector('.row[data-id="3"] [data-f=color]'); c.value = '#aabbcc'; c.dispatchEvent(new Event('input', {bubbles: true}));`);
  return { color: await evalJs(`blocks.find(b => b.id === 3).color`), slice: await evalJs(`document.querySelector('.slice[data-id="3"]').getAttribute('fill')`) };
});
S['R3 + 일정 추가'] = await take(async () => {
  const before = await snap();
  await clickSel('#add');
  return { rowsBefore: before.rows, afterAdd: await snap() };
});
S['R4 import example.json then export'] = await take(async () => {
  const doc = await send('DOM.getDocument', {});
  const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#impfile' });
  await send('DOM.setFileInputFiles', { files: [exampleJson], nodeId: q.result.nodeId });
  await sleep(500);
  const afterImport = await evalJs(`store.tables.map(t => t.blocks.map(b => [b.name, b.details]))`);
  await clickSel('#exp'); await sleep(300);
  const sv = await saved();
  const ex = JSON.parse(readFileSync(exampleJson, 'utf8'));
  const expected = ex.tables.map(t => t.blocks.map(b => ({ name: b.name, details: b.details })));
  return { afterImportDetailsMatchExample: JSON.stringify(afterImport) === JSON.stringify(ex.tables.map(t => t.blocks.map(b => [b.name, b.details]))), savedDetailsMatchExample: JSON.stringify(sv[0]?.blocks) === JSON.stringify(expected), savedTables: sv[0]?.blocks.length, firstTableDetails: sv[0]?.blocks[0].map(b => b.details), dialogs: [...dialogs] };
});

writeFileSync(`${out}-result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1));
ws.close(); chrome.kill();

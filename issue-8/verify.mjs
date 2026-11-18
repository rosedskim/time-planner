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

const KEYS = { Tab: [9, ''], ArrowDown: [40, ''], End: [35, ''] };
const key = async k => {
  const [vk] = KEYS[k];
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk });
  await sleep(80);
};
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(150);
};
const center = sel => evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.x + 12}; })()`);
const clickSel = async (sel, atLeft = false) => {
  const c = await center(sel);
  if (!c) throw new Error('no element ' + sel);
  await click(atLeft ? c.left : c.x, c.y);
};
const blur = () => clickSel('.hint');

await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Browser.setDownloadBehavior', { behavior: 'deny' });
await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 940, deviceScaleFactor: 1, mobile: false });
await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Seoul' });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const T = ${Date.parse('2026-11-19T09:10:00+09:00')}, R = Date; class D extends R { constructor(...a) { a.length ? super(...a) : super(T); } static now() { return T; } } window.Date = D; })();` });

const load = async () => {
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url }); await loaded; await sleep(300);
  exceptions = []; dialogs = [];
  await evalJs(`window.__saved = []; window.__names = []; const o = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function() { const n = this.download; window.__names.push(n); window.__savedPending = fetch(this.href).then(r => r.text()).then(t => window.__saved.push({name: n, text: t})); return o.call(this); };`);
};
const msg = () => evalJs(`(() => { const m = document.querySelector('#msg'); const cs = getComputedStyle(m); return {text: m.textContent, color: cs.color, inlineStyleColor: m.style.color, visibleBox: m.getBoundingClientRect().height} })()`);
const take = async fn => {
  await load();
  let r;
  try { r = await fn(); } catch (e) { r = { error: String(e) }; }
  r.exceptions = exceptions.splice(0);
  r.dialogs = dialogs.splice(0);
  return r;
};
const save = async () => {
  await clickSel('#exp');
  await sleep(400);
  await evalJs(`window.__savedPending`);
  const s = await evalJs(`window.__saved`);
  const names = await evalJs(`window.__names`);
  const text = s[s.length - 1]?.text ?? null;
  let parsed = null;
  try { const j = JSON.parse(text); parsed = { app: j.app, version: j.version, tables: j.tables.length, blocks: j.tables.map(t => t.blocks.length) }; } catch {}
  return { anchorDownload: names, downloadCount: s.length, validJson: !!parsed, parsed, text };
};
const dirty = () => evalJs(`dirty`);
const SEL = id => `.row[data-id="${id}"] [data-f=name]`;
const impossible = async () => {
  await clickSel(`.row[data-id="3"] [data-f=start]`, true); await key('Tab'); await key('ArrowDown'); await key('ArrowDown');
  await blur(); await sleep(200);
};

const result = { url, scenarios: {} };
const S = result.scenarios;
const slimSave = s => { const { text, ...rest } = s; return rest; };

let savedText = {};
S['a1 fresh page, click save'] = await take(async () => {
  const before = await msg(); await shot('a1-1-before-save');
  const dirtyBefore = await dirty();
  const sv = await save(); savedText.a1 = sv.text; await shot('a1-2-after-save');
  return { msgBefore: before, dirtyBefore, msgAfter: await msg(), dirtyAfter: await dirty(), save: slimSave(sv) };
});
S['a2 edit a name (dirty), click save'] = await take(async () => {
  await clickSel(SEL(3)); await key('End'); await send('Input.insertText', { text: 'x' }); await sleep(100); await blur();
  const dirtyBefore = await dirty(); await shot('a2-1-edited');
  const sv = await save(); savedText.a2 = sv.text; await shot('a2-2-after-save');
  return { dirtyBefore, msgAfter: await msg(), dirtyAfter: await dirty(), save: slimSave(sv) };
});
S['c1 impossible time edit'] = await take(async () => {
  await impossible(); await shot('c1-impossible-edit');
  return { msg: await msg() };
});
S['c2 add with no free time'] = await take(async () => {
  let clicks = 0;
  for (; clicks < 60; clicks++) { await clickSel('#add'); if ((await msg()).text) break; }
  await shot('c2-no-free-time');
  return { clicks: clicks + 1, msg: await msg() };
});
S['c3 delete the only table'] = await take(async () => {
  const tables = await evalJs(`store.tables.length`);
  await clickSel('#delt'); await shot('c3-delete-only-table');
  return { tables, msg: await msg(), dialogs: dialogs.slice() };
});
S['c4 red notice on screen, then save'] = await take(async () => {
  await impossible();
  const redBefore = await msg();
  const sv = await save(); await shot('c4-red-then-save');
  return { redBefore, msgAfterSave: await msg(), save: slimSave(sv) };
});
S['c5 red notice, save, then a successful action clears it'] = await take(async () => {
  await impossible(); await save();
  await clickSel('#newt');
  return { msgAfterNewTable: await msg() };
});
S['r1 regression flows'] = await take(async () => {
  await clickSel('#newt'); await clickSel('#copyt');
  const n = await evalJs(`store.tables.length`);
  await evalJs(`tablesEl.value = String(store.tables[0].id); tablesEl.dispatchEvent(new Event('change'))`);
  const sv1 = await save();
  await evalJs(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(readFileSync(exampleJson, 'utf8'))}], 'example.json', {type: 'application/json'})); const i = document.querySelector('#impfile'); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`);
  await sleep(500);
  const afterImport = { tables: await evalJs(`store.tables.length`), dirty: await dirty(), msg: await msg() };
  const sv2 = await save(); savedText.r1 = sv2.text;
  await clickSel(SEL(3));
  const afterSelect = await evalJs(`sel`);
  return { tablesAfterNewAndCopy: n, save1: slimSave(sv1), afterImport, save2: slimSave(sv2), afterSelect };
});

writeFileSync(`${out}-saved-a1.json`, savedText.a1 ?? '');
writeFileSync(`${out}-saved-a2.json`, savedText.a2 ?? '');
writeFileSync(`${out}-saved-r1-example.json`, savedText.r1 ?? '');
writeFileSync(`${out}-result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1));
ws.close(); chrome.kill();

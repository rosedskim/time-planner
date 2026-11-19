import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, outPrefix, exampleJson, ...times] = process.argv.slice(2);
const PORT = 9333 + Math.floor(Math.random() * 500);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-'))}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 1 << 28 });
await new Promise(r => ws.on('open', r));
let id = 0; const pending = new Map(); const waiters = []; const exceptions = [];
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text);
  waiters.filter(w => w.method === m.method).forEach(w => w.resolve(m));
});
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const waitEvent = method => new Promise(resolve => waiters.push({ method, resolve }));
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;
const mouse = (type, x, y, buttons = 0) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });

await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 940, deviceScaleFactor: 2, mobile: false });
await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Seoul' });

const out = [];
let scriptId = null;
for (const t of times) {
  if (scriptId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
  scriptId = (await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const T = ${Date.parse('2026-11-19T' + t + ':00+09:00')}, R = Date; class D extends R { constructor(...a) { a.length ? super(...a) : super(T); } static now() { return T; } } window.Date = D; })();` })).result.identifier;
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url }); await loaded; await sleep(300);
  const doc = await send('DOM.getDocument', {});
  const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#impfile' });
  await send('DOM.setFileInputFiles', { files: [exampleJson], nodeId: q.result.nodeId });
  await sleep(500);
  const p = await evalJs(`(() => { const s = document.querySelector('#clock'), q = s.createSVGPoint(); [q.x, q.y] = pt((R + r) / 2, 630); const m = q.matrixTransform(s.getScreenCTM()); return {x: m.x, y: m.y}; })()`);
  await mouse('mouseMoved', p.x, p.y); await mouse('mousePressed', p.x, p.y, 1); await mouse('mouseReleased', p.x, p.y, 0); await sleep(200);
  await mouse('mouseMoved', 5, 5); await sleep(100);
  const info = await evalJs(`({sel: document.querySelector('.row.sel [data-f=name]')?.value, center: [...document.querySelectorAll('#clock text.center')].map(t => t.textContent), pill: document.querySelector('#clock text.now')?.textContent, checkbox: document.querySelector('#shownow').checked, table: document.querySelector('#tname').value, tables: store.tables.map(t => t.name), docH: document.documentElement.scrollHeight, docW: document.documentElement.scrollWidth, innerH: innerHeight, innerW: innerWidth, dpr: devicePixelRatio, msg: document.querySelector('#msg').textContent})`);
  const file = `${outPrefix}-${t.replace(':', '')}.png`;
  writeFileSync(file, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  out.push({ time: t, file, ...info, exceptions: [...exceptions] });
}
console.log(JSON.stringify(out, null, 1));
ws.close(); chrome.kill();

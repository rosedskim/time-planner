import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
let id = 0; const pending = new Map(); const dialogs = []; const waiters = [];
ws.on('message', async raw => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push({ type: m.params.type, message: m.params.message });
    send('Page.handleJavaScriptDialog', { accept: m.params.type === 'beforeunload' });
  }
  waiters.filter(w => w.method === m.method).forEach(w => w.resolve(m));
});
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const waitEvent = method => new Promise(resolve => waiters.push({ method, resolve }));
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;
const shot = async name => writeFileSync(`${out}-${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 940, deviceScaleFactor: 1, mobile: false });

let loaded = waitEvent('Page.loadEventFired');
await send('Page.navigate', { url }); await loaded; await sleep(300);

const rowsBefore = await evalJs(`document.querySelectorAll('.row').length`);
const rect = await evalJs(`(() => { const r = document.querySelector('#add').getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
await sleep(200);
await send('Input.insertText', { text: '독서' });
await sleep(200);
const edited = await evalJs(`({rows: document.querySelectorAll('.row').length, dirty, names: [...document.querySelectorAll('[data-f=name]')].map(e => e.value)})`);
await shot('1-edited');

const confirmsBeforeImport = dialogs.length;
await evalJs(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(readFileSync(exampleJson, 'utf8'))}], 'example.json', {type: 'application/json'})); const i = document.querySelector('#impfile'); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`);
await sleep(800);
const afterImport = await evalJs(`({rows: document.querySelectorAll('.row').length, table: document.querySelector('#tname').value, dirty})`);
const importDialogs = dialogs.slice(confirmsBeforeImport);

const dialogsBeforeReload = dialogs.length;
loaded = waitEvent('Page.loadEventFired');
send('Page.reload');
await Promise.race([loaded, sleep(4000)]); await sleep(500);
const reloadDialogs = dialogs.slice(dialogsBeforeReload);
const rowsAfterReload = await evalJs(`document.querySelectorAll('.row').length`);
await shot('2-after-reload');

const result = { url, rowsBefore, edited, afterImport, importDialogs, reloadDialogs, rowsAfterReload };
writeFileSync(`${out}-result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
ws.close(); chrome.kill();

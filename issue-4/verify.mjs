import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, filesDir, outFile] = process.argv.slice(2);
const PORT = 9333 + Math.floor(Math.random() * 500);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-'))}`,
  '--no-first-run', '--disable-gpu', 'about:blank',
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
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push({ type: m.params.type, message: m.params.message });
    send('Page.handleJavaScriptDialog', { accept: true });
  }
  waiters.filter(w => w.method === m.method).forEach(w => w.resolve(m));
});
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const waitEvent = method => new Promise(resolve => waiters.push({ method, resolve }));
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 940, deviceScaleFactor: 1, mobile: false });

const snapshot = () => evalJs(`({
  options: [...document.querySelectorAll('#tables option')].map(o => o.textContent),
  tname: document.querySelector('#tname').value,
  rows: document.querySelectorAll('.row').length,
  dirty,
  offStepBlocks: store.tables.map(t => t.blocks.filter(b => b.start % 10 || b.end % 10).map(b => [b.start, b.end])),
})`);

const results = {};
for (const file of readdirSync(filesDir).filter(f => f.endsWith('.json')).sort()) {
  for (const mode of ['clean', 'dirty']) {
    const loaded = waitEvent('Page.loadEventFired');
    await send('Page.navigate', { url }); await loaded; await sleep(300);
    if (mode === 'dirty') {
      const rect = await evalJs(`(() => { const r = document.querySelector('#add').getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await sleep(200);
    }
    const before = await snapshot();
    dialogs.length = 0;
    await evalJs(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(readFileSync(join(filesDir, file), 'utf8'))}], ${JSON.stringify(file)}, {type: 'application/json'})); const i = document.querySelector('#impfile'); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`);
    await sleep(600);
    results[`${file} [${mode}]`] = { dialogs: [...dialogs], before, after: await snapshot() };
  }
}
writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
ws.close(); chrome.kill();

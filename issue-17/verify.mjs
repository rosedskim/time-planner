import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [outPrefix, ...urls] = process.argv.slice(2);
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
let id = 0; const pending = new Map(); const waiters = []; let exceptions = [];
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  waiters.filter(w => w.method === m.method).forEach(w => w.resolve(m));
});
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const waitEvent = method => new Promise(resolve => waiters.push({ method, resolve }));
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1400, deviceScaleFactor: 1, mobile: false });

const results = [];
for (const [i, url] of urls.entries()) {
  exceptions = [];
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url }); await loaded; await sleep(2500);
  const r = await evalJs(`(() => {
    const anchors = [...document.querySelectorAll('article a, .markdown-body a, #readme a')]
      .filter(a => a.href.includes('rosedskim.github.io'))
      .map(a => ({ text: a.textContent, href: a.getAttribute('href'), inTable: !!a.closest('table') }));
    const tables = [...document.querySelectorAll('.markdown-body table')].map(t => ({
      headers: [...t.querySelectorAll('th')].map(h => h.textContent.trim()),
      rows: [...t.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(td => td.textContent.trim())),
    }));
    const h2 = [...document.querySelectorAll('.markdown-body h2')].map(h => h.textContent.trim());
    return { title: document.title, anchors, tables, h2, hasClock: !!document.querySelector('#clock') };
  })()`);
  r.url = url; r.exceptions = [...exceptions];
  results.push(r);
  writeFileSync(`${outPrefix}-${i}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
}
writeFileSync(`${outPrefix}-result.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
ws.close(); chrome.kill();

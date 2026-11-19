import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [url, out] = process.argv.slice(2);
const PORT = 9333 + Math.floor(Math.random() * 500);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-'))}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 1 << 28 });
await new Promise(r => ws.on('open', r));
let id = 0; const pending = new Map(); const waiters = [];
ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; } waiters.filter(w => w.method === m.method).forEach(w => w.resolve(m)); });
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const waitEvent = method => new Promise(resolve => waiters.push({ method, resolve }));
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1400, deviceScaleFactor: 1, mobile: false });
const loaded = waitEvent('Page.loadEventFired');
await send('Page.navigate', { url }); await loaded; await sleep(3500);
const r = await evalJs(`(() => {
  const body = document.querySelector('.markdown-body');
  const img = body && body.querySelector('img');
  return { title: document.title, h2: [...body.querySelectorAll('h2')].map(h => h.textContent.trim()), hasPill: /HH:MM/.test(body.textContent),
    img: img && { src: img.src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, complete: img.complete },
    bullets: [...body.querySelectorAll('li')].map(l => l.textContent.trim()).filter(t => /현재 시각|경고|안내가 뜨지|10의 배수|시간순|비어 있는 줄|최대 1시간|YYYY/.test(t)),
    commitInPage: [...document.querySelectorAll('a,span,code')].some(e => e.textContent.includes(${JSON.stringify(url.split('/blob/')[1].slice(0,7))})) };
})()`);
const h = await evalJs(`document.documentElement.scrollHeight`);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1100, height: Math.min(h, 4000), scale: 1 } });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log(JSON.stringify(r, null, 1));
ws.close(); chrome.kill();

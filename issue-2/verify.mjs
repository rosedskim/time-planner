import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, outFile, label] = process.argv.slice(2);
const INSTANTS = ['2026-11-19T01:00:00+09:00', '2026-11-19T12:00:00+09:00', '2026-11-19T23:59:00+09:00'];
const PORT = 9333 + Math.floor(Math.random() * 500);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let dlDir;

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
let id = 0; const pending = new Map(); const waiters = []; const downloads = [];
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Page.downloadWillBegin') downloads.push(m.params.suggestedFilename);
  waiters.filter(w => w.method === m.method).forEach(w => w.resolve(m));
});
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const waitEvent = method => new Promise(resolve => waiters.push({ method, resolve }));
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Seoul' });

const freeze = iso => `(() => {
  const T = ${Date.parse(iso)}, R = Date;
  class D extends R { constructor(...a) { a.length ? super(...a) : super(T); } static now() { return T; } }
  window.Date = D;
})();`;

const results = [];
let scriptId;
for (const iso of INSTANTS) {
  if (scriptId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
  scriptId = (await send('Page.addScriptToEvaluateOnNewDocument', { source: freeze(iso) })).result.identifier;
  dlDir = mkdtempSync(join(tmpdir(), 'dl-'));
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });
  const before = readdirSync(dlDir);
  downloads.length = 0;
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url }); await loaded; await sleep(300);
  await evalJs(`window.__names = []; const o = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function() { window.__names.push(this.download); return o.call(this); };`);
  const env = await evalJs(`({tzOffsetMin: new Date().getTimezoneOffset(), iso: new Date().toISOString(), localDate: new Date().toLocaleDateString('sv-SE')})`);
  await evalJs(`document.querySelector('#exp').click()`);
  await sleep(1200);
  const anchorNames = await evalJs(`window.__names`);
  const msg = await evalJs(`document.querySelector('#msg').textContent`);
  const files = readdirSync(dlDir).filter(f => !before.includes(f));
  let parsed = null;
  if (files[0]) {
    const j = JSON.parse(readFileSync(join(dlDir, files[0]), 'utf8'));
    parsed = { app: j.app, version: j.version, tables: j.tables.length, blocksInFirst: j.tables[0].blocks.length, firstBlockKeys: Object.keys(j.tables[0].blocks[0] || {}) };
  }
  results.push({ frozenInstant: iso, env, anchorDownload: anchorNames, downloadEvent: [...downloads], fileOnDisk: files, msg, parsed });
}

const result = { label, url, results };
writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
ws.close(); chrome.kill();

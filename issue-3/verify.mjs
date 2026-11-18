import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, out] = process.argv.slice(2);
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
let id = 0; const pending = new Map(); const waiters = [];
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  waiters.filter(w => w.method === m.method).forEach(w => w.resolve(m));
});
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const waitEvent = method => new Promise(resolve => waiters.push({ method, resolve }));
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;
const shot = async name => writeFileSync(`${out}-${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));

const KEYS = { Backspace: 8, Tab: 9, ArrowUp: 38, ArrowDown: 40 };
const key = async k => {
  const vk = KEYS[k];
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk });
  await sleep(60);
};
const typeText = async s => {
  for (const ch of s) {
    const up = ch.toUpperCase();
    const code = /\d/.test(ch) ? `Digit${ch}` : `Key${up}`;
    const vk = up.charCodeAt(0);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk });
    await sleep(60);
  }
};
const click = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  await sleep(120);
};
const center = sel => evalJs(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.x + 12, w: r.width}; })()`);

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 940, deviceScaleFactor: 1, mobile: false });

const box = (f, rid = 3) => `.row[data-id="${rid}"] [data-f=${f}]`;
const state = () => evalJs(`({
  start: document.querySelector('${box('start')}').value,
  end: document.querySelector('${box('end')}').value,
  data: blocks.map(b => [b.id, b.start, b.end]),
  msg: document.querySelector('#msg').textContent,
  active: document.activeElement.dataset.f || document.activeElement.tagName
})`);
const slim = s => ({ start: s.start, end: s.end, block2: s.data.find(d => d[0] === 2), block3: s.data.find(d => d[0] === 3), allBlocks: JSON.stringify(s.data), msg: s.msg, active: s.active });

const load = async () => {
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url }); await loaded; await sleep(300);
  await evalJs(`window.__ev = []; for (const t of ['input', 'change', 'focusout']) document.addEventListener(t, e => { if (e.target.dataset && /^(start|end)$/.test(e.target.dataset.f)) window.__ev.push(t + ':' + e.target.dataset.f + '=' + JSON.stringify(e.target.value)); }, true);`);
};
const events = () => evalJs(`window.__ev.splice(0)`);
const focusBox = async (f, rid = 3) => { const c = await center(box(f, rid)); await click(c.left, c.y); };
const blur = async () => { const c = await center('.hint'); await click(c.x, c.y); await sleep(200); };

const locale = await (async () => { await load(); return evalJs(`({lang: navigator.language, hour12: new Intl.DateTimeFormat(navigator.language, {hour: 'numeric'}).resolvedOptions().hour12})`); })();
const result = { url, locale, scenarios: {} };

const SEGMENTS = { full: [0, 1, 2], 'first-segment': [0], 'hour-segment': [1], 'minute-segment': [2] };
for (const f of ['start', 'end']) {
  for (const [kind, segs] of Object.entries(SEGMENTS)) {
    const name = `${f}-clear-${kind}-then-click-elsewhere`;
    await load();
    const before = slim(await state());
    await focusBox(f);
    let at = 0;
    for (const sg of segs) { while (at < sg) { await key('Tab'); at++; } await key('Backspace'); }
    const whileEditing = slim(await state());
    const eventsWhileClearing = await events();
    await shot(`${name}-1-editing`);
    await blur();
    const afterBlur = slim(await state());
    const eventsOnBlur = await events();
    await shot(`${name}-2-after-blur`);
    result.scenarios[name] = { before, whileEditing, eventsWhileClearing, afterBlur, eventsOnBlur };
  }
}

{
  const name = 'end-clear-full-then-Tab-out-of-box';
  await load();
  const before = slim(await state());
  await focusBox('end');
  for (const sg of [0, 1, 2]) { if (sg) await key('Tab'); await key('Backspace'); }
  await events();
  let tabs = 0;
  while (tabs < 4 && (await state()).active === 'end') { await key('Tab'); tabs++; }
  const afterTab = slim(await state());
  result.scenarios[name] = { before, tabsPressedToLeaveBox: tabs, afterTab, eventsOnTabOut: await events() };
}

{
  const name = 'regression-valid-edit-start-minute-ArrowUp';
  await load();
  const before = slim(await state());
  await focusBox('start'); await key('Tab'); await key('Tab'); await key('ArrowUp');
  const whileEditing = slim(await state());
  await blur();
  result.scenarios[name] = { before, whileEditing, afterBlur: slim(await state()), events: await events() };
}

{
  const name = 'regression-valid-edit-squeezes-neighbour-block2-end-hour-ArrowUp-x2';
  await load();
  const before = slim(await state());
  await focusBox('end', 2); await key('Tab'); await key('ArrowUp'); await key('ArrowUp');
  await blur();
  result.scenarios[name] = { before, afterBlur: slim(await state()), events: await events() };
}

{
  const name = 'regression-impossible-edit-start-hour-ArrowDown-x2-into-block2';
  await load();
  const before = slim(await state());
  await focusBox('start'); await key('Tab'); await key('ArrowDown'); await key('ArrowDown');
  await blur();
  await shot('impossible-edit-message');
  result.scenarios[name] = { before, afterBlur: slim(await state()), events: await events() };
}

writeFileSync(`${out}-result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1));
ws.close(); chrome.kill();

import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const at = (hhmm, date = '2026-11-19') => Date.parse(`${date}T${hhmm}:00+09:00`);

const freezeSource = t => `(() => {
  window.__T = ${t};
  const R = Date;
  class D extends R { constructor(...a) { a.length ? super(...a) : super(window.__T); } static now() { return window.__T; } }
  window.Date = D;
  window.__intervals = [];
  const si = window.setInterval;
  window.setInterval = (fn, ms, ...a) => { window.__intervals.push({ fn, ms }); return si(fn, ms, ...a); };
})();`;

export async function launch({ width = 1000, height = 940 } = {}) {
  const port = 9333 + Math.floor(Math.random() * 500);
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-'))}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch {}
  }
  if (!target) { chrome.kill(); throw new Error('chrome did not start'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 1 << 28 });
  await new Promise(r => ws.on('open', r));

  let id = 0; const pending = new Map(); const waiters = [];
  const st = { exceptions: [], dialogs: [], downloads: [] };
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') st.exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Page.javascriptDialogOpening') { st.dialogs.push(m.params.message); send('Page.handleJavaScriptDialog', { accept: true }); }
    if (m.method === 'Page.downloadWillBegin') st.downloads.push(m.params.suggestedFilename);
    waiters.filter(w => w.method === m.method).forEach(w => w.resolve(m));
  });
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const waitEvent = method => new Promise(resolve => waiters.push({ method, resolve }));
  const evalJs = async expr => {
    const r = (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result;
    if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };

  await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Seoul' });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  let scriptId;
  const load = async (url, t) => {
    if (scriptId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
    scriptId = (await send('Page.addScriptToEvaluateOnNewDocument', { source: freezeSource(t) })).result.identifier;
    const loaded = waitEvent('Page.loadEventFired');
    await send('Page.navigate', { url }); await loaded; await sleep(300);
    st.exceptions.length = 0; st.dialogs.length = 0;
  };
  const setClock = t => evalJs(`window.__T = ${t}`);

  const shot = async (file, clip) => {
    const p = { format: 'png' };
    if (clip) p.clip = { ...clip, scale: 1 };
    writeFileSync(file, Buffer.from((await send('Page.captureScreenshot', p)).result.data, 'base64'));
  };
  const rect = sel => evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height}; })()`);
  const center = async sel => { const r = await rect(sel); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };

  const mouse = (type, x, y, buttons = 0) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  const click = async (x, y) => { await mouse('mousePressed', x, y, 1); await mouse('mouseReleased', x, y, 0); await sleep(150); };
  const clickSel = async sel => { const c = await center(sel); if (!c) throw new Error('no element ' + sel); await click(c.x, c.y); };
  const KEYS = { Tab: [9, ''], Enter: [13, '\r'], Space: [32, ' '] };
  const key = async (k, shift = false) => {
    const [vk, text] = KEYS[k], modifiers = shift ? 8 : 0;
    const code = k === 'Space' ? 'Space' : k, kk = k === 'Space' ? ' ' : k;
    await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: kk, code, text, windowsVirtualKeyCode: vk, modifiers });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: kk, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(120);
  };
  const minuteXY = m => evalJs(`(() => { const s = document.querySelector('#clock'), p = s.createSVGPoint(); [p.x, p.y] = pt(R, ${m}); const q = p.matrixTransform(s.getScreenCTM()); return {x: q.x, y: q.y}; })()`);
  const drag = async (from, to) => {
    await mouse('mouseMoved', from.x, from.y); await mouse('mousePressed', from.x, from.y, 1);
    const n = 8;
    for (let i = 1; i <= n; i++) { await mouse('mouseMoved', from.x + (to.x - from.x) * i / n, from.y + (to.y - from.y) * i / n, 1); await sleep(30); }
    await mouse('mouseReleased', to.x, to.y, 0); await sleep(150);
  };

  return { send, evalJs, load, setClock, shot, rect, center, mouse, click, clickSel, key, minuteXY, drag, waitEvent, st, close: () => { ws.close(); chrome.kill(); } };
}

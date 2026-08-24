// Throwaway utility: renders the live app in headless Edge and captures a
// 2x PNG of the cash-out form in a demo state (50 USDC -> Venmo -> @andrew-w).
// Uses only Node built-ins (global WebSocket in Node 22+).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { get } from 'node:http';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9223;
const TARGET = 'http://localhost:5173/';
const OUT = 'public/demo.png';
const VIEW_W = 460;
const VIEW_H = 860;

const chrome = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${process.env.TEMP}\\edge-cdp-${Date.now()}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

let target = null;
for (let i = 0; i < 50 && !target; i++) {
  try {
    const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    target = list.find((t) => t.type === 'page');
  } catch {
    /* endpoint not up yet */
  }
  if (!target) await sleep(200);
}
if (!target) {
  console.error('FATAL: no CDP target');
  chrome.kill();
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) => {
  const id = ++msgId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: VIEW_W,
  height: VIEW_H,
  deviceScaleFactor: 2,
  mobile: false,
});
await send('Page.navigate', { url: TARGET });

// Wait for the React app to mount and the form to render.
for (let i = 0; i < 60; i++) {
  const res = await send('Runtime.evaluate', {
    expression: 'Boolean(document.querySelector(\'input[placeholder="0.00"]\'))',
    returnByValue: true,
  });
  if (res.result?.result?.value === true) break;
  await sleep(200);
}
await sleep(800);

// Fill the demo state: amount 50, payee @andrew-w (platform stays Venmo).
await send('Runtime.evaluate', {
  expression: `(() => {
    const input = document.querySelector('input[placeholder="0.00"]');
    const payee = document.querySelector('input[placeholder^="e.g."]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '50');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(payee, '@andrew-w');
    payee.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`,
  returnByValue: true,
});

// Debounce (350ms) + live estimate fetch from the staging oracle.
await sleep(2500);

const shot = await send('Page.captureScreenshot', { format: 'png' });
const b64 = shot.result?.data;
if (!b64) {
  console.error('FATAL: no screenshot data');
  chrome.kill();
  process.exit(1);
}
mkdirSync('public', { recursive: true });
writeFileSync(OUT, Buffer.from(b64, 'base64'));
console.log('saved', OUT, Buffer.from(b64, 'base64').length, 'bytes');
ws.close();
chrome.kill();

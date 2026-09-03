// Throwaway utility: renders the live app in headless Edge and captures a
// 2x PNG of the cash-in tab (buy USDC) with the first live Peer order
// selected. Uses only Node built-ins (global WebSocket in Node 22+).
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
const evalJs = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return res.result?.result?.value;
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

// Wait for the React app to mount (tab bar present).
for (let i = 0; i < 60; i++) {
  if ((await evalJs("Boolean(document.querySelector('.tab'))")) === true) break;
  await sleep(200);
}
await sleep(600);

// Switch to the Cash in tab.
await evalJs(`(() => {
  const tabs = [...document.querySelectorAll('.tab')];
  const cashin = tabs.find((t) => t.textContent.includes('Cash in'));
  if (cashin) cashin.click();
  return true;
})()`);

// Wait for the orderbook: either order rows or the empty-state note.
let hasOrders = false;
for (let i = 0; i < 40; i++) {
  hasOrders = (await evalJs("Boolean(document.querySelector('.rowitem-btn'))")) === true;
  const empty = (await evalJs(
    "document.body.textContent.includes('No open orders')",
  )) === true;
  if (hasOrders || empty) break;
  await sleep(250);
}

if (hasOrders) {
  // Select the first live order -> selection panel with pre-filled amount.
  // Retry until the panel actually renders (React re-render can detach the
  // row mid-dispatch on the first click).
  for (let i = 0; i < 10; i++) {
    await evalJs("document.querySelector('.rowitem-btn')?.click()");
    await sleep(400);
    const panel = (await evalJs(
      "Boolean(document.querySelector('.order-card'))",
    )) === true;
    if (panel) break;
  }
  await sleep(500);
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
const b64 = shot.result?.data;
if (!b64) {
  console.error('FATAL: no screenshot data');
  chrome.kill();
  process.exit(1);
}
mkdirSync('public', { recursive: true });
const buf = Buffer.from(b64, 'base64');
writeFileSync(OUT, buf);
console.log('saved', OUT, buf.length, 'bytes', hasOrders ? '(first order selected)' : '(empty orderbook)');
ws.close();
chrome.kill();
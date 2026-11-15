// Renders the DROPs app icon (256x256 PNG) with Electron. Run: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b8cff"/><stop offset="1" stop-color="#1557c9"/></linearGradient>
    <linearGradient id="drop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dcebff"/></linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#bg)"/>
  <path d="M128 46c-3 0-5.6 1.4-7.4 3.8C103 73 74 112 74 142a54 54 0 0 0 108 0c0-30-29-69-46.6-92.2-1.8-2.4-4.4-3.8-7.4-3.8z" fill="url(#drop)"/>
  <path d="M101 146a27 27 0 0 0 24 26" stroke="#2f7cf6" stroke-width="12" fill="none" stroke-linecap="round"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="256" height="256" ')}</body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  const img = (await win.webContents.capturePage()).resize({ width: 256, height: 256 });
  const out = path.join(__dirname, '..', 'src', 'assets');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'icon.png'), img.toPNG());
  fs.writeFileSync(path.join(out, 'icon.svg'), svg);
  console.log('wrote', path.join(out, 'icon.png'), img.getSize());
  app.quit();
});

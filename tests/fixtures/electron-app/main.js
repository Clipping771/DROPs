// A tiny Electron app for DROPs' own tests of the `app` tool.
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 640, height: 420, show: false });
  w.loadFile(path.join(__dirname, 'index.html'));
});
app.on('window-all-closed', () => app.quit());

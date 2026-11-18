# Phase 11 — IPC Security Audit (`IPC_SECURITY_AUDIT.md`)

## Audited IPC Surface (`src/main/main.js`, `src/main/preload.js`)
- **Registration Audit:** Every `ipcMain.handle` call in `src/main/main.js` goes through the single `handle(ch, fn)` wrapper (line 296). Zero raw `ipcMain.on` or unwrapped `ipcMain.handle` registrations exist.
- **Sender & Frame Origin Validation:** `handle()` enforces `e.sender === win?.webContents` and `e.senderFrame?.url?.startsWith('file://')`.
- **BrowserWindow Isolation:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (`src/main/main.js` line 195).
- **Navigation & Window Open Restrictions:**
  - `setWindowOpenHandler`: denies all new Electron windows; only `http(s):` opens via `shell.openExternal`.
  - `will-navigate`: blocks navigation to any URL other than `renderer/index.html` (`appPage`), preventing navigation to arbitrary local `file://` HTML pages.
- **Filesystem & Update Boundaries:**
  - `fs:list`, `fs:read`, `fs:write`, `fs:openPath`, `fs:reveal` all enforce `resolveInRoot(projectRoot(root), rel)`.
  - `fs:openPath` redirects `EXEC_EXT` (`.exe`, `.bat`, `.cmd`, `.ps1`, `.vbs`, `.vbe`, `.js`, `.jse`, `.wsf`, `.wsh`, `.msi`, `.scr`, `.com`, `.pif`, `.hta`, `.lnk`, `.url`, `.reg`, `.scf`, stripping trailing dots/spaces) to `shell.showItemInFolder()`.
  - `update:open` enforces `https://github.com/Clipping771/DROPs/` allowlist.

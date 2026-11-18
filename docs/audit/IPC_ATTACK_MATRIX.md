# Phase 12 — IPC Attack Matrix (`IPC_ATTACK_MATRIX.md`)

Inspected all `handle(...)` registrations in `src/main/main.js` (lines 296–781) and `BrowserWindow` configuration (line 195):

| Vector | Control in `63d7361` | Assessment |
|---|---|---|
| Raw `ipcMain.on` / unwrapped `ipcMain.handle` | None found (`0` unwrapped handlers) | **PASS** |
| Renderer Node integration / sandbox | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` | **PASS** |
| Arbitrary `file://` navigation | `will-navigate` restricts to `renderer/index.html` (`appPage`) | **PASS** |
| Subframe (`<iframe>`) IPC invocation | `handle()` checks `e.sender === win?.webContents` and `url.startsWith('file://')`, NOT `e.senderFrame === win?.webContents.mainFrame` | **CONFIRMED GAP (Medium)** |
| `fs:openPath` on executables | `EXEC_EXT` strips trailing dots/spaces and redirects to `shell.showItemInFolder` | **PASS** (Windows ADS `:stream` **NOT TESTED**) |
| `project:use` from compromised renderer | Changes `currentProject`, expanding `projectRoot()` scope | **BY DESIGN** (gated by mainFrame check once fixed) |

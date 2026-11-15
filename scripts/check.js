// Syntax-checks every source file.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
for (const dir of ['src/main', 'src/renderer']) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) execFileSync(process.execPath, ['--check', path.join(dir, f)], { stdio: 'inherit' });
}
console.log('All files OK');

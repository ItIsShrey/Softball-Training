// Checks that the pages' scripts, the shared JS and the Worker have no syntax errors.
// Runs on every pull request (.github/workflows/code-check.yml). Run it yourself with: node .github/scripts/check-code.mjs
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmp = mkdtempSync(join(tmpdir(), 'check-'));
const files = [
  'worker/src/index.js',
  ...readdirSync('public/js').filter(f => f.endsWith('.js')).map(f => 'public/js/' + f),
];
// Inline <script type="module"> blocks in each page.
for (const page of readdirSync('public').filter(f => f.endsWith('.html'))) {
  const html = readFileSync('public/' + page, 'utf8');
  [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].forEach((m, i) => {
    const out = join(tmp, `${page}.${i}.mjs`);
    writeFileSync(out, m[1]);
    files.push(out);
  });
}
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); console.log('ok  ', f); }
  catch (e) { bad++; console.log('FAIL', f + '\n' + String(e.stderr)); }
}
if (bad) { console.log(`\n${bad} file(s) have syntax errors.`); process.exit(1); }

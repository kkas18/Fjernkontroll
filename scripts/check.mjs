// Syntakssjekk av all JavaScript, uten eksterne verktøy.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const roots = ['server.mjs', 'lib', 'public', 'scripts', 'tests'];
const files = [];
const walk = (entry) => {
  if (!fs.existsSync(entry)) return;
  if (fs.statSync(entry).isDirectory()) fs.readdirSync(entry).forEach((name) => walk(path.join(entry, name)));
  else if (/\.(m?js)$/.test(entry)) files.push(entry);
};
roots.forEach(walk);

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failed += 1;
    console.error(`✗ ${file}\n${error.stderr}`);
  }
}
JSON.parse(fs.readFileSync('public/manifest.webmanifest', 'utf8'));
console.log(`${files.length - failed}/${files.length} filer OK, manifest OK`);
process.exit(failed ? 1 : 0);

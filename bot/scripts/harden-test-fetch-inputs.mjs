import fs from 'node:fs';
import path from 'node:path';

const testDir = path.resolve('test');
const helperImport = "import { fetchInputUrl } from './fetch-input.js';\n";
let changedFiles = 0;
let replacements = 0;

for (const entry of fs.readdirSync(testDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.node-test.js')) continue;
  const file = path.resolve(testDir, entry.name);
  let source = fs.readFileSync(file, 'utf8');
  const before = source;

  const stringCalls = source.match(/String\(url\)/g)?.length ?? 0;
  const templateUses = source.match(/\$\{url\}/g)?.length ?? 0;
  if (stringCalls + templateUses === 0) continue;

  source = source.replaceAll('String(url)', 'fetchInputUrl(url)');
  source = source.replaceAll('${url}', '${fetchInputUrl(url)}');
  replacements += stringCalls + templateUses;

  if (!source.includes(helperImport.trim())) {
    const importsEnd = source.indexOf('\n\n');
    if (importsEnd < 0) throw new Error(`Cannot locate import block in ${entry.name}`);
    source = source.slice(0, importsEnd + 1) + helperImport + source.slice(importsEnd + 1);
  }

  if (source !== before) {
    fs.writeFileSync(file, source);
    changedFiles++;
  }
}

if (changedFiles === 0 || replacements === 0) {
  throw new Error(`Expected fetch input replacements, got files=${changedFiles}, replacements=${replacements}`);
}
console.log(`Hardened ${replacements} fetch input uses across ${changedFiles} test files`);

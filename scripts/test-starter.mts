import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Forge } from '../src/core/forge/forge.js';
import { seedStarterSkills } from '../src/core/forge/starter.js';

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'edith-newuser-'));
const forge = new Forge(vault);
await forge.init();

console.log('a brand new user opens Edith for the first time:');
console.log('  forge before:', forge.counts());

const r = await seedStarterSkills(forge, path.resolve('assets/starter-skills'), vault);
console.log('  seeded:', r.seeded.join(', '));
console.log('  forge after: ', forge.counts());
console.log();
console.log('what they see in the deck:');
for (const p of forge.list('proposed')) {
  console.log(`  ✦ ${p.title}`);
  console.log(`    ${p.description.slice(0, 78)}...`);
}
console.log();
console.log('second launch (nothing re-offered):');
const again = await seedStarterSkills(forge, path.resolve('assets/starter-skills'), vault);
console.log('  seeded:', again.seeded.length, ' skipped:', again.skipped.length);
fs.rmSync(vault, { recursive: true, force: true });

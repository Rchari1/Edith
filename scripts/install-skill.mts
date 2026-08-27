import path from 'node:path';
import { installSkill } from '../src/core/onboarding/skill.js';
console.log(JSON.stringify(await installSkill(path.resolve('assets/skill/edith')), null, 2));

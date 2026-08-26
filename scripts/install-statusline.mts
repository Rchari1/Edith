import path from 'node:path';
import { installStatusLine } from '../src/core/onboarding/statusline.js';

const source = path.resolve('assets/statusline/edith-status');
const result = await installStatusLine(source);
console.log(JSON.stringify(result, null, 2));

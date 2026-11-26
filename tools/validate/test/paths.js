import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The project under test is a parameter, never a guess: AF_ROOT points at a
// checkout to judge (default: this package's parent, for the in-repo copy).
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(process.env.AF_ROOT ?? path.join(HERE, '..', '..', '..'));
export const repo = (p) => path.join(ROOT, p);
export const has = (p) => fs.existsSync(repo(p));

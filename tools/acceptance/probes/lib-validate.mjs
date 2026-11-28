// Probe: call the repository's validator through its library entry point.
// usage: node lib-validate.mjs <repo> <flow.yaml>
// Prints {"errors": [...]} exactly as the CLI's --json mode does.
//
// `projectDir` mirrors `src/cli.js`'s `flowProjectDir`: without it the library
// resolves blocks/ from the flow's own directory, which in a scratch root is
// somewhere else than the FORGE_ROOT the CLI uses -- the two verdicts then differ
// for a reason that has nothing to do with the validator (found on 4de2dea).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, file] = process.argv.slice(2);
const { loadYamlFile, validateP0, validateFlow } = await import(pathToFileURL(path.join(repo, 'src', 'validate.js')).href);
const abs = path.resolve(file);
try {
  const doc = loadYamlFile(abs);
  const projectDir = process.env.FORGE_ROOT ? path.resolve(process.env.FORGE_ROOT) : path.dirname(abs);
  // The CLI replaces the absolute prefix it was handed with the argument as typed
  // (`src/cli.js`: e.path.startsWith(abs + '#') → file + rest). Do the same, so the two
  // verdicts are comparable field by field when the flow is named by absolute path.
  const named = (e) => (e?.path && String(e.path).startsWith(abs + '#') ? { ...e, path: file + String(e.path).slice(abs.length) } : e);
  const p0 = validateP0(doc, { file }).map(named);
  const errors = p0.length ? p0 : validateFlow(doc, { file, p0: false, projectDir }).map(named);
  process.stdout.write(JSON.stringify({ errors }) + '\n');
  process.exitCode = errors.some((e) => e.severity === 'block') ? 1 : 0;
} catch (e) {
  // loadYamlFile throws { errors, exitCode } on a syntax error.
  const errors = e?.errors ?? [];
  process.stdout.write(JSON.stringify({ errors }) + '\n');
  process.exitCode = e?.exitCode ?? 1;
}

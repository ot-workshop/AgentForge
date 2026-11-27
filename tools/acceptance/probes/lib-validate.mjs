// Probe: call the repository's validator through its library entry point.
// usage: node lib-validate.mjs <repo> <flow.yaml>
// Prints {"errors": [...]} exactly as the CLI's --json mode does.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, file] = process.argv.slice(2);
const { loadYamlFile, validateP0, validateFlow } = await import(pathToFileURL(path.join(repo, 'src', 'validate.js')).href);
const abs = path.resolve(file);
try {
  const doc = loadYamlFile(abs);
  const p0 = validateP0(doc, { file });
  const errors = p0.length ? p0 : validateFlow(doc, { file, p0: false });
  process.stdout.write(JSON.stringify({ errors }) + '\n');
  process.exitCode = errors.some((e) => e.severity === 'block') ? 1 : 0;
} catch (e) {
  // loadYamlFile throws { errors, exitCode } on a syntax error.
  const errors = e?.errors ?? [];
  process.stdout.write(JSON.stringify({ errors }) + '\n');
  process.exitCode = e?.exitCode ?? 1;
}

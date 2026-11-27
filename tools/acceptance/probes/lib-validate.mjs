// Probe: call the repository's validator through its library entry point.
// usage: node lib-validate.mjs <repo> <flow.yaml> [--p0-off]
//   --p0-off  skips validateP0 and calls validateFlow with p0:false — that path
//             reads blocks/ (and throws when the flow's blocks are missing), so
//             the caller gets the post-P0 rules themselves, not the P0 refusal.
// Prints {"errors": [...]} exactly as the CLI's --json mode does.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, file, ...flags] = process.argv.slice(2);
const p0Off = flags.includes('--p0-off');
const { loadYamlFile, validateP0, validateFlow } = await import(pathToFileURL(path.join(repo, 'src', 'validate.js')).href);
const abs = path.resolve(file);
try {
  const doc = loadYamlFile(abs);
  const p0 = p0Off ? [] : validateP0(doc, { file });
  // Same project root rule as the CLI (`FORGE_ROOT`, else cwd): `validateFlow`
  // without one resolves `blocks/` from the flow file's location, which makes a
  // flow in a bare tmp dir look like every block is missing.
  const projectDir = process.env.FORGE_ROOT ? path.resolve(process.env.FORGE_ROOT) : process.cwd();
  const errors = p0.length ? p0 : validateFlow(doc, { file, p0: false, projectDir });
  process.stdout.write(JSON.stringify({ errors }) + '\n');
  process.exitCode = errors.some((e) => e.severity === 'block') ? 1 : 0;
} catch (e) {
  // loadYamlFile throws { errors, exitCode } on a syntax error. A throw from
  // validateFlow (missing blocks/ under --p0-off) has no `errors`: report it as
  // itself instead of an empty list that would read like "accepted".
  const errors = e?.errors ?? [{ code: 'E_PROBE_THROW', severity: 'block', ids: [], path: file, fix: { detail: String(e?.message ?? e).split('\n')[0] } }];
  process.stdout.write(JSON.stringify({ errors }) + '\n');
  process.exitCode = e?.exitCode ?? 1;
}

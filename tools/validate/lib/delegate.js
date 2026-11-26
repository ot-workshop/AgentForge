// The per-flow verdict is NOT decided here. This module calls the repository's
// one implementation (src/validate.js) with an explicit projectDir and returns
// its verdict in the same order the repository CLI uses:
//
//   E_FILE_NOT_FOUND  when the file is absent (CLI path, src/cli.js `validate`)
//   loadYamlFile      -> { errors } on a file that will not parse
//   validateP0(doc)   -> one answer if a P0.5 field is used
//   validateFlow(doc, { p0: false, projectDir }) otherwise
//
// `projectDir` is required: a library call that forgot the project would judge
// a different one and report a different set of codes (员工一号, #流水线:#7).
import fs from 'node:fs';
import path from 'node:path';

export class ToolError extends Error {}

export async function loadRepo(srcDir) {
  const file = path.join(srcDir, 'validate.js');
  if (!fs.existsSync(file)) throw new ToolError(`no src/validate.js under ${srcDir}`);
  return import(new URL(`file://${path.resolve(file)}`).href);
}

// What a single flow reports, exactly as the repository would report it.
export async function judgeFlow(repo, flowFile, { projectDir } = {}) {
  if (!projectDir) throw new ToolError('projectDir is required: pass the project root (blocks/, agents/, checks/) explicitly');
  const root = path.resolve(projectDir);
  if (!fs.existsSync(path.join(root, 'blocks'))) throw new ToolError(`projectDir ${root} has no blocks/ (is it the project root?)`);
  const abs = path.resolve(flowFile);
  if (!fs.existsSync(abs)) {
    // A missing file is reported by the CLI before any rule runs.
    return { errors: [{ code: 'E_FILE_NOT_FOUND', severity: 'block', locatable: false, path: abs, ids: [], fix: { action: 'pass an existing file', path: abs } }] };
  }
  let doc;
  try {
    doc = repo.loadYamlFile(abs);
  } catch (e) {
    if (Array.isArray(e.errors)) return { errors: e.errors };
    throw new ToolError(`cannot read ${abs}: ${e.message}`);
  }
  const p0 = repo.validateP0(doc, { file: abs });
  if (p0.length) return { errors: p0 };
  return { errors: repo.validateFlow(doc, { file: abs, p0: false, projectDir: root }) };
}

// `cwd` is only where the caller happened to be: the verdict must not depend on it.
export const codeSet = (errors) => [...new Set(errors.filter((e) => e.severity === 'block').map((e) => e.code))].sort();

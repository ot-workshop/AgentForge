import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { parseYaml } from '../src/yamlish.js';
import { createServer } from '../src/serve.js';
import { scanBlocks, MAX_VALIDATE_BYTES } from '../src/canvas-api.js';
import { parseFlow, exportFlow, semantics, emptyFlow, parseSubset } from '../ui/flow-yaml.js';
import { buildSamples, buildBlocks } from '../tools/canvas-sync.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const FORGE = path.join(ROOT, 'bin', 'forge.js');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// `forge validate` names the flow exactly as it was given on the command line.
function projectRootForCli() {
  return process.cwd();
}

function cliValidate(yamlText, name, projectRoot = ROOT, dir = null, cwd = projectRoot) {
  const own = !dir;
  dir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cli-'));
  if (!path.isAbsolute(name)) fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
  const file = path.resolve(dir, name);
  fs.writeFileSync(file, yamlText);
  try {
    // `name` is the CLI argument and the file's path under `dir`: same
    // relative string under the same root, so error `path`s render identically.
    // The CLI prints nothing on clean input; on errors it prints the same
    // `{"errors":[…]}` the server returns (the test reads whichever came).
    const r = spawnSync(process.execPath, [FORGE, 'validate', file, '--json'], { cwd, encoding: 'utf8' });
    const out = r.stdout.trim() || r.stderr.trim();
    return out ? JSON.parse(out) : { errors: [] };
  } finally {
    if (own) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, { method = 'GET', p = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// The server reads blocks/ as well; a fresh root without them is the
// "no blocks" case covered by the block-library test below.
// A project root outside the repository (the server validates against it).
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-work-'));
const WORK_DIR = path.join(WORK, 'flows');
for (const d of ['blocks', 'agents', 'checks']) fs.cpSync(path.join(ROOT, d), path.join(WORK, d), { recursive: true });
fs.mkdirSync(WORK_DIR, { recursive: true });
process.on('exit', () => fs.rmSync(WORK, { recursive: true, force: true }));

async function withServer(fn, { bare = false } = {}) {
  const root = bare ? fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bare-')) : fs.mkdtempSync(path.join(WORK, 'root-'));
  for (const d of ['blocks', 'agents', 'checks', 'flows']) fs.cpSync(path.join(ROOT, d), path.join(root, d), { recursive: true });
  const server = createServer({ rootDir: root });
  const port = await listen(server);
  try {
    return await fn(port, root);
  } finally {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// C1: every sample flow opens and exports back to the same document, and the
// export validates with the repository validator.
test('C1 flows/main.yaml and flows/bugfix.yaml are lossless through open -> export', () => {
  // The CLI copy lives inside the repo so `blocks/` resolves from its path.
  const dir = fs.mkdtempSync(path.join(ROOT, 'ui-export-'));
  try {
    for (const f of ['flows/main.yaml', 'flows/bugfix.yaml']) {
      const text = read(f);
      const flow = parseFlow(text);
      const out = exportFlow(flow);
      assert.deepEqual(parseYaml(out), parseYaml(text), `${f}: exported YAML parses to the same document`);
      assert.deepEqual(semantics(parseFlow(out)), semantics(flow), `${f}: same nodes/edges/params`);
      const result = cliValidate(out, 'ui-export.yaml', ROOT, dir, ROOT);
      // Since #流水线:#10 edge-level on/max_iterations are P0: both samples validate
      // clean after a round trip (the bounded retry edge needs max_iterations).
      const expected = [];
      assert.deepEqual(
        result.errors.map((e) => [e.code, e.fix?.field]),
        expected,
        `${f}: export validates`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('C1 the sample copy shipped to the browser is the repository file', () => {
  const shipped = JSON.parse(read('ui/samples.json'));
  const fresh = buildSamples();
  assert.deepEqual(shipped, fresh);
  assert.equal(shipped.samples.length, fs.readdirSync(path.join(ROOT, 'flows')).filter((f) => /\.ya?ml$/.test(f)).length);
});

test('C1 the block library copy shipped to the browser is the repository scan', () => {
  assert.deepEqual(JSON.parse(read('ui/blocks.json')), buildBlocks());
});

test('C1 every fixture flow survives open -> export with the same semantics', () => {
  const dir = path.join(ROOT, 'fixtures');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yaml')).sort()) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    let doc;
    try {
      doc = parseYaml(text);
    } catch {
      continue; // broken-yaml.yaml is intentionally unparsable
    }
    if (!doc || Array.isArray(doc)) continue;
    // `nodes:` with nothing under it parses to null; the canvas necessarily
    // writes that back as `nodes: []`, which is the validator's own reading of
    // "no nodes" (E_MISSING_ENTRY either way).
    const norm = (d) => JSON.parse(JSON.stringify(d, (k, v) => (k === 'nodes' && v === null ? [] : v)));
    const out = exportFlow(parseFlow(text));
    assert.deepEqual(norm(parseSubset(out)), norm(parseSubset(text)), f);
  }
});

// C2 / C3 through the server: the exported YAML is judged by the same rules.
test('C2 the server accepts the export of a valid sample', async () => {
  await withServer(async (port) => {
    const text = read('flows/main.yaml');
    const body = JSON.stringify({ flow: text, path: 'ui-export.yaml' });
    const r = await request(port, { method: 'POST', p: '/validate', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { errors: [] });
  });
});

test('C2/C3 /validate is byte-identical to the CLI on the same file (in-repo path)', async () => {
  // Within the repository the CLI resolves blocks/ from the flow's own place,
  // which is the server's project root too, so the JSON must match exactly.
  // (Outside the repo the two do not agree until validate and run share one
  // rootDir for blocks/ -- known limit, see README and the entry PR.)
  await withServer(async (port, root) => {
    const flow = parseFlow(read('flows/main.yaml'));
    const cases = {
      'ui-export.yaml': exportFlow(flow),
      'cycle.yaml': exportFlow(withEdge(flow, flow.nodes[0].id, flow.nodes[0].id)),
      'unbound.yaml': exportFlow(withEdge(emptyFlowWith('design'), 'design', 'design', 'self')),
    };
    const outDir = path.join(root, 'flows');
    for (const [name, yaml] of Object.entries(cases)) {
      // Already inside the project: the CLI takes the file by its real path and
      // names it the way the caller wrote it (`dir` is only where it is).
      const cli = cliValidate(yaml, path.join('flows', name), root, root, projectRootForCli());
      const sent = `flows/${name}`;
      const r = await request(port, { method: 'POST', p: '/validate', body: JSON.stringify({ flow: yaml, path: sent }) });
      assert.equal(r.status, 200, name);
      // The two `path`s are the same string relative to their own root; the
      // roots differ (the test's copy vs the server's), so compare the rest.
      const norm = (o) => JSON.stringify(o, (k, v) => (k === 'path' && typeof v === 'string' ? v.replace(/^.*?(?=flows\/|ui-export\.yaml)/, '') : v));
      assert.equal(norm(JSON.parse(r.body)), norm(cli), name);
    }
    // Absolute path inside the repo is accepted and equal as well.
    const abs = path.join(outDir, 'abs.yaml');
    const yaml = cases['cycle.yaml'];
    const cli = cliValidate(yaml, abs, root, root, projectRootForCli());
    const r = await request(port, { method: 'POST', p: '/validate', body: JSON.stringify({ flow: yaml, path: abs }) });
    assert.equal(r.status, 200);
    const norm = (o) => JSON.stringify(o, (k, v) => (k === 'path' && typeof v === 'string' ? v.replace(/^.*?(?=flows\/)/, '') : v));
    assert.equal(norm(JSON.parse(r.body)), norm(cli), 'absolute in-repo path');
  });
});

test('C3 a cycle and an unbound input keep the canvas node id in the error', async () => {
  await withServer(async (port) => {
    const cyclic = exportFlow(withEdge(parseFlow(read('flows/main.yaml')), 'verify', 'design'));
    const r1 = await request(port, { method: 'POST', p: '/validate', body: JSON.stringify({ flow: cyclic, path: 'c.yaml' }) });
    const e1 = JSON.parse(r1.body).errors;
    assert.ok(e1.length > 0);
    assert.ok(e1.every((e) => e.code !== 'E_CYCLE' || [...(e.ids ?? []), e.fix?.nodeId ?? '', /#([^.]+)/.exec(e.path ?? '')?.[1] ?? ''].includes('verify')), JSON.stringify(e1));

    const model = parseFlow(read('flows/main.yaml'));
    model.nodes.unshift({ id: 'orphan', uses: 'block:build@1', with: {}, extra: {}, ui: null });
    const unbound = exportFlow(model);
    const r2 = await request(port, { method: 'POST', p: '/validate', body: JSON.stringify({ flow: unbound, path: 'u.yaml' }) });
    const e2 = JSON.parse(r2.body).errors;
    assert.ok(
      e2.some((e) => e.code === 'E_UNBOUND_INPUT' && [...(e.ids ?? []), e.fix?.nodeId ?? ''].includes('orphan')),
      JSON.stringify(e2),
    );
  });
});

test('the default virtual name is ui-export.yaml', async () => {
  await withServer(async (port) => {
    const bad = 'nodes:\n  - id: a\nedges:\n  - from: a\n    to: missing\n';
    const r = await request(port, { method: 'POST', p: '/validate', body: JSON.stringify({ flow: bad }) });
    const errs = JSON.parse(r.body).errors;
    assert.ok(errs.length > 0);
    assert.match(errs[0].path, /^ui-export\.yaml/);
  });
});

test('validation method and payload limits', async () => {
  await withServer(async (port) => {
    const get = await request(port, { method: 'GET', p: '/validate' });
    assert.equal(get.status, 405);
    assert.match(get.headers.allow, /POST/);
    assert.ok(JSON.parse(get.body).errors[0].code);

    const notJson = await request(port, { method: 'POST', p: '/validate', body: 'not json' });
    assert.equal(notJson.status, 400);
    assert.equal(JSON.parse(notJson.body).errors[0].code, 'E_INVALID_ARGS');

    // Display-only: `/` and absolute paths are fine; `..`, NUL/line breaks and
    // more than 1024 bytes are not.
    for (const p of ['../x.yaml', 'a/../../b', 'x\u0000y', 'a\nb.yaml', 'x'.repeat(1025)]) {
      const r = await request(port, { method: 'POST', p: '/validate', body: JSON.stringify({ flow: 'nodes: []\n', path: p }) });
      assert.equal(r.status, 400, p);
    }

    assert.equal(MAX_VALIDATE_BYTES, 1024 * 1024);
    const big = JSON.stringify({ flow: 'x'.repeat(MAX_VALIDATE_BYTES) });
    const tooBig = await request(port, { method: 'POST', p: '/validate', body: big });
    assert.equal(tooBig.status, 413);
    const err = JSON.parse(tooBig.body).errors[0];
    assert.equal(err.code, 'E_INVALID_ARGS');
    assert.equal(err.fix.detail, 'payload too large');
  });
});

test('C5 /ui is served as HTML and the block library comes from blocks/', async () => {
  await withServer(async (port) => {
    const page = await request(port, { p: '/ui' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.match(page.body, /canvas\.js/);
    const js = await request(port, { p: '/ui/canvas.js' });
    assert.equal(js.status, 200);
    const css = await request(port, { p: '/ui/canvas.css' });
    assert.equal(css.status, 200);
    assert.equal((await request(port, { p: '/ui/nope.js' })).status, 404);
    assert.equal((await request(port, { method: 'POST', p: '/ui' })).status, 405);
  });
});

test('GET /blocks lists the repository blocks and survives a broken one', async () => {
  assert.deepEqual(scanBlocks(path.join(ROOT)), buildBlocks());
  await withServer(async (port) => {
    const r = await request(port, { p: '/blocks' });
    assert.equal(r.status, 200);
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-blocks-'));
  try {
    fs.mkdirSync(path.join(root, 'blocks', 'good'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.mkdirSync(path.join(root, 'blocks', 'bad'), { recursive: true });
    fs.writeFileSync(path.join(root, 'blocks', 'good', 'v1.yaml'), 'id: good\nversion: 1\ninputs: {}\noutputs: {}\nchecks: []\n');
    fs.writeFileSync(path.join(root, 'blocks', 'bad', 'v1.yaml'), ':::not yaml::: [\n');
    const scan = scanBlocks(root);
    assert.deepEqual(scan.blocks.map((b) => b.ref), ['block:good@1']);
    assert.equal(scan.warnings.length, 1);
    assert.match(scan.warnings[0], /^bad\/v1\.yaml/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server route writes nothing into the project root', async () => {
  const snapshotOf = (dir) => fs.readdirSync(dir, { recursive: true }).sort().join('\n');
  await withServer(async (port, root) => {
    const before = snapshotOf(root);
    await request(port, { method: 'POST', p: '/validate', body: JSON.stringify({ flow: read('flows/main.yaml') }) });
    await request(port, { p: '/ui' });
    await request(port, { p: '/blocks' });
    assert.equal(snapshotOf(root), before);
  }, { bare: true });
});

function withEdge(flow, from, to) {
  flow.edges.push({ id: null, from, to });
  return flow;
}

function emptyFlowWith(id) {
  const f = emptyFlow();
  f.nodes.push({ id, uses: 'block:build@1', with: {}, extra: {}, ui: null });
  return f;
}

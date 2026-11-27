// Read-only Live server (P0): /healthz, /snapshot, /events?since=N (SSE).
// Every frame is `data: <one projected event JSON>\n\n`; no event:/id:/retry:
// lines (v2.4 A2.4a). Non-empty result sets keep streaming until the client
// closes; empty result sets end the response immediately (A2.4b).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEvents } from './eventlog.js';
import { snapshot, project } from './project.js';
import { structuredError } from './errors.js';
import { scanBlocks, validateText, readBody, MAX_VALIDATE_BYTES } from './canvas-api.js';
import { validateFlow } from './validate.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const UI_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function loadAllRuns(rootDir) {
  const runsDir = path.join(rootDir, '.forge', 'runs');
  const out = [];
  if (!fs.existsSync(runsDir)) return out;
  for (const id of fs.readdirSync(runsDir).sort()) {
    const file = path.join(runsDir, id, 'events.jsonl');
    if (!fs.existsSync(file)) continue;
    try {
      out.push({ id, ...readEvents(file), mtime: fs.statSync(file).mtimeMs });
    } catch {
      /* a run being written is skipped for this poll; it appears next tick */
    }
  }
  return out;
}

function merged(runs) {
  return runs.flatMap((r) => r.events).sort((a, b) => a.seq - b.seq);
}

export function createServer({ rootDir, port = 8787, pollMs = 200, uiDir = UI_DIR }) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') {
      const runs = loadAllRuns(rootDir).map((r) => r.id);
      return sendJson(res, 200, { ok: true, runs });
    }
    if (url.pathname === '/snapshot') {
      return sendJson(res, 200, snapshot(merged(loadAllRuns(rootDir))));
    }
    if (url.pathname === '/events') {
      const raw = url.searchParams.get('since');
      let since = 0;
      if (raw !== null) {
        if (!/^\d+$/.test(raw)) {
          return sendJson(res, 400, {
            errors: [
              structuredError({ code: 'E_INVALID_QUERY', severity: 'block', locatable: false, path: 'GET /events?since', ids: [], fix: { action: 'pass a non-negative integer since' } }),
            ],
          });
        }
        since = Number(raw);
      }
      const allRuns = loadAllRuns(rootDir);
      const wanted = url.searchParams.get('run');
      let run = null;
      if (wanted) {
        run = allRuns.find((r) => r.id === wanted) ?? null;
        if (!run) {
          return sendJson(res, 404, {
            errors: [
              structuredError({ code: 'E_UNKNOWN_RUN', severity: 'block', locatable: false, path: 'GET /events?run', ids: [`run:${wanted}`], fix: { action: 'pass a run id listed by GET /snapshot', available: allRuns.map((r) => r.id) } }),
            ],
          });
        }
      } else {
        // "Newest run" is the run whose manifest records the latest start
        // (agentforge-v2.4 §3.1); filesystem mtime is not used as a proxy.
        const startedAt = (r) => {
          const m = path.join(rootDir, '.forge', 'runs', r.id, 'manifest.json');
          try {
            const j = JSON.parse(fs.readFileSync(m, 'utf8'));
            return Date.parse(j.run_started_at ?? '') || 0;
          } catch {
            return 0;
          }
        };
        run = allRuns.length ? allRuns.reduce((a, b) => (startedAt(b) >= startedAt(a) ? b : a)) : null;
      }
      const initial = [];
      if (run) for (const item of project(run.events, since)) initial.push(item);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      if (initial.length === 0) return res.end();
      let sent = since;
      const push = () => {
        if (!run) return;
        const fresh = loadAllRuns(rootDir).find((r) => r.id === run.id);
        if (!fresh) return;
        for (const item of project(fresh.events, sent)) {
          sent = item.seq;
          res.write(`data: ${JSON.stringify(item)}\n\n`);
        }
      };
      push();
      const timer = setInterval(push, pollMs);
      req.on('close', () => clearInterval(timer));
      return;
    }
    // Canvas prototype routes (M2-A). They are additive and last: /healthz,
    // /snapshot and /events above are evaluated exactly as before.
    if (!canvasRoute(req, res, url, { rootDir, uiDir })) sendJson(res, 404, { error: 'not found' });
  });
}

const uiPaths = new Set(['/', '/index.html', '/canvas.html', '/canvas.js', '/canvas.css', '/flow-yaml.js', '/blocks.json', '/samples.json']);

function canvasRoute(req, res, url, { rootDir, uiDir }) {
  if (url.pathname === '/ui' || url.pathname.startsWith('/ui/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, ['GET', 'HEAD']);
      return true;
    }
    const rest = url.pathname.slice(3) || '';
    if (rest && !uiPaths.has(rest)) return sendJson(res, 404, { error: 'not found' });
    const name = rest === '' || rest === '/' || rest === '/index.html' ? 'index.html' : rest.slice(1);
    const file = path.join(uiDir, name);
    if (!uiPaths.has('/' + name) || !fs.existsSync(file)) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': UI_TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    return res.end(fs.readFileSync(file));
  }
  if (url.pathname === '/samples') {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
    const flowsDir = path.join(rootDir, 'flows');
    const samples = [];
    if (fs.existsSync(flowsDir)) {
      for (const f of fs.readdirSync(flowsDir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
        const yaml = fs.readFileSync(path.join(flowsDir, f), 'utf8');
        samples.push({ name: `flows/${f}`, file: `flows/${f}`, yaml });
      }
    }
    return sendJson(res, 200, { samples });
  }
  if (url.pathname === '/blocks') {
    if (req.method !== 'GET') {
      methodNotAllowed(res, ['GET']);
      return true;
    }
    return sendJson(res, 200, scanBlocks(rootDir));
  }
  if (url.pathname === '/validate') {
    if (req.method !== 'POST') {
      methodNotAllowed(res, ['POST']);
      return true;
    }
    let aborted = false;
    req.on('aborted', () => {
      aborted = true;
    });
    readBody(req)
      .then((body) => {
        if (aborted) return;
        let input;
        try {
          input = JSON.parse(body);
        } catch {
          input = null;
        }
        const rejectPath = input && input.path !== undefined && pathProblem(input.path) !== null;
        if (!input || typeof input.flow !== 'string' || rejectPath) {
          return sendJson(res, 400, {
            errors: [structuredError({ code: 'E_INVALID_ARGS', severity: 'block', locatable: false, path: 'POST /validate', ids: [], fix: { action: 'send {"flow":"<yaml>","path":"<optional path>"}' } })],
          });
        }
        const file = input.path ?? 'ui-export.yaml';
        const result = validateText(input.flow, { file, projectDir: rootDir, validate: validateFlow });
        // Same output shape as `forge validate --json`: nothing when clean,
        // `{"errors":[…]}` otherwise.
        sendJson(res, 200, { errors: result.errors.length ? result.errors : [] });
      })
      .catch((e) => {
        if (aborted) return;
        if (e.code === 'E_TOO_LARGE') {
          res.setHeader('Connection', 'close');
          return sendJson(res, 413, {
            errors: [structuredError({ code: 'E_INVALID_ARGS', severity: 'block', locatable: false, path: 'POST /validate', ids: [], fix: { action: 'send a smaller body', detail: 'payload too large', maxBytes: MAX_VALIDATE_BYTES } })],
          });
        }
        sendJson(res, 500, {
          errors: [structuredError({ code: 'E_INVALID_ARGS', severity: 'block', locatable: false, path: 'POST /validate', ids: [], fix: { action: 'retry', detail: e.message } })],
        });
      });
    return true;
  }
  return false;
}

// `path` is display-only: it is copied into the returned error objects and
// never used as a file name (the temp file has a random name under
// os.tmpdir()). It still must not be absurd: NUL, CR/LF, a `..` segment or
// more than MAX_PATH_CHARS bytes are 400. `/` and absolute-looking paths are
// allowed so the CLI and this route can be compared on the same string.
export const MAX_PATH_CHARS = 1024;

export function pathProblem(p) {
  if (typeof p !== 'string' || p === '') return 'must be a non-empty string';
  if (p.includes('\0') || /[\r\n]/.test(p)) return 'must not contain NUL or line breaks';
  if (p.replace(/\\/g, '/').split('/').includes('..')) return 'must not contain ..';
  if (Buffer.byteLength(p, 'utf8') > MAX_PATH_CHARS) return `must be at most ${MAX_PATH_CHARS} bytes`;
  return null;
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, { 'Content-Type': 'application/json', Allow: allow.join(', ') });
  res.end(
    JSON.stringify({
      errors: [structuredError({ code: 'E_INVALID_ARGS', severity: 'block', locatable: false, path: 'method', ids: [], fix: { action: 'use an allowed method', allow } })],
    }) + '\n',
  );
}

function sendJson(res, code, body) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body) + '\n');
}

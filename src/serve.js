// Read-only Live server (P0): /healthz, /snapshot, /events?since=N (SSE).
// Every frame is `data: <one projected event JSON>\n\n`; no event:/id:/retry:
// lines (v2.4 A2.4a). Non-empty result sets keep streaming until the client
// closes; empty result sets end the response immediately (A2.4b).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { readEvents } from './eventlog.js';
import { snapshot, project } from './project.js';
import { structuredError } from './errors.js';

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

export function createServer({ rootDir, port = 8787, pollMs = 200 }) {
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
      const initial = [];
      for (const item of project(merged(loadAllRuns(rootDir)), since)) initial.push(item);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      if (initial.length === 0) return res.end();
      let sent = since;
      const push = () => {
        for (const item of project(merged(loadAllRuns(rootDir)), sent)) {
          sent = item.seq;
          res.write(`data: ${JSON.stringify(item)}\n\n`);
        }
      };
      push();
      const timer = setInterval(push, pollMs);
      req.on('close', () => clearInterval(timer));
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  });
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body) + '\n');
}

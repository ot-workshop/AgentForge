import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { EventWriter } from '../src/eventlog.js';
import { createServer } from '../src/serve.js';

function makeRoot(n = 10) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-serve-'));
  const dir = path.join(root, '.forge', 'runs', 'r1');
  fs.mkdirSync(dir, { recursive: true });
  const w = new EventWriter(dir, []).open();
  w.append({ run_id: 'r1', stage: null, actor: { kind: 'orchestrator', name: 't' }, type: 'run.start', payload: {} });
  for (let i = 2; i <= n; i++) {
    w.append({ run_id: 'r1', stage: 'build', iteration: 1, actor: { kind: 'orchestrator', name: 't' }, type: i % 2 ? 'stage.end' : 'stage.start', payload: { i } });
  }
  w.close();
  return root;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
          const s = res.statusCode === 200 && res.headers['content-type']?.includes('event-stream');
          if (s && body.includes('\n\n')) {
            resolve({ status: res.statusCode, body: body.split('\n\n')[0] + '\n\n' });
            req.destroy();
          }
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
  });
}

test('A2.4a frames are data: lines carrying the projected event', async () => {
  const root = makeRoot();
  const server = createServer({ rootDir: root });
  const port = await listen(server);
  try {
    const { status, body } = await get(port, '/events?since=9');
    assert.equal(status, 200);
    const frames = body.split('\n\n').filter(Boolean);
    assert.equal(frames.length, 1);
    assert.ok(frames[0].startsWith('data: '));
    assert.equal(JSON.parse(frames[0].slice(6)).seq, 10);
    assert.ok(!/^(event|id|retry):/m.test(body));
  } finally {
    server.close();
  }
});

test('A2.4b since >= last seq → 200, zero frames, server closes', async () => {
  const root = makeRoot();
  const server = createServer({ rootDir: root });
  const port = await listen(server);
  try {
    const { status, body } = await get(port, '/events?since=10');
    assert.equal(status, 200);
    assert.equal(body, '');
  } finally {
    server.close();
  }
});

test('A2.4a④ invalid since → 400 E_INVALID_QUERY', async () => {
  const root = makeRoot();
  const server = createServer({ rootDir: root });
  const port = await listen(server);
  try {
    const { status, body } = await get(port, '/events?since=abc');
    assert.equal(status, 400);
    assert.match(body, /E_INVALID_QUERY/);
  } finally {
    server.close();
  }
});

test('A2.1/A2.2 /snapshot and /healthz respond', async () => {
  const root = makeRoot();
  const server = createServer({ rootDir: root });
  const port = await listen(server);
  try {
    const snap = await get(port, '/snapshot');
    const parsed = JSON.parse(snap.body);
    assert.equal(parsed.runs.length, 1);
    assert.equal(parsed.runs[0].stages[0].key, 'build@1');
    const health = await get(port, '/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body).runs, ['r1']);
  } finally {
    server.close();
  }
});

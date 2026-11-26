import fs from 'node:fs';
import path from 'node:path';
import { verifyChain } from './eventlog.js';
import { readEvents } from './eventlog.js';
import { replayJsonl, snapshot } from './project.js';
import { runLinear } from './run.js';
import { createServer } from './serve.js';
import { validateFlow, loadYamlFile } from './validate.js';
import { appendEvents } from './append.js';
import { isStructuredError } from './errors.js';

const USAGE = `forge <command> [options]
  replay --run <run_id> --format jsonl       全量投影
  incremental --run <run_id> --since <n>     增量投影（严格大于游标）
  verify-chain (--run <id> | --from-events-file <f>) [--json]
  snapshot --run <run_id>                    投影后的状态（JSON）
  append --run <run_id> --event-file <jsonl>  经锁与哈希链追加事件（A5.3）
  serve [--port <n>]                          Live（/healthz /snapshot /events）
  validate <flow.yaml> [--json]
  run --run <run_id> --flow <path>
`;

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else {
        opts[key] = next;
        i++;
      }
    } else opts._.push(a);
  }
  return { cmd, opts };
}

function root() {
  return process.env.FORGE_ROOT ? path.resolve(process.env.FORGE_ROOT) : process.cwd();
}

function runFile(opts) {
  if (opts['from-events-file']) return path.resolve(opts['from-events-file']);
  const id = opts.run;
  if (!id || id === true) throw usageError('--run <run_id> or --from-events-file <file> required');
  return path.join(root(), '.forge', 'runs', String(id), 'events.jsonl');
}

function usageError(msg) {
  const err = new Error(msg);
  err.exitCode = 2;
  return err;
}

function emitErrors(errors, json) {
  if (json) process.stdout.write(JSON.stringify({ errors }) + '\n');
  else for (const e of errors) process.stderr.write(`${e.code}: ${e.path || ''}\n`);
}

export function main(argv = process.argv.slice(2)) {
  const { cmd, opts } = parseArgs(argv);
  const json = !!opts.json || opts.format === 'jsonl' ? !!opts.json : false;
  try {
    switch (cmd) {
      case 'replay': {
        const { events } = readEvents(runFile(opts));
        process.stdout.write(replayJsonl(events, 0));
        return 0;
      }
      case 'incremental': {
        const since = Number(opts.since ?? 0);
        if (!Number.isInteger(since) || since < 0) throw usageError('--since must be a non-negative integer');
        const { events } = readEvents(runFile(opts));
        process.stdout.write(replayJsonl(events, since));
        return 0;
      }
      case 'verify-chain': {
        const res = verifyChain(runFile(opts));
        if (!res.ok) {
          emitErrors(res.errors, json);
          return 1;
        }
        if (json) process.stdout.write(JSON.stringify({ ok: true, lastSeq: res.lastSeq }) + '\n');
        return 0;
      }
      case 'run': {
        const res = runLinear({
          rootDir: root(),
          flowPath: opts.flow && opts.flow !== true ? path.resolve(opts.flow) : null,
          fake: process.env.FORGE_FAKE ?? null,
          runId: opts.run && opts.run !== true ? String(opts.run) : undefined,
          allowDrift: !!opts['allow-drift'],
        });
        if (res.exitCode !== 0 && json && res.error) emitErrors([res.error], true);
        return res.exitCode;
      }
      case 'validate': {
        const file = opts._[0];
        if (!file) throw usageError('validate <flow.yaml>');
        const doc = loadYamlFile(path.resolve(file));
        const errors = validateFlow(doc, { file });
        const block = errors.filter((e) => e.severity === 'block');
        if (json || errors.length) emitErrors(errors, json);
        else process.stdout.write(JSON.stringify({ errors: [] }) + '\n');
        return block.length ? 1 : 0;
      }
      case 'append': {
        const res = appendEvents({ rootDir: root(), runId: opts.run, eventFile: opts['event-file'] });
        if (json) process.stdout.write(JSON.stringify(res) + '\n');
        return 0;
      }
      case 'serve': {
        const port = Number(opts.port ?? process.env.FORGE_PORT ?? 8787);
        const server = createServer({ rootDir: root(), port });
        server.listen(port, '127.0.0.1', () => {
          process.stderr.write(`forge serve: http://127.0.0.1:${port}\n`);
        });
        const stop = () => server.close(() => process.exit(0));
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        return null;
      }
      case 'snapshot': {
        const { events } = readEvents(runFile(opts));
        process.stdout.write(JSON.stringify(snapshot(events)) + '\n');
        return 0;
      }
      default:
        process.stderr.write(USAGE);
        return 2;
    }
  } catch (e) {
    if (e.errors && Array.isArray(e.errors) && e.errors.every(isStructuredError)) {
      emitErrors(e.errors, json);
      return e.exitCode ?? 1;
    }
    if (e.exitCode === 2) {
      process.stderr.write(`forge: ${e.message}\n`);
      return 2;
    }
    // Uncaught internal error: crash path, exit 2, one line on stderr (A5.8).
    process.stderr.write(`forge: internal error: ${e.message}\n`);
    return 2;
  }
}

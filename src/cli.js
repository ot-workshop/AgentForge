import fs from 'node:fs';
import path from 'node:path';
import { verifyChain } from './eventlog.js';
import { readEvents } from './eventlog.js';
import { replayJsonl, snapshot } from './project.js';
import { runLinear } from './run.js';
import { createServer } from './serve.js';
import { validateFlow, validateP0, loadYamlFile } from './validate.js';
import { appendEvents } from './append.js';
import { checkRefs } from './refs.js';
import { isStructuredError, structuredError } from './errors.js';

const USAGE = `forge <command> [options]
  replay --run <run_id> --format jsonl       全量投影
  incremental --run <run_id> --since <n>     增量投影（严格大于游标）
  verify-chain (--run <id> | --from-events-file <f>) [--json]
  snapshot --run <run_id>                    投影后的状态（JSON）
  verify --check-refs --run <run_id>         引用漂移检测（A7.2）
  append --run <run_id> --event-file <jsonl>  经锁与哈希链追加事件（A5.3）
  serve [--port <n>]                          Live（/healthz /snapshot /events）
  validate <flow.yaml> [--json]          块按 FORGE_ROOT，否则流程文件所在仓库
  run --run <run_id> --flow <path> [--runtime design] [--max-runtime-calls <n>]
                                             （--runtime design：只有 design 阶段改用本机真运行时，
                                               会出网、会产生模型调用；不给就是原来的假执行器）
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

function flowProjectDir(absFlow) {
  if (process.env.FORGE_ROOT) return path.resolve(process.env.FORGE_ROOT);
  let dir = path.dirname(absFlow);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'blocks'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return root();
    dir = up;
  }
}

function emitErrors(errors, json) {
  if (json) process.stdout.write(JSON.stringify({ errors }) + '\n');
  else for (const e of errors) process.stderr.write(`${e.code}: ${e.path || ''}\n`);
}

export async function main(argv = process.argv.slice(2)) {
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
        // `forge run` takes its flow as `--flow <path>` (v2.4 appendix A). A
        // positional argument used to be dropped silently and the default
        // three stages ran instead; refuse it as a block error, not a crash.
        if (opts._.length) {
          throw {
            errors: [
              structuredError({
                code: 'E_INVALID_ARGS',
                severity: 'block',
                locatable: false,
                path: `run ${opts._.join(' ')}`,
                ids: [],
                fix: { action: 'pass the flow with --flow <path>', got: opts._ },
              }),
            ],
            exitCode: 1,
          };
        }
        // A `--flow` that names no file is refused too: it used to fall back to
        // the default three stages with `flow: null` and still create a run.
        // (No `--flow` remains the explicit default-stages form.)
        let flowPath = null;
        if (opts.flow === true) throw usageError('--flow needs a path');
        if (opts.flow) {
          flowPath = path.resolve(opts.flow);
          if (!fs.existsSync(flowPath)) {
            throw {
              errors: [
                structuredError({
                  code: 'E_FILE_NOT_FOUND',
                  severity: 'block',
                  locatable: false,
                  path: `--flow ${opts.flow}`,
                  ids: [],
                  fix: { action: 'pass an existing flow file inside the project root', path: flowPath },
                }),
              ],
              exitCode: 1,
            };
          }
        }
        // M2-B: the real runtime is opt-in. Without `--runtime`, nothing about
        // this path changes: the fake runner runs all three stages, no network.
        const runtimeStage = opts.runtime && opts.runtime !== true ? String(opts.runtime) : null;
        if (opts.runtime === true || (runtimeStage && runtimeStage !== 'design')) {
          throw {
            errors: [
              structuredError({ code: 'E_INVALID_ARGS', severity: 'block', locatable: false, path: '--runtime', ids: [], fix: { action: '--runtime takes one stage name; M2-B only supports --runtime design', supported: ['design'] } }),
            ],
            exitCode: 1,
          };
        }
        const maxCalls = opts['max-runtime-calls'] === undefined || opts['max-runtime-calls'] === true ? undefined : Number(opts['max-runtime-calls']);
        if (maxCalls !== undefined && (!Number.isInteger(maxCalls) || maxCalls < 1)) {
          throw {
            errors: [
              structuredError({ code: 'E_INVALID_ARGS', severity: 'block', locatable: false, path: '--max-runtime-calls', ids: [], fix: { action: 'pass a positive integer' } }),
            ],
            exitCode: 1,
          };
        }
        const res = await runLinear({
          rootDir: root(),
          flowPath,
          fake: process.env.FORGE_FAKE ?? null,
          runId: opts.run && opts.run !== true ? String(opts.run) : undefined,
          allowDrift: !!opts['allow-drift'],
          runtime: runtimeStage ? { stage: runtimeStage, bin: process.env.FORGE_RUNTIME_BIN || 'opencode' } : null,
          maxRuntimeCalls: maxCalls,
        });
        // One shape for both modes: -e prints a JSON error object; plain forks
        // print the `code: path` line (as before). A beforeWrite refusal has no run
        // dir, so this is the only way the caller learns why nothing ran.
        if (res.exitCode !== 0 && res.error && (json || res.beforeWrite)) emitErrors([res.error], json);
        return res.exitCode;
      }
      case 'validate': {
        const file = opts._[0];
        if (!file) throw usageError('validate <flow.yaml>');
        const abs = path.resolve(file);
        if (!fs.existsSync(abs)) {
          const e = {
            errors: [
              structuredError({ code: 'E_FILE_NOT_FOUND', severity: 'block', locatable: false, path: abs, ids: [], fix: { action: 'pass an existing file', path: abs } }),
            ],
            exitCode: 1,
          };
          throw e;
        }
        const doc = loadYamlFile(abs);
        const p0Errors = validateP0(doc, { file });
        const sev = opts.severity && opts.severity !== true ? String(opts.severity) : null;
        // Same project root as `run`: block/agent/check lookups follow
        // `FORGE_ROOT` (or the cwd) rather than the flow file's location,
        // so a flow in another directory is judged against the same
        // blocks/ that `forge run --flow <path>` would use.
        // `validate <file>` judges the file against the repository that file
        // lives in (nearest ancestor with blocks/); `FORGE_ROOT` wins when set,
        // and cwd is the last resort. This keeps `validate` and `run` on the
        // same blocks/ wherever the caller's cwd is.
        let errors = p0Errors.length ? p0Errors : validateFlow(doc, { file, p0: false, projectDir: flowProjectDir(abs) });
        // The CLI names the file as the caller did, not as an absolute path
        // (the canvas route compares its JSON against this output).
        errors = errors.map((e) => (e.path && String(e.path).startsWith(abs + '#') ? { ...e, path: file + String(e.path).slice(abs.length) } : e));
        if (sev) errors = errors.filter((e) => e.severity === sev);
        const block = errors.filter((e) => e.severity === 'block');
        if (json || errors.length) emitErrors(errors, json);
        else process.stdout.write(JSON.stringify({ errors: [] }) + '\n');
        return block.length ? 1 : 0;
      }
      case 'verify': {
        if (!opts['check-refs']) throw usageError('verify --check-refs --run <run_id>');
        const res = checkRefs({ rootDir: root(), runId: opts.run });
        if (!res.ok) emitErrors(res.errors, json);
        else if (json) process.stdout.write(JSON.stringify({ ok: true }) + '\n');
        return res.ok ? 0 : 1;
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

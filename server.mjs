import {createServer} from 'node:http';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  LedgerError,
  approvalOverview,
  createApprovalStore,
  decide,
  defineRule,
  deserialize,
  getCurrent,
  objectHistory,
  replayDecision,
  serialize,
  setGrant,
  snapshotDiff,
  submit,
  submissionView,
  updateSource,
  verifySnapshot,
} from './src/approval-ledger.mjs';

const STATUS_BY_CODE = {
  'not-found': 404,
  forbidden: 403,
  'invalid-evidence': 400,
  'invalid-rule': 400,
  'invalid-action': 400,
  'corrupt-evidence': 422,
  conflict: 409,
};

async function readBody(req) {
  let text = '';
  for await (const part of req) text += part;
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new LedgerError('invalid-evidence', 'request body is not valid JSON');
  }
}

function send(res, code, value) {
  res.writeHead(code, {'content-type': 'application/json'});
  res.end(JSON.stringify(value));
}

function seed(initial = createApprovalStore()) {
  let store = initial;
  store = defineRule(store, {
    version: 'amount-rule/v1',
    name: 'Amount change review',
    body: {maxAmount: 1000, requireReason: true, description: 'amount changes need a reason and an approver'},
  });
  store = setGrant(store, 'alice', 'submit', true);
  store = setGrant(store, 'bob', 'submit', true);
  store = setGrant(store, 'bob', 'approve', true);
  store = setGrant(store, 'bob', 'withdraw.any', true);
  store = setGrant(store, 'carol', 'submit', false);
  store = setGrant(store, 'carol', 'approve', false);
  if (store.objects.size === 0) store = updateSource(store, 'change-a', {amount: 10}, {by: 'seed'});
  return store;
}

/**
 * @param {object} [options]
 * @param {string} [options.persistFile]  JSON file to load/persist the ledger (null disables)
 * @param {boolean} [options.seed]        seed demo rules/grants/object (default true when file missing)
 */
export function createApp(options = {}) {
  const persistFile = options.persistFile === undefined ? null : options.persistFile;
  const holder = {current: options.store ?? createApprovalStore()};
  const bus = new Set();
  const sockets = new Set();
  let saveTimer = null;

  function emit(event) {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of bus) {
      if (!client.res.writableEnded) client.res.write(line);
    }
  }

  function mutate(next, event) {
    holder.current = next;
    emit({at: new Date().toISOString(), overviewSeq: next.eventSeq, ...event});
    schedulePersist();
  }

  function schedulePersist() {
    if (!persistFile) return;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      doPersist().catch((error) => emit({type: 'persist-error', error: error.message}));
    }, 50).unref();
  }

  async function doPersist() {
    if (!persistFile) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    await mkdir(dirname(persistFile), {recursive: true});
    await writeFile(persistFile, serialize(holder.current));
  }

  async function load() {
    if (!persistFile) {
      if (options.seed ?? true) holder.current = seed(holder.current);
      return;
    }
    try {
      holder.current = deserialize(await readFile(persistFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (options.seed ?? true) holder.current = seed(holder.current);
      await mkdir(dirname(persistFile), {recursive: true});
      await writeFile(persistFile, serialize(holder.current));
    }
  }

  const app = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const actor = req.headers['x-actor']?.toString() || null;
    try {
      const {pathname} = url;

      if (pathname === '/api/health') return send(res, 200, {ok: true, eventSeq: holder.current.eventSeq});

      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const client = {res};
        bus.add(client);
        res.write(`data: ${JSON.stringify({type: 'hello', at: new Date().toISOString(), overviewSeq: holder.current.eventSeq})}\n\n`);
        const since = Number(url.searchParams.get('since') ?? '0');
        const missed = holder.current.events.filter((event) => event.seq > since);
        for (const event of missed) res.write(`data: ${JSON.stringify({...event, replay: true})}\n\n`);
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(': ping\n\n');
        }, 30000);
        req.on('close', () => { clearInterval(heartbeat); bus.delete(client); });
        return;
      }

      if (pathname === '/api/approvals' && req.method === 'GET') {
        return send(res, 200, approvalOverview(holder.current, actor));
      }

      if (pathname === '/api/source' && req.method === 'PUT') {
        // Legacy direct-save path: same payload/response as before, appends a version.
        const item = await readBody(req);
        if (item.id == null) throw new LedgerError('invalid-evidence', 'id is required', {missing: ['id']});
        const next = updateSource(holder.current, item.id, item.value, {by: actor ?? 'direct-save'});
        mutate(next, {type: 'source-updated', objectId: item.id});
        return send(res, 200, getCurrent(next, item.id));
      }

      if (pathname === '/api/submissions' && req.method === 'POST') {
        const item = await readBody(req);
        let next;
        if (item.evidence !== undefined && item.objectId === undefined && item.proposedValue === undefined) {
          // Legacy payload {id, evidence} keeps its loose positional behavior.
          next = submit(holder.current, item.id, item.evidence);
        } else {
          next = submit(holder.current, {
            objectId: item.objectId ?? item.id,
            proposedValue: item.proposedValue ?? item.proposed ?? item.value,
            baseVersion: item.baseVersion,
            actor: item.actor ?? actor ?? undefined,
            inputs: item.inputs,
            ruleVersion: item.ruleVersion,
            summary: item.summary,
          });
        }
        const created = next.submissions.get(next.nextSubmissionId - 1);
        mutate(next, {type: 'submitted', submissionId: created.id});
        return send(res, 201, submissionView(next, created, actor));
      }

      let match = pathname.match(/^\/api\/submissions\/(\d+)$/);
      if (match && req.method === 'GET') {
        const submissionId = Number(match[1]);
        const submission = holder.current.submissions.get(submissionId);
        if (!submission) throw new LedgerError('not-found', 'submission not found', {submissionId});
        return send(res, 200, {
          submission: submissionView(holder.current, submission, actor),
          verification: verifySnapshot(holder.current, submissionId),
          diff: snapshotDiff(holder.current, submissionId),
          decisions: holder.current.decisions
            .filter((decision) => decision.submissionId === submissionId)
            .map((decision) => replayDecision(holder.current, decision.seq)),
        });
      }

      if (pathname === '/api/decisions' && req.method === 'POST') {
        const item = await readBody(req);
        const next = decide(holder.current, {
          submissionId: item.submissionId,
          action: item.action ?? item.outcome,
          actor: item.actor ?? actor ?? undefined,
          reason: item.reason,
        });
        const decision = next.decisions.at(-1);
        mutate(next, {type: 'decision-recorded', submissionId: item.submissionId, seq: decision.seq});
        return send(res, 201, {
          ...decision,
          submission: submissionView(next, next.submissions.get(item.submissionId), actor),
        });
      }

      match = pathname.match(/^\/api\/decisions\/(\d+)\/replay$/);
      if (match && req.method === 'GET') {
        return send(res, 200, replayDecision(holder.current, Number(match[1])));
      }

      match = pathname.match(/^\/api\/objects\/([^/]+)\/history$/);
      if (match && req.method === 'GET') {
        return send(res, 200, objectHistory(holder.current, decodeURIComponent(match[1])));
      }

      if (pathname === '/api/rules' && req.method === 'POST') {
        const item = await readBody(req);
        const next = defineRule(holder.current, item);
        mutate(next, {type: 'rule-defined', ruleVersion: item.version});
        return send(res, 201, next.rules.get(item.version));
      }

      if (pathname === '/api/grants' && req.method === 'PUT') {
        const item = await readBody(req);
        if (!item.actor || !item.permission) throw new LedgerError('invalid-evidence', 'actor and permission are required');
        const next = setGrant(holder.current, item.actor, item.permission, Boolean(item.granted));
        mutate(next, {type: 'grant-changed', actor: item.actor, permission: item.permission, granted: Boolean(item.granted)});
        return send(res, 200, Object.keys(next.grants.get(item.actor) ?? {}));
      }

      if (pathname === '/' || pathname === '/index.html') return serveStatic(res, 'index.html', 'text/html');
      if (pathname === '/app.js') return serveStatic(res, 'app.js', 'text/javascript');
      return send(res, 404, {error: 'not found', path: pathname});
    } catch (error) {
      if (error instanceof LedgerError) {
        return send(res, STATUS_BY_CODE[error.code] ?? 409, {error: error.message, code: error.code, details: error.details});
      }
      return send(res, 500, {error: error.message});
    }
  });

  app.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  function close() {
    return new Promise((resolve) => {
      doPersist()
        .catch(() => {})
        .finally(() => {
          app.close(() => resolve());
          for (const socket of sockets) socket.destroy();
        });
    });
  }

  async function serveStatic(res, file, type) {
    const path = fileURLToPath(new URL(`./public/${file}`, import.meta.url));
    const content = await readFile(path);
    res.writeHead(200, {'content-type': `${type}; charset=utf-8`});
    res.end(content);
  }

  return {app, store: holder, load, close, bus: () => bus};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const persistFile = process.env.PERSIST === '0' ? null : (process.env.PERSIST_FILE ?? new URL('./data/ledger.json', import.meta.url).pathname);
  const created = createApp({persistFile});
  await created.load();
  const port = Number(process.env.PORT ?? 4184);
  created.app.listen(port, () => {
    console.log(`approval-evidence-web listening on http://localhost:${port}${persistFile ? ` (persist: ${persistFile})` : ''}`);
  });
  const shutdown = async () => { await created.close().catch(() => {}); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

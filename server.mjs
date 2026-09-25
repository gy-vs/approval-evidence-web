import {createServer} from 'node:http';
import {access, mkdir, readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  createApprovalStore, createDefaultRegistry, decide, setPermission, submit, updateSource, withdraw,
} from './src/approval-ledger.mjs';
import {appState, submissionView} from './src/view.mjs';
import {LedgerError} from './src/errors.mjs';
import {createPersistence, deserializeStore} from './src/persistence.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

async function readBody(req) {
  let text = '';
  for await (const part of req) text += part;
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new LedgerError('INVALID_INPUT', 'request body is not valid JSON', {status: 400}); }
}

function send(res, code, value, headers = {}) {
  res.writeHead(code, {'content-type': 'application/json', ...headers});
  res.end(JSON.stringify(value));
}

// Factory so tests get an isolated app/store while `node server.mjs` keeps the
// original entry point.
export function createApp(initialStore = createApprovalStore(), options = {}) {
  let store = initialStore;
  const registry = options.registry ?? createDefaultRegistry();
  const persistence = options.persistence ?? {schedule: async () => {}, flush: async () => {}, close: async () => {}};
  const sseClients = new Set();

  function broadcast(event) {
    const payload = `event: ledger\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch { sseClients.delete(res); }
    }
  }

  async function mutate(nextStore, event) {
    store = nextStore;
    await persistence.schedule(store);
    broadcast({...event, at: event.at ?? store.now(), stateVersion: store.events.length});
  }

  const app = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const actor = req.headers['x-actor'];
    try {
      const {pathname} = url;

      // --- Live read models -------------------------------------------------
      if (pathname === '/api/state' && req.method === 'GET') {
        return send(res, 200, appState(store, registry, url.searchParams.get('viewer')));
      }
      if (pathname === '/api/rules' && req.method === 'GET') {
        return send(res, 200, {rules: appState(store, registry).rules});
      }
      if (pathname === '/api/approvals' && req.method === 'GET') {
        // Legacy aggregate endpoint, contract preserved.
        return send(res, 200, {current: [...store.current], submissions: [...store.submissions.values()], decisions: store.decisions});
      }

      const submissionMatch = pathname.match(/^\/api\/submissions\/(\d+)$/);
      if (submissionMatch && req.method === 'GET') {
        const submission = store.submissions.get(Number(submissionMatch[1]));
        if (!submission) throw new LedgerError('SUBMISSION_NOT_FOUND', 'submission not found', {status: 404});
        return send(res, 200, submissionView(store, registry, submission));
      }
      const withdrawMatch = pathname.match(/^\/api\/submissions\/(\d+)\/withdraw$/);
      if (withdrawMatch && req.method === 'POST') {
        const item = await readBody(req);
        const by = actor || item.actor || 'anonymous';
        const nextStore = withdraw(store, Number(withdrawMatch[1]), by);
        await mutate(nextStore, nextStore.events.at(-1));
        return send(res, 200, submissionView(store, registry, store.submissions.get(Number(withdrawMatch[1]))));
      }

      // --- Direct save path (unchanged contract) ----------------------------
      if (pathname === '/api/source' && req.method === 'PUT') {
        const item = await readBody(req);
        if (!item.id) throw new LedgerError('INVALID_INPUT', 'id is required', {status: 400});
        const nextStore = updateSource(store, item.id, item.value, actor || item.actor || 'system');
        await mutate(nextStore, nextStore.events.at(-1));
        return send(res, 200, store.current.get(item.id));
      }

      // --- Submit: legacy {id, evidence} OR evidence-backed payload ---------
      if (pathname === '/api/submissions' && req.method === 'POST') {
        const item = await readBody(req);
        let nextStore;
        if (typeof item.id !== 'undefined' && typeof item.objectId === 'undefined') {
          nextStore = submit(store, item.id, item.evidence, actor || item.actor || 'anonymous');
        } else {
          nextStore = submit(store, {
            objectId: item.objectId,
            input: item.input,
            submittedBy: actor || item.submittedBy,
            rule: item.rule,
            registry,
          });
        }
        await mutate(nextStore, nextStore.events.at(-1));
        const created = nextStore.submissions.get(nextStore.nextSubmissionId - 1);
        return send(res, 201, submissionView(store, registry, created));
      }

      // --- Decide: legacy {submissionId, outcome} OR full payload -----------
      if (pathname === '/api/decisions' && req.method === 'POST') {
        const item = await readBody(req);
        if (typeof item.submissionId !== 'number') {
          throw new LedgerError('INVALID_INPUT', 'submissionId (number) is required', {status: 400});
        }
        let nextStore;
        if (typeof item.outcome === 'string' && !item.decidedBy && !actor) {
          nextStore = decide(store, item.submissionId, item.outcome);
        } else {
          nextStore = decide(store, item.submissionId, {
            outcome: item.outcome,
            decidedBy: actor || item.decidedBy,
            reason: item.reason,
            allowConflict: Boolean(item.allowConflict),
            registry,
          });
        }
        await mutate(nextStore, nextStore.events.at(-1));
        return send(res, 201, nextStore.decisions.at(-1));
      }

      // --- Permissions ------------------------------------------------------
      if (pathname === '/api/permissions' && req.method === 'GET') {
        return send(res, 200, {permissions: Object.fromEntries(store.permissions)});
      }
      if (pathname === '/api/permissions' && req.method === 'PUT') {
        const item = await readBody(req);
        const nextStore = setPermission(store, item.actor, item.permissions, actor || item.by || 'admin');
        await mutate(nextStore, nextStore.events.at(-1));
        return send(res, 200, {permissions: store.permissions.get(item.actor)});
      }

      // --- Real-time event stream -------------------------------------------
      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`event: hello\ndata: ${JSON.stringify({stateVersion: store.events.length})}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      // --- Static UI --------------------------------------------------------
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const html = await readFile(join(ROOT, 'public', 'index.html'));
        res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
        return res.end(html);
      }
      if (req.method === 'GET' && (pathname === '/app.js' || pathname === '/app.css')) {
        const type = pathname.endsWith('.css') ? 'text/css' : 'text/javascript';
        const body = await readFile(join(ROOT, 'public', pathname.slice(1)));
        res.writeHead(200, {'content-type': `${type}; charset=utf-8`});
        return res.end(body);
      }

      return send(res, 404, {error: 'not found'});
    } catch (error) {
      if (error instanceof LedgerError) {
        return send(res, error.status, {error: error.message, code: error.code, details: error.details ?? null});
      }
      return send(res, 500, {error: error.message, code: 'INTERNAL'});
    }
  });

  return {
    app,
    getStore: () => store,
    getRegistry: () => registry,
    close: () => persistence.close(),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Evidence survives restarts: load the ledger from disk when present, then
  // persist every mutation atomically. DATA_FILE=:memory: keeps the old mode.
  const dataFile = process.env.DATA_FILE ?? join(ROOT, 'data', 'ledger.json');
  let persistence = {schedule: async () => {}, flush: async () => {}, close: async () => {}};
  let store = createApprovalStore();
  let seeded = false;
  if (dataFile !== ':memory:') {
    try {
      await access(dataFile);
      store = deserializeStore(await readFile(dataFile, 'utf8'), {now: () => new Date().toISOString()});
      seeded = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(dirname(dataFile), {recursive: true});
    }
    persistence = createPersistence(dataFile);
  }
  // Original startup behavior: seed change-a on a fresh ledger.
  if (!seeded && !store.current.has('change-a')) {
    store = updateSource(store, 'change-a', {amount: 10});
    await persistence.schedule(store);
  }
  const port = Number(process.env.PORT ?? 4184);
  const created = createApp(store, {persistence});
  created.app.listen(port, () => {
    console.log(`approval-evidence-web listening on http://localhost:${port} (data: ${dataFile})`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await created.close(); process.exit(0); });
}

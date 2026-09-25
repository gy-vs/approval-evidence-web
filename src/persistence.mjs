// Durable persistence for the ledger across restarts. The store is plain JSON
// data (Maps are revived), written with an atomic temp-file rename so a crash
// mid-write cannot corrupt the evidence trail.
import {rename, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

export function serializeStore(store) {
  return JSON.stringify({
    version: 2,
    nextSubmissionId: store.nextSubmissionId,
    current: [...store.current.entries()],
    submissions: [...store.submissions.entries()],
    decisions: store.decisions,
    permissions: [...store.permissions.entries()],
    events: store.events,
  });
}

export function deserializeStore(text, {now}) {
  const data = JSON.parse(text);
  const store = {
    now,
    nextSubmissionId: data.nextSubmissionId ?? 1,
    current: new Map(data.current ?? []),
    submissions: new Map(data.submissions ?? []),
    decisions: data.decisions ?? [],
    permissions: new Map(data.permissions ?? []),
    events: data.events ?? [],
  };
  return store;
}

// In-memory when path is null; otherwise a debounced atomic JSON snapshot.
export function createPersistence(path, {delay = 50} = {}) {
  let timer = null;
  let pending = null;
  let chain = Promise.resolve();
  function flush() {
    if (!pending) return chain;
    const payload = pending;
    pending = null;
    chain = chain.then(async () => {
      const tmp = join(dirname(path), `.${path.split('/').pop()}.tmp-${process.pid}`);
      await writeFile(tmp, payload);
      await rename(tmp, path);
    });
    return chain;
  }
  return {
    schedule(store) {
      if (!path) return Promise.resolve();
      pending = serializeStore(store);
      clearTimeout(timer);
      timer = setTimeout(flush, delay);
      return chain;
    },
    flush,
    async close() {
      clearTimeout(timer);
      await flush();
    },
  };
}

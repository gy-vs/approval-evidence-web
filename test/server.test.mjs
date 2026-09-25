import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createApp} from '../server.mjs';
import {createApprovalStore, createDefaultRegistry, submit, updateSource} from '../src/approval-ledger.mjs';

async function startServer(initialStore = createApprovalStore()) {
  const created = createApp(initialStore);
  created.app.listen(0);
  await once(created.app, 'listening');
  const port = created.app.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    close: async () => {
      await created.close();
      await new Promise((resolve) => {
        created.app.closeAllConnections?.();
        created.app.close(resolve);
      });
    },
  };
}

async function req(base, method, path, body, actor, raw = false) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {'content-type': 'application/json', ...(actor ? {'x-actor': actor} : {})},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (raw) return {response, data};
  if (!response.ok) {
    const err = new Error(data.error);
    err.status = response.status;
    err.code = data.code;
    err.details = data.details;
    throw err;
  }
  return data;
}

test('full cross-user flow: evidence survives live changes; approval acts on frozen version', async () => {
  let store = updateSource(createApprovalStore(), 'change-a', {amount: 10});
  const server = await startServer(store);
  try {
    // bob submits an evidence-backed change
    const created = await req(server.base, 'POST', '/api/submissions', {objectId: 'change-a', input: {amount: 750}}, 'bob');
    assert.equal(created.status, 'pending');
    assert.equal(created.evidence.complete, true);
    assert.equal(created.evidence.replay.matches, true);

    // live data is changed by someone else via the direct path
    await req(server.base, 'PUT', '/api/source', {id: 'change-a', value: {amount: 9999}}, 'alice');

    // carol opens the review page: snapshot intact, diff visible, conflict flagged
    const view = await req(server.base, 'GET', '/api/submissions/1', undefined, 'carol');
    assert.deepEqual(view.snapshot.input, {amount: 750});
    assert.deepEqual(view.snapshot.baseValue, {amount: 10});
    assert.equal(view.sourceMoved, true);
    assert.equal(view.conflict.currentVersion, 2);
    assert.ok(view.diff.baseToCurrent.some((d) => d.path === 'amount'));
    assert.equal(view.evidence.replay.matches, true);

    // approving without acknowledgment is rejected — conflict never passes silently
    await assert.rejects(
      () => req(server.base, 'POST', '/api/decisions', {submissionId: 1, outcome: 'approved'}, 'carol'),
      (err) => err.code === 'CONFLICT',
    );

    // acknowledge + approve
    const decision = await req(server.base, 'POST', '/api/decisions',
      {submissionId: 1, outcome: 'approved', reason: 'frozen value verified', allowConflict: true}, 'carol');
    assert.equal(decision.outcome, 'approved');
    assert.equal(decision.conflictAcknowledged, true);
    assert.equal(decision.currentVersionAtDecision, 2);
    assert.equal(decision.sourceVersion, 1);
    assert.match(decision.actedOnSnapshotDigest, /^[0-9a-f]{64}$/);

    // executed object is the FROZEN proposed value, not 9999
    const state = await req(server.base, 'GET', '/api/state?viewer=carol');
    assert.deepEqual(state.current['change-a'].value, {amount: 750});
    assert.equal(state.current['change-a'].version, 3);
    const finished = state.submissions.find((s) => s.id === 1);
    assert.equal(finished.status, 'approved');
    assert.equal(finished.result.appliedVersion, 3);
    // history decision is replayable after the fact
    assert.equal(finished.history.length, 1);
    assert.equal(finished.history[0].actedOnSnapshotDigest, decision.actedOnSnapshotDigest);
  } finally {
    await server.close();
  }
});

test('duplicate decision, withdrawal and permission changes return explicit codes over HTTP', async () => {
  let store = updateSource(createApprovalStore(), 'change-a', {amount: 10});
  const server = await startServer(store);
  try {
    await req(server.base, 'POST', '/api/submissions', {objectId: 'change-a', input: {amount: 50}}, 'bob');
    await req(server.base, 'POST', '/api/decisions', {submissionId: 1, outcome: 'approved'}, 'alice');

    const dup = await req(server.base, 'POST', '/api/decisions', {submissionId: 1, outcome: 'rejected'}, 'alice', true);
    assert.equal(dup.response.status, 409);
    assert.equal(dup.data.code, 'DECISION_CONFLICT');

    // a second pending submission for permission/withdrawal checks
    await req(server.base, 'POST', '/api/submissions', {objectId: 'change-a', input: {amount: 60}}, 'bob');
    const wrongOwner = await req(server.base, 'POST', '/api/submissions/2/withdraw', {}, 'alice', true);
    assert.equal(wrongOwner.data.code, 'PERMISSION_DENIED');

    // revoke alice's approval right mid-flight
    await req(server.base, 'PUT', '/api/permissions', {actor: 'alice', permissions: {canSubmit: true, canApprove: false}}, 'admin');
    const denied = await req(server.base, 'POST', '/api/decisions', {submissionId: 2, outcome: 'approved'}, 'alice', true);
    assert.equal(denied.data.code, 'PERMISSION_DENIED');

    // owner withdraw succeeds; a second withdraw is NOT_PENDING
    await req(server.base, 'POST', '/api/submissions/2/withdraw', {}, 'bob');
    const again = await req(server.base, 'POST', '/api/submissions/2/withdraw', {}, 'bob', true);
    assert.equal(again.data.code, 'NOT_PENDING');
  } finally {
    await server.close();
  }
});

test('legacy direct endpoints remain compatible end to end', async () => {
  const server = await startServer(createApprovalStore());
  try {
    const saved = await req(server.base, 'PUT', '/api/source', {id: 'change-a', value: {amount: 10}});
    assert.equal(saved.version, 1);
    const sub = await req(server.base, 'POST', '/api/submissions', {id: 'change-a', evidence: {rule: 'r1'}});
    assert.equal(sub.status, 'pending');
    assert.equal(sub.mode, 'legacy');
    const decision = await req(server.base, 'POST', '/api/decisions', {submissionId: sub.id, outcome: 'approved'});
    assert.equal(decision.sourceVersion, 1);

    // legacy aggregate endpoint shape preserved
    const approvals = await req(server.base, 'GET', '/api/approvals');
    assert.ok(approvals.current instanceof Array);
    assert.ok(approvals.decisions instanceof Array);

    // legacy conflict behavior preserved: submit based on v1, then source moves
    await req(server.base, 'POST', '/api/submissions', {id: 'change-a', evidence: {rule: 'r1'}});
    await req(server.base, 'PUT', '/api/source', {id: 'change-a', value: {amount: 2}});
    const blocked = await req(server.base, 'POST', '/api/decisions', {submissionId: 2, outcome: 'approved'}, undefined, true);
    assert.equal(blocked.data.code, 'SOURCE_CHANGED');
  } finally {
    await server.close();
  }
});

test('evidence problems are exposed per-field for a partially frozen submission', async () => {
  // Simulate a partially-migrated/corrupted historical row: submit freezes
  // everything, then the stored row loses its input and digest.
  let preloaded = updateSource(createApprovalStore(), 'o', {amount: 1});
  preloaded = submit(preloaded, {objectId: 'o', input: {amount: 2}, submittedBy: 'bob', registry: createDefaultRegistry()});
  delete preloaded.submissions.get(1).snapshot.input;
  delete preloaded.submissions.get(1).snapshot.digest;
  const server = await startServer(preloaded);
  try {
    const view = await req(server.base, 'GET', '/api/submissions/1');
    assert.equal(view.evidence.complete, false);
    const fields = view.evidence.problems.map((p) => p.field);
    assert.ok(fields.includes('input'), `expected input in problems, got ${fields}`);
    assert.ok(fields.includes('digest'));
    assert.equal(view.evidence.replay, null, 'page is told replay is unavailable, not given fake data');

    // deciding on it is refused
    const blocked = await req(server.base, 'POST', '/api/decisions', {submissionId: 1, outcome: 'approved'}, 'alice', true);
    assert.equal(blocked.data.code, 'EVIDENCE_MISSING');
  } finally {
    await server.close();
  }
});

test('SSE pushes ledger events on mutations in real time', async () => {
  const server = await startServer(createApprovalStore());
  try {
    const ac = new AbortController();
    const response = await fetch(`${server.base}/api/events`, {signal: ac.signal, headers: {accept: 'text/event-stream'}});
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const readEvent = async () => {
      while (!buffered.includes('\n\n')) {
        const {value, done} = await reader.read();
        if (done) throw new Error('stream ended');
        buffered += decoder.decode(value, {stream: true});
      }
      const chunk = buffered.slice(0, buffered.indexOf('\n\n') + 2);
      buffered = buffered.slice(buffered.indexOf('\n\n') + 2);
      return chunk;
    };
    const hello = await readEvent();
    assert.match(hello, /event: hello/);

    await req(server.base, 'PUT', '/api/source', {id: 'o', value: 1});
    const pushed = await readEvent();
    assert.match(pushed, /event: ledger/);
    assert.match(pushed, /source-updated/);
    ac.abort();
    reader.cancel().catch(() => {});
  } finally {
    await server.close();
  }
});

test('unknown rule version and malformed payloads produce structured errors', async () => {
  const server = await startServer(createApprovalStore());
  try {
    await req(server.base, 'PUT', '/api/source', {id: 'o', value: {amount: 1}});
    const badRule = await req(server.base, 'POST', '/api/submissions',
      {objectId: 'o', input: {amount: 1}, rule: {ruleId: 'nope', version: 9}}, 'bob', true);
    assert.equal(badRule.data.code, 'RULE_VERSION_UNKNOWN');

    const badOutcome = await req(server.base, 'POST', '/api/submissions', {objectId: 'o', input: {amount: 1}}, 'bob');
    const bad = await req(server.base, 'POST', '/api/decisions', {submissionId: badOutcome.id, outcome: 'maybe'}, 'alice', true);
    assert.equal(bad.response.status, 400);
    assert.equal(bad.data.code, 'INVALID_OUTCOME');
  } finally {
    await server.close();
  }
});

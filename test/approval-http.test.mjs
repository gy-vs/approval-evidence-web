import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.mjs';

async function startServer() {
  const created = createApp({persistFile: null, seed: true});
  await created.load();
  await new Promise((resolve) => created.app.listen(0, resolve));
  const port = created.app.address().port;
  return {port, holder: created.store, close: () => created.close()};
}

function api(port, path, {method = 'GET', body, actor, headers} = {}) {
  return fetch(`http://localhost:${port}${path}`, {
    method,
    headers: {'content-type': 'application/json', ...(actor ? {'x-actor': actor} : {}), ...headers},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const evidenceBody = (overrides = {}) => ({
  inputs: {form: {amount: 20, reason: 'bump'}, computed: {delta: 10}},
  ruleVersion: 'amount-rule/v1',
  summary: {proposedAmount: 20, delta: 10, ruleOutput: {withinLimit: true}},
  ...overrides,
});

const submissionBody = (overrides = {}) => ({
  objectId: 'change-a',
  proposedValue: {amount: 20},
  actor: 'alice',
  ...evidenceBody(),
  ...overrides,
});

/* ---------- direct-save compatibility ---------- */

test('HTTP: legacy PUT /api/source direct save still works and versions the object', async () => {
  const {port, close} = await startServer();
  try {
    const res = await api(port, '/api/source', {method: 'PUT', body: {id: 'change-a', value: {amount: 77}}});
    assert.equal(res.status, 200);
    const current = await res.json();
    assert.equal(current.version, 2);
    assert.deepEqual(current.value, {amount: 77});
  } finally {
    await close();
  }
});

test('HTTP: legacy submissions and decisions shapes keep working without an actor', async () => {
  const {port, close} = await startServer();
  try {
    const res = await api(port, '/api/submissions', {method: 'POST', body: {id: 'change-a', evidence: {rule: 'r1'}}});
    assert.equal(res.status, 201);
    const submission = await res.json();    const decision = await api(port, '/api/decisions', {method: 'POST', body: {submissionId: submission.id, outcome: 'approved'}});
    assert.equal(decision.status, 201);
    const body = await decision.json();
    assert.equal(body.sourceVersion, 1);
  } finally {
    await close();
  }
});

/* ---------- freeze vs live data ---------- */

test('HTTP: changing current data after submission does not overwrite frozen evidence', async () => {
  const {port, close} = await startServer();
  try {
    const created = await api(port, '/api/submissions', {method: 'POST', body: submissionBody()});
    assert.equal(created.status, 201);
    const {id} = await created.json();

    // source data moves on while the approval is pending
    const save = await api(port, '/api/source', {method: 'PUT', body: {id: 'change-a', value: {amount: 99}}});
    assert.equal(save.status, 200);

    const detail = await (await api(port, `/api/submissions/${id}`)).json();
    assert.equal(detail.submission.baseVersion, 1);
    assert.equal(detail.submission.headVersion, 2);
    assert.equal(detail.submission.stale, true);
    assert.deepEqual(detail.submission.evidence.inputs.form, {amount: 20, reason: 'bump'});
    assert.equal(detail.verification.objectChanged, true);
    assert.equal(detail.verification.ok, true);
    assert.deepEqual(detail.diff.paths, ['amount']);
  } finally {
    await close();
  }
});

test('HTTP: approval after drift is a 409 conflict and acts on neither version', async () => {
  const {port, close} = await startServer();
  try {
    const created = await (await api(port, '/api/submissions', {method: 'POST', body: submissionBody()})).json();
    await api(port, '/api/source', {method: 'PUT', body: {id: 'change-a', value: {amount: 99}}});

    const res = await api(port, '/api/decisions', {
      method: 'POST',
      actor: 'bob',
      body: {submissionId: created.id, action: 'approve'},
    });
    assert.equal(res.status, 409);
    const error = await res.json();
    assert.equal(error.code, 'conflict');
    assert.equal(error.details.code, 'version-conflict');
    assert.equal(error.details.baseVersion, 1);
    assert.equal(error.details.headVersion, 2);

    const after = await (await api(port, '/api/approvals', {actor: 'bob'})).json();
    assert.equal(after.submissions[0].status, 'pending'); // not silently terminal
    assert.deepEqual(after.objects[0].value, {amount: 99}); // v2 untouched
    assert.equal(after.decisions.length, 0); // no decision recorded from the failed approve
  } finally {
    await close();
  }
});

test('HTTP: a clean approval applies the frozen proposal and the object records provenance', async () => {
  const {port, close} = await startServer();
  try {
    const created = await (await api(port, '/api/submissions', {method: 'POST', body: submissionBody()})).json();
    const res = await api(port, '/api/decisions', {
      method: 'POST',
      actor: 'bob',
      body: {submissionId: created.id, action: 'approve', reason: 'ok'},
    });
    assert.equal(res.status, 201);
    const decision = await res.json();
    assert.equal(decision.execution.applied, true);
    assert.equal(decision.execution.version, 2);
    assert.equal(decision.basis.sourceVersion, 1);

    const history = await (await api(port, '/api/objects/change-a/history')).json();
    assert.deepEqual(history.versions.map((v) => v.version), [1, 2]);
    assert.equal(history.versions[1].via.type, 'approval');
    assert.equal(history.versions[1].via.submissionId, created.id);
    assert.deepEqual(history.versions[1].value, {amount: 20});
  } finally {
    await close();
  }
});

/* ---------- state and exception chain ---------- */

test('HTTP: duplicate approve, supersession and permission revoke all return explicit states', async () => {
  const {port, close} = await startServer();
  try {
    const first = await (await api(port, '/api/submissions', {
      method: 'POST',
      body: submissionBody({actor: 'alice'}),
    })).json();

    // concurrent newer submission on a new base
    await api(port, '/api/source', {method: 'PUT', body: {id: 'change-a', value: {amount: 11}}});
    const second = await (await api(port, '/api/submissions', {
      method: 'POST',
      body: submissionBody({proposedValue: {amount: 30}, actor: 'bob'}),
    })).json();
    assert.equal(second.id, first.id + 1);

    // old approval cannot act on the newer version
    const superseded = await api(port, '/api/decisions', {
      method: 'POST', actor: 'bob', body: {submissionId: first.id, action: 'approve'},
    });
    assert.equal(superseded.status, 409);
    assert.equal((await superseded.json()).details.code, 'superseded');

    // approve the newer one, then repeat it
    const approved = await api(port, '/api/decisions', {
      method: 'POST', actor: 'bob', body: {submissionId: second.id, action: 'approve'},
    });
    assert.equal(approved.status, 201);
    const duplicate = await api(port, '/api/decisions', {
      method: 'POST', actor: 'bob', body: {submissionId: second.id, action: 'approve'},
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).details.code, 'already-decided');

    // permission changed mid-flight: revoke bob, his next decision anywhere is forbidden
    const grant = await api(port, '/api/grants', {
      method: 'PUT', body: {actor: 'bob', permission: 'approve', granted: false},
    });
    assert.equal(grant.status, 200);
    const forbidden = await api(port, '/api/decisions', {
      method: 'POST', actor: 'bob', body: {submissionId: first.id, action: 'reject'},
    });
    assert.equal(forbidden.status, 403);

    // carol never had approve rights
    const carol = await api(port, '/api/decisions', {
      method: 'POST', actor: 'carol', body: {submissionId: first.id, action: 'reject'},
    });
    assert.equal(carol.status, 403);
  } finally {
    await close();
  }
});

test('HTTP: withdraw is permitted for the submitter and forbidden for others', async () => {
  const {port, close} = await startServer();
  try {
    const created = await (await api(port, '/api/submissions', {
      method: 'POST', body: submissionBody({actor: 'alice'}),
    })).json();
    const notAllowed = await api(port, '/api/decisions', {
      method: 'POST', actor: 'carol', body: {submissionId: created.id, action: 'withdraw'},
    });
    assert.equal(notAllowed.status, 403);
    const withdrawn = await api(port, '/api/decisions', {
      method: 'POST', actor: 'alice', body: {submissionId: created.id, action: 'withdraw'},
    });
    assert.equal(withdrawn.status, 201);
    assert.equal((await withdrawn.json()).status, 'withdrawn');
  } finally {
    await close();
  }
});

test('HTTP: submitting with missing evidence is a 400 naming the missing paths', async () => {
  const {port, close} = await startServer();
  try {
    const res = await api(port, '/api/submissions', {
      method: 'POST',
      body: {objectId: 'change-a', proposedValue: {amount: 20}, actor: 'alice', ruleVersion: 'amount-rule/v1'},
    });
    assert.equal(res.status, 400);
    const error = await res.json();
    assert.equal(error.code, 'invalid-evidence');
    assert.ok(error.details.missing.includes('inputs'));
    assert.ok(error.details.missing.includes('summary'));
  } finally {
    await close();
  }
});

/* ---------- replay ---------- */

test('HTTP: decision replay shows frozen basis, execution target and later drift', async () => {
  const {port, close} = await startServer();
  try {
    const created = await (await api(port, '/api/submissions', {method: 'POST', body: submissionBody()})).json();
    await api(port, '/api/decisions', {method: 'POST', actor: 'bob', body: {submissionId: created.id, action: 'approve'}});
    await api(port, '/api/source', {method: 'PUT', body: {id: 'change-a', value: {amount: 500}}});

    const replay = await (await api(port, '/api/decisions/1/replay')).json();
    assert.equal(replay.decision.status, 'approved');
    assert.deepEqual(replay.frozen.baseValue, {amount: 10});
    assert.deepEqual(replay.frozen.proposedValue, {amount: 20});
    assert.equal(replay.frozen.evidence.ruleBody.body.maxAmount, 1000);
    assert.equal(replay.execution.version, 2);
    assert.equal(replay.current.version, 3);
    assert.deepEqual(replay.current.value, {amount: 500});
    assert.equal(replay.diff.changed, true);
  } finally {
    await close();
  }
});

test('HTTP: damaged evidence is located by verification and blocks the decision', async () => {
  const {port, holder, close} = await startServer();
  try {
    const created = await (await api(port, '/api/submissions', {method: 'POST', body: submissionBody()})).json();

    // Simulate storage damage: the summary goes missing and inputs are edited after the fact.
    const stored = holder.current.submissions.get(created.id);
    stored.evidence.summary = null;
    stored.evidence.inputs.form.amount = 999;

    const detail = await (await api(port, `/api/submissions/${created.id}`)).json();
    assert.equal(detail.verification.ok, false);
    assert.deepEqual(detail.verification.missing, ['evidence.summary']);
    assert.deepEqual(detail.verification.tampered, ['evidence.inputs']);

    const decision = await api(port, '/api/decisions', {
      method: 'POST', actor: 'bob', body: {submissionId: created.id, action: 'approve'},
    });
    assert.equal(decision.status, 422);
    const error = await decision.json();
    assert.equal(error.code, 'corrupt-evidence');
    assert.deepEqual(error.details.missing, ['evidence.summary']);
    assert.deepEqual(error.details.tampered, ['evidence.inputs']);

    // damaged evidence can still be withdrawn by the submitter
    const withdrawn = await api(port, '/api/decisions', {
      method: 'POST', actor: 'alice', body: {submissionId: created.id, action: 'withdraw'},
    });
    assert.equal(withdrawn.status, 201);
  } finally {
    await close();
  }
});

/* ---------- real-time ---------- */

test('HTTP: SSE pushes ledger events to connected reviewers', async () => {
  const {port, close} = await startServer();
  try {
    const overview = await (await api(port, '/api/approvals')).json();
    const controller = new AbortController();
    const stream = await fetch(`http://localhost:${port}/api/events?since=${overview.eventSeq}`, {signal: controller.signal, headers: {accept: 'text/event-stream'}});
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readEvent = async () => {
      while (!buffer.includes('\n\n')) {
        const {value, done} = await reader.read();
        if (done) throw new Error('stream closed');
        buffer += decoder.decode(value);
      }
      const chunk = buffer.slice(0, buffer.indexOf('\n\n'));
      buffer = buffer.slice(buffer.indexOf('\n\n') + 2);
      return JSON.parse(chunk.replace(/^data: /, ''));
    };
    assert.equal((await readEvent()).type, 'hello');

    await api(port, '/api/source', {method: 'PUT', body: {id: 'change-a', value: {amount: 42}}});
    const event = await readEvent();
    assert.equal(event.type, 'source-updated');
    assert.equal(event.objectId, 'change-a');
    assert.ok(event.overviewSeq > 0);

    controller.abort();
    try { await reader.read(); } catch {}
  } finally {
    await close();
  }
});

test('HTTP: SSE replays events missed since the given sequence', async () => {
  const {port, close} = await startServer();
  try {
    await api(port, '/api/source', {method: 'PUT', body: {id: 'change-a', value: {amount: 42}}});
    const overview = await (await api(port, '/api/approvals')).json();
    const since = overview.eventSeq - 1;

    const res = await fetch(`http://localhost:${port}/api/events?since=${since}`);
    const reader = res.body.getReader();
    const text = new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /"replay":true/);
    assert.match(text, /source-updated/);
    await reader.cancel();
  } finally {
    await close();
  }
});

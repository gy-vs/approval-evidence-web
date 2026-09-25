import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalOverview,
  createApprovalStore,
  decide,
  defineRule,
  deserialize,
  getCurrent,
  LedgerError,
  objectHistory,
  replayDecision,
  serialize,
  setGrant,
  snapshotDiff,
  submit,
  submissionView,
  updateSource,
  verifySnapshot,
} from '../src/approval-ledger.mjs';

function seeded() {
  let store = createApprovalStore();
  store = defineRule(store, {version: 'amount-rule/v1', name: 'Amount rule', body: {maxAmount: 1000, requireReason: true}});
  store = setGrant(store, 'alice', 'submit', true);
  store = setGrant(store, 'bob', 'submit', true);
  store = setGrant(store, 'bob', 'approve', true);
  store = setGrant(store, 'bob', 'withdraw.any', true);
  store = updateSource(store, 'change-a', {amount: 10});
  return store;
}

const evidence = (overrides = {}) => ({
  inputs: {form: {amount: 20, reason: 'bump'}, computed: {delta: 10}},
  ruleVersion: 'amount-rule/v1',
  summary: {proposedAmount: 20, delta: 10, ruleOutput: {withinLimit: true}},
  ...overrides,
});

/* ----------------------- legacy compatibility ----------------------- */

test('legacy: a decision is tied to the submitted source version', () => {
  let store = updateSource(createApprovalStore(), 'change-a', {value: 1});
  store = submit(store, 'change-a', {rule: 'r1'});
  assert.equal(decide(store, 1, 'approved').decisions[0].sourceVersion, 1);
});

test('legacy: a changed source invalidates an old approval', () => {
  let store = updateSource(createApprovalStore(), 'change-a', {value: 1});
  store = submit(store, 'change-a', {rule: 'r1'});
  store = updateSource(store, 'change-a', {value: 2});
  assert.throws(() => decide(store, 1, 'approved'), /changed/);
});

test('legacy direct save keeps appending versions without evidence', () => {
  let store = updateSource(createApprovalStore(), 'o', {amount: 1});
  store = updateSource(store, 'o', {amount: 2});
  assert.deepEqual(getCurrent(store, 'o'), {id: 'o', version: 2, value: {amount: 2}});
});

/* ----------------------- evidence freeze ----------------------- */

test('submission freezes inputs, rule version/body and a digest summary', () => {
  let store = seeded();
  store = submit(store, {objectId: 'change-a', proposedValue: {amount: 20}, actor: 'alice', ...evidence()});
  const view = submissionView(store, store.submissions.get(1), 'alice');
  assert.equal(view.baseVersion, 1);
  assert.equal(view.evidence.ruleVersion, 'amount-rule/v1');
  assert.deepEqual(view.evidence.ruleBody.body, {maxAmount: 1000, requireReason: true});
  assert.match(view.evidence.digest, /^[a-f0-9]{64}$/);
  assert.equal(view.evidence.digests.inputs.length, 64);
});

test('live data changing does not overwrite the frozen basis', () => {
  let store = seeded();
  store = submit(store, {objectId: 'change-a', proposedValue: {amount: 20}, actor: 'alice', ...evidence()});
  store = updateSource(store, 'change-a', {amount: 99});

  const frozen = store.submissions.get(1);
  assert.deepEqual(frozen.baseValue, {amount: 10});
  assert.deepEqual(frozen.proposedValue, {amount: 20});
  assert.deepEqual(frozen.evidence.inputs, {form: {amount: 20, reason: 'bump'}, computed: {delta: 10}});

  const verification = verifySnapshot(store, 1);
  assert.equal(verification.ok, true);
  assert.equal(verification.objectChanged, true);
  assert.deepEqual(snapshotDiff(store, 1).paths, ['amount']);
  assert.equal(getCurrent(store, 'change-a').value.amount, 99);
});

test('freezing a rule captures its body; later registering the same version with another body fails', () => {
  let store = seeded();
  store = submit(store, {objectId: 'change-a', proposedValue: {amount: 20}, actor: 'alice', ...evidence()});
  assert.throws(
    () => defineRule(store, {version: 'amount-rule/v1', name: 'Amount rule', body: {maxAmount: 5}}),
    (error) => error instanceof LedgerError && error.code === 'invalid-rule',
  );
  // identical re-registration is a no-op
  const same = defineRule(store, {version: 'amount-rule/v1', name: 'Amount rule', body: {maxAmount: 1000, requireReason: true}});
  assert.equal(same, store);
});

test('an unknown rule version is allowed but flagged by verification', () => {
  let store = seeded();
  store = submit(store, {objectId: 'change-a', proposedValue: {amount: 20}, actor: 'alice', ...evidence({ruleVersion: 'future-rule/v9'})});
  const verification = verifySnapshot(store, 1);
  assert.equal(verification.ok, true);
  assert.equal(verification.ruleKnown, false);
});

/* ----------------------- version conflicts ----------------------- */

test('approving after the source changed fails explicitly and leaves both versions untouched', () => {
  let store = seeded();
  store = submit(store, {objectId: 'change-a', proposedValue: {amount: 20}, actor: 'alice', ...evidence()});
  store = updateSource(store, 'change-a', {amount: 99});

  assert.throws(
    () => decide(store, {submissionId: 1, action: 'approve', actor: 'bob'}),
    (error) => {
      assert.ok(error instanceof LedgerError);
      assert.equal(error.code, 'conflict');
      assert.equal(error.details.code, 'version-conflict');
      assert.equal(error.details.baseVersion, 1);
      assert.equal(error.details.headVersion, 2);
      return true;
    },
  );
  // failed approve mutates nothing
  assert.equal(store.submissions.get(1).status, 'pending');
  assert.deepEqual(getCurrent(store, 'change-a').value, {amount: 99});
  assert.equal(store.decisions.length, 0);
});

test('a successful approve applies the frozen proposal as a new version with provenance', () => {
  let store = seeded();
  store = submit(store, {objectId: 'change-a', proposedValue: {amount: 20}, actor: 'alice', ...evidence()});
  const digestBefore = store.submissions.get(1).evidence.digest;
  store = decide(store, {submissionId: 1, action: 'approve', actor: 'bob', reason: 'ok'});

  const current = getCurrent(store, 'change-a');
  assert.equal(current.version, 2);
  assert.deepEqual(current.value, {amount: 20});
  const applied = objectHistory(store, 'change-a').versions.at(-1);
  assert.deepEqual(applied.via, {type: 'approval', submissionId: 1, decisionSeq: 1, baseVersion: 1, evidenceDigest: digestBefore});
  assert.equal(applied.by, 'bob');

  const decision = store.decisions[0];
  assert.equal(decision.status, 'approved');
  assert.equal(decision.execution.applied, true);
  assert.equal(decision.execution.version, 2);
  assert.equal(decision.basis.evidenceDigest, digestBefore);
  assert.equal(decision.basis.sourceVersion, 1);
});

test('submitting against a stale base version conflicts instead of silently queueing', () => {
  let store = seeded();
  store = updateSource(store, 'change-a', {amount: 11}); // head v2
  assert.throws(
    () => submit(store, {objectId: 'change-a', proposedValue: {amount: 20}, baseVersion: 1, actor: 'alice', ...evidence()}),
    (error) => error.code === 'conflict' && error.details.code === 'stale-base',
  );
});

/* ----------------------- concurrent submissions ----------------------- */

test('a newer pending submission supersedes older pending ones, which cannot be approved', () => {
  let store = seeded();
  store = submit(store, {objectId: 'change-a', proposedValue: {amount: 20}, actor: 'alice', ...evidence({summary: {proposedAmount: 20, delta: 10, ruleOutput: {withinLimit: true}}})});
  store = updateSource(store, 'change-a', {amount: 11});
  store = submit(store, {objectId: 'change-a', proposedValue: {amount: 30}, actor: 'bob', ...evidence({summary: {proposedAmount: 30, delta: 19, ruleOutput: {withinLimit: true}}})});

  assert.equal(store.submissions.get(1).status, 'superseded');
  assert.equal(store.submissions.get(1).supersededBy, 2);
  assert.equal(store.submissions.get(2).status, 'pending');
  assert.equal(store.submissions.get(2).baseVersion, 2);

  assert.throws(
    () => decide(store, {submissionId: 1, action: 'approve', actor: 'bob'}),
    (error) => error.code === 'conflict' && error.details.code === 'superseded',
  );
  // rejecting the stale one remains possible so the queue is explicit
  store = decide(store, {submissionId: 1, action: 'reject', actor: 'bob'});
  assert.equal(store.submissions.get(1).status, 'rejected');
  // and the newer one can still be approved, acting only on v2
  store = decide(store, {submissionId: 2, action: 'approve', actor: 'bob'});
  assert.deepEqual(getCurrent(store, 'change-a').value, {amount: 30});
});

/* ----------------------- duplicate / terminal states ----------------------- */

test('duplicate decisions are rejected with the existing status', () => {
  let store = seeded();
  store = submit(store, {objectId: 'change-a', proposedValue: {amount: 20}, actor: 'alice', ...evidence()});
  store = decide(store, {submissionId: 1, action: 'approve', actor: 'bob'});
  assert.throws(
    () => decide(store, {submissionId: 1, action: 'approve', actor: 'bob'}),
    (error) => error.code === 'conflict' && error.details.code === 'already-decided' && /already approved/.test(error.message),
  );
  assert.throws(() => decide(store, {submissionId: 1, action: 'reject', actor: 'bob'}), /already approved/);
  assert.throws(() => decide(store, {submissionId: 1, action: 'withdraw', actor: 'alice'}), /already approved/);
});

test('the submitter can withdraw; nobody else can; withdrawal is terminal and recorded', () => {
  let store = seeded();
  store = submit(store, {objectId: 'change-a', proposedValue: {amount: 20}, actor: 'alice', ...evidence()});
  assert.throws(
    () => decide(store, {submissionId: 1, action: 'withdraw', actor: 'carol'}),
    (error) => error.code === 'forbidden',
  );
  store = decide(store, {submissionId: 1, action: 'withdraw', actor: 'alice'});
  assert.equal(store.submissions.get(1).status, 'withdrawn');
  assert.equal(store.decisions[0].basis.sourceVersion, 1);
  // withdrawal does not execute anything
  assert.equal(getCurrent(store, 'change-a').version, 1);
});

/* ----------------------- permission changes mid-flight ----------------------- */

test('revoking approve permission blocks a pending decision but keeps history', () => {
  let store = seeded();
  store = submit(store, {objectId: 'change-a', proposedValue: {amount: 20}, actor: 'alice', ...evidence()});
  store = setGrant(store, 'bob', 'approve', false);
  assert.throws(
    () => decide(store, {submissionId: 1, action: 'approve', actor: 'bob'}),
    (error) => error.code === 'forbidden' && error.details.permission === 'approve',
  );
  assert.equal(store.submissions.get(1).status, 'pending');
});

test('an actor without submit permission cannot create a submission', () => {
  const store = seeded(); // carol explicitly has submit=false
  assert.throws(
    () => submit(store, {objectId: 'change-a', proposedValue: {amount: 50}, actor: 'carol', ...evidence()}),
    (error) => error.code === 'forbidden',
  );
});

/* ----------------------- evidence damage localization ----------------------- */

test('verification locates missing evidence fields', () => {
  let store = seeded();
  store = submit(store, {objectId: 'change-a', proposedValue: {amount: 20}, actor: 'alice', ...evidence()});
  store.submissions.get(1).evidence.summary = null;
  store.submissions.get(1).evidence.inputs = undefined;

  const verification = verifySnapshot(store, 1);
  assert.equal(verification.ok, false);
  assert.deepEqual(verification.missing.sort(), ['evidence.inputs', 'evidence.summary']);
  assert.throws(
    () => decide(store, {submissionId: 1, action: 'approve', actor: 'bob'}),
    (error) => error.code === 'corrupt-evidence' && error.details.missing.includes('evidence.summary'),
  );
  // submitter can still pull damaged evidence back
  store = decide(store, {submissionId: 1, action: 'withdraw', actor: 'alice'});
  assert.equal(store.submissions.get(1).status, 'withdrawn');
});

test('verification detects tampered evidence digests and pinpoints the field', () => {
  let store = seeded();
  store = submit(store, {objectId: 'change-a', proposedValue: {amount: 20}, actor: 'alice', ...evidence()});
  store.submissions.get(1).evidence.inputs.form.amount = 999;
  store.submissions.get(1).proposedValue = {amount: 999};

  const verification = verifySnapshot(store, 1);
  assert.deepEqual(verification.tampered.sort(), ['evidence.inputs', 'evidence.proposedValue']);
  assert.throws(() => decide(store, {submissionId: 1, action: 'approve', actor: 'bob'}), /tampered/);
});

test('the API rejects submissions with incomplete evidence and names the paths', () => {
  const store = seeded();
  assert.throws(
    () => submit(store, {objectId: 'change-a', proposedValue: {amount: 20}, actor: 'alice', ruleVersion: 'r/v1'}),
    (error) => error.code === 'invalid-evidence' && error.details.missing.includes('inputs') && error.details.missing.includes('summary'),
  );
});

/* ----------------------- replay / persistence ----------------------- */

test('a recorded decision replays against its frozen basis after further data changes', () => {
  let store = seeded();
  store = submit(store, {objectId: 'change-a', proposedValue: {amount: 20}, actor: 'alice', ...evidence()});
  store = decide(store, {submissionId: 1, action: 'approve', actor: 'bob', reason: 'looks good'});
  // current data keeps moving after the approval is over
  store = updateSource(store, 'change-a', {amount: 500});
  store = updateSource(store, 'change-a', {amount: 600});

  const replay = replayDecision(store, 1);
  assert.equal(replay.decision.action, 'approve');
  assert.equal(replay.decision.actor, 'bob');
  assert.deepEqual(replay.frozen.baseValue, {amount: 10});
  assert.deepEqual(replay.frozen.proposedValue, {amount: 20});
  assert.equal(replay.frozen.evidence.ruleVersion, 'amount-rule/v1');
  assert.equal(replay.execution.version, 2);
  assert.equal(replay.current.version, 4);
  assert.equal(replay.diff.changed, true);
  assert.equal(replay.verification.ok, true);
});

test('rejecting after source drift is allowed, stays pending-safe and binds to the snapshot', () => {
  let store = seeded();
  store = submit(store, {objectId: 'change-a', proposedValue: {amount: 20}, actor: 'alice', ...evidence()});
  store = updateSource(store, 'change-a', {amount: 99});
  store = decide(store, {submissionId: 1, action: 'reject', actor: 'bob', reason: 'drifted'});
  // nothing was executed; head stays at v2
  assert.equal(getCurrent(store, 'change-a').version, 2);
  const replay = replayDecision(store, 1);
  assert.equal(replay.decision.status, 'rejected');
  assert.equal(replay.decision.basis.sourceVersion, 1);
  assert.equal(replay.execution, null);
});

test('serialize/deserialize round-trips the ledger and verification still passes', () => {
  let store = seeded();
  store = submit(store, {objectId: 'change-a', proposedValue: {amount: 20}, actor: 'alice', ...evidence()});
  store = decide(store, {submissionId: 1, action: 'approve', actor: 'bob'});
  const restored = deserialize(serialize(store));
  assert.equal(restored.submissions.get(1).evidence.digest, store.submissions.get(1).evidence.digest);
  assert.equal(verifySnapshot(restored, 1).ok, true);
  assert.deepEqual(getCurrent(restored, 'change-a').value, {amount: 20});
  assert.equal(approvalOverview(restored, 'bob').decisions.length, 1);
});

test('capabilities surface why an action is unavailable rather than hiding it', () => {
  let store = seeded();
  store = submit(store, {objectId: 'change-a', proposedValue: {amount: 20}, actor: 'alice', ...evidence()});
  const carolView = submissionView(store, store.submissions.get(1), 'carol');
  assert.deepEqual(carolView.can, {approve: false, reject: false, withdraw: false});
  const aliceView = submissionView(store, store.submissions.get(1), 'alice');
  assert.deepEqual(aliceView.can, {approve: false, reject: false, withdraw: true});
  const bobView = submissionView(store, store.submissions.get(1), 'bob');
  assert.deepEqual(bobView.can, {approve: true, reject: true, withdraw: true});
});

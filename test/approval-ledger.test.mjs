import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createApprovalStore, createDefaultRegistry, decide, setPermission, submit, updateSource, withdraw,
} from '../src/approval-ledger.mjs';
import {checkEvidence, freezeSnapshot, replaySnapshot} from '../src/evidence.mjs';
import {registerRule} from '../src/rules.mjs';

function frozenSubmit(store, objectId, input, submittedBy = 'bob', rule) {
  return submit(store, {objectId, input, submittedBy, rule, registry: createDefaultRegistry()});
}

// Data-plane clone used to simulate corrupted/partially-migrated stored rows.
function corruptClone(store) {
  const {now, ...data} = store;
  const next = structuredClone(data);
  next.now = now;
  return next;
}

test('a decision is tied to the submitted source version (legacy contract)', () => {
  let store = updateSource(createApprovalStore(), 'change-a', {value: 1});
  store = submit(store, 'change-a', {rule: 'r1'});
  assert.equal(decide(store, 1, 'approved').decisions[0].sourceVersion, 1);
});

test('a changed source invalidates an old approval (legacy contract)', () => {
  let store = updateSource(createApprovalStore(), 'change-a', {value: 1});
  store = submit(store, 'change-a', {rule: 'r1'});
  store = updateSource(store, 'change-a', {value: 2});
  assert.throws(() => decide(store, 1, 'approved'), /changed/);
});

test('frozen evidence stores input, rule version and digests independent of live data', () => {
  let store = updateSource(createApprovalStore(), 'change-a', {amount: 10});
  store = submit(store, {objectId: 'change-a', input: {amount: 750}, submittedBy: 'bob', registry: createDefaultRegistry()});
  store = updateSource(store, 'change-a', {amount: 999});
  const sub = store.submissions.get(1);
  assert.deepEqual(sub.snapshot.input, {amount: 750}, 'input stays frozen');
  assert.deepEqual(sub.snapshot.baseValue, {amount: 10}, 'base value stays frozen');
  assert.deepEqual(sub.snapshot.proposedValue, {amount: 750}, 'proposed value frozen at submit');
  assert.equal(sub.snapshot.rule.version, 1);
  assert.match(sub.snapshot.rule.digest, /^[0-9a-f]{64}$/);
  assert.match(sub.snapshot.digest, /^[0-9a-f]{64}$/);
});

test('replay reproduces the original computation from the frozen input and rule version', () => {
  let store = updateSource(createApprovalStore(), 'change-a', {amount: 10});
  store = submit(store, {objectId: 'change-a', input: {amount: 250}, submittedBy: 'bob', registry: createDefaultRegistry()});
  store = updateSource(store, 'change-a', {amount: 8000}); // live data changed
  const replay = replaySnapshot(store.submissions.get(1).snapshot, createDefaultRegistry());
  assert.equal(replay.matches, true);
});

test('approval after source change is a CONFLICT until explicitly acknowledged', () => {
  let store = updateSource(createApprovalStore(), 'change-a', {amount: 10});
  store = frozenSubmit(store, 'change-a', {amount: 750});
  store = updateSource(store, 'change-a', {amount: 5000});

  assert.throws(
    () => decide(store, 1, {outcome: 'approved', decidedBy: 'alice', registry: createDefaultRegistry()}),
    {code: 'CONFLICT'},
  );
  // Still pending — the failed attempt changed nothing.
  assert.equal(store.submissions.get(1).status, 'pending');

  store = decide(store, 1, {outcome: 'approved', decidedBy: 'alice', allowConflict: true, registry: createDefaultRegistry()});
  const current = store.current.get('change-a');
  assert.deepEqual(current.value, {amount: 750}, 'approval applies the FROZEN proposed value, never the live value');
  assert.equal(current.version, 3); // v1 initial, v2 intervening update, v3 decision application
  const decision = store.decisions.at(-1);
  assert.equal(decision.sourceVersion, 1, 'decision keeps binding to original base version');
  assert.equal(decision.currentVersionAtDecision, 2);
  assert.equal(decision.conflictAcknowledged, true);
  assert.equal(decision.actedOnSnapshotDigest, store.submissions.get(1).snapshot.digest);
});

test('rejection never applies anything to the current object', () => {
  let store = updateSource(createApprovalStore(), 'change-a', {amount: 10});
  store = frozenSubmit(store, 'change-a', {amount: 750});
  store = decide(store, 1, {outcome: 'rejected', decidedBy: 'carol', reason: 'too big', registry: createDefaultRegistry()});
  assert.deepEqual(store.current.get('change-a'), {value: {amount: 10}, version: 1, updatedAt: store.current.get('change-a').updatedAt});
  assert.equal(store.submissions.get(1).status, 'rejected');
});

test('concurrent submissions: deciding an old one never acts on the newer version', () => {
  let store = updateSource(createApprovalStore(), 'change-a', {amount: 10});
  store = submit(store, {objectId: 'change-a', input: {amount: 100}, submittedBy: 'bob', registry: createDefaultRegistry()}); // #1 base v1
  store = decide(store, 1, {outcome: 'approved', decidedBy: 'alice', registry: createDefaultRegistry()}); // applies v2
  store = submit(store, {objectId: 'change-a', input: {amount: 200}, submittedBy: 'bob', registry: createDefaultRegistry()}); // #2 base v2
  store = updateSource(store, 'change-a', {amount: 9999}); // v3 — only #2 is in conflict
  assert.throws(
    () => decide(store, 2, {outcome: 'approved', decidedBy: 'alice', registry: createDefaultRegistry()}),
    {code: 'CONFLICT'},
  );
  store = decide(store, 2, {outcome: 'approved', decidedBy: 'alice', allowConflict: true, registry: createDefaultRegistry()});
  assert.deepEqual(store.current.get('change-a').value, {amount: 200});
  assert.equal(store.current.get('change-a').version, 4);
  // Finished decision of #1 is untouched and still replayable/bound.
  const first = store.decisions.find((d) => d.submissionId === 1);
  assert.equal(first.appliedVersion, 2);
});

test('duplicate approval and withdraw are rejected with explicit states', () => {
  let store = updateSource(createApprovalStore(), 'change-a', {amount: 10});
  store = frozenSubmit(store, 'change-a', {amount: 100});
  store = decide(store, 1, {outcome: 'approved', decidedBy: 'alice', registry: createDefaultRegistry()});
  assert.throws(
    () => decide(store, 1, {outcome: 'rejected', decidedBy: 'alice', registry: createDefaultRegistry()}),
    {code: 'DECISION_CONFLICT'},
  );
  assert.throws(() => withdraw(store, 1, 'bob'), {code: 'NOT_PENDING'});
});

test('withdraw is owner-only and recorded as a terminal decision', () => {
  let store = updateSource(createApprovalStore(), 'change-a', {amount: 10});
  store = frozenSubmit(store, 'change-a', {amount: 100}, 'bob');
  assert.throws(() => withdraw(store, 1, 'alice'), {code: 'PERMISSION_DENIED'});
  assert.equal(store.submissions.get(1).status, 'pending');
  store = withdraw(store, 1, 'bob');
  assert.equal(store.submissions.get(1).status, 'withdrawn');
  assert.equal(store.decisions.at(-1).outcome, 'withdrawn');
  assert.throws(() => withdraw(store, 1, 'bob'), {code: 'NOT_PENDING'});
});

test('permission loss between submit and approve is enforced at decision time', () => {
  let store = updateSource(createApprovalStore(), 'change-a', {amount: 10});
  store = frozenSubmit(store, 'change-a', {amount: 100});
  store = setPermission(store, 'alice', {canSubmit: true, canApprove: false});
  assert.throws(
    () => decide(store, 1, {outcome: 'approved', decidedBy: 'alice', registry: createDefaultRegistry()}),
    {code: 'PERMISSION_DENIED'},
  );
  // carol still can.
  store = decide(store, 1, {outcome: 'approved', decidedBy: 'carol', registry: createDefaultRegistry()});
  assert.equal(store.submissions.get(1).status, 'approved');
});

test('submitter without approval rights cannot self-approve', () => {
  let store = updateSource(createApprovalStore(), 'change-a', {amount: 10});
  assert.throws(() => frozenSubmit(store, 'change-a', {amount: 100}, 'carol'), {code: 'PERMISSION_DENIED'});
  let store2 = updateSource(createApprovalStore(), 'change-a', {amount: 10});
  store2 = frozenSubmit(store2, 'change-a', {amount: 100}, 'bob');
  assert.throws(
    () => decide(store2, 1, {outcome: 'approved', decidedBy: 'bob', registry: createDefaultRegistry()}),
    {code: 'PERMISSION_DENIED'},
  );
});

test('tampered evidence is detected and approval is refused', () => {
  let store = updateSource(createApprovalStore(), 'change-a', {amount: 10});
  store = submit(store, {objectId: 'change-a', input: {amount: 100}, submittedBy: 'bob', registry: createDefaultRegistry()});
  // Tamper with the frozen proposed value (e.g. a corrupted/attacked store row).
  const tampered = corruptClone(store);
  tampered.submissions.get(1).snapshot.proposedValue = {amount: 1};
  assert.throws(
    () => decide(tampered, 1, {outcome: 'approved', decidedBy: 'alice', registry: createDefaultRegistry()}),
    {code: 'EVIDENCE_TAMPERED'},
  );
  const check = checkEvidence(tampered.submissions.get(1).snapshot, createDefaultRegistry());
  assert.ok(check.problems.some((p) => p.field === 'digest' && p.code === 'EVIDENCE_TAMPERED'));
});

test('partially missing evidence is located at field level and cannot be replayed', () => {
  let store = updateSource(createApprovalStore(), 'change-a', {amount: 10});
  store = submit(store, {objectId: 'change-a', input: {amount: 100}, submittedBy: 'bob', registry: createDefaultRegistry()});
  const partial = corruptClone(store);
  delete partial.submissions.get(1).snapshot.input;
  const check = checkEvidence(partial.submissions.get(1).snapshot, createDefaultRegistry());
  assert.equal(check.complete, false);
  const fields = check.problems.map((p) => p.field);
  assert.ok(fields.includes('input'));
  assert.ok(fields.includes('digest'));
  assert.throws(() => replaySnapshot(partial.submissions.get(1).snapshot, createDefaultRegistry()), {code: 'EVIDENCE_MISSING'});
});

test('unknown rule version blocks replay and decision with a locatable problem', () => {
  const registry = createDefaultRegistry();
  registerRule(registry, {
    ruleId: 'cap-rule', version: 2,
    sourceText: '{"ruleId":"cap-rule","version":2}',
    compute: (input) => ({value: {amount: Number(input.amount) * 2}, approves: true}),
  });
  let store = updateSource(createApprovalStore(), 'change-a', {amount: 10});
  store = submit(store, {objectId: 'change-a', input: {amount: 100}, submittedBy: 'bob', rule: {ruleId: 'cap-rule', version: 2}, registry});

  // Old registry (v2 purged) cannot replay; default registry only has v1.
  const oldRegistry = createDefaultRegistry();
  const check = checkEvidence(store.submissions.get(1).snapshot, oldRegistry);
  assert.ok(check.problems.some((p) => p.field === 'rule' && p.code === 'RULE_VERSION_UNKNOWN'));
  assert.throws(() => replaySnapshot(store.submissions.get(1).snapshot, oldRegistry), {code: 'RULE_VERSION_UNKNOWN'});
});

test('freeze rejects inputs the rule cannot compute', () => {
  const base = {version: 1, value: {amount: 10}};
  assert.throws(
    () => freezeSnapshot({registry: createDefaultRegistry(), objectId: 'o', base, input: {amount: 'not-a-number'}}),
    {code: 'RULE_COMPUTATION_FAILED'},
  );
});

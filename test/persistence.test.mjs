import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApprovalStore, createDefaultRegistry, decide, submit, updateSource} from '../src/approval-ledger.mjs';
import {replaySnapshot} from '../src/evidence.mjs';
import {createPersistence, deserializeStore, serializeStore} from '../src/persistence.mjs';

const clock = (() => { let t = 0; return () => new Date(Date.UTC(2026, 0, 1) + t++ * 1000).toISOString(); })();

test('frozen evidence survives restart and replay still verifies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'approval-db-'));
  try {
    const path = join(dir, 'ledger.json');
    const persistence = createPersistence(path, {delay: 0});
    let store = createApprovalStore({now: clock});
    store = updateSource(store, 'change-a', {amount: 10});
    store = submit(store, {objectId: 'change-a', input: {amount: 750}, submittedBy: 'bob', registry: createDefaultRegistry()});
    store = updateSource(store, 'change-a', {amount: 9999});
    await persistence.schedule(store);
    await persistence.close();

    const {readFile} = await import('node:fs/promises');
    const revived = deserializeStore(await readFile(path, 'utf8'), {now: clock});
    assert.ok(revived.current instanceof Map);
    assert.ok(revived.submissions instanceof Map);
    assert.deepEqual(revived.submissions.get(1).snapshot.input, {amount: 750});
    assert.deepEqual(revived.current.get('change-a').value, {amount: 9999});

    // Evidence remains verifiable after restart; approving then applies frozen value.
    const replay = replaySnapshot(revived.submissions.get(1).snapshot, createDefaultRegistry());
    assert.equal(replay.matches, true);
    const decided = decide(revived, 1, {outcome: 'approved', decidedBy: 'carol', allowConflict: true, registry: createDefaultRegistry()});
    assert.deepEqual(decided.current.get('change-a').value, {amount: 750});
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('serialize/deserialize round-trips decisions and events', () => {
  let store = createApprovalStore({now: clock});
  store = updateSource(store, 'change-a', {amount: 10});
  store = submit(store, {objectId: 'change-a', input: {amount: 5}, submittedBy: 'bob', registry: createDefaultRegistry()});
  store = decide(store, 1, {outcome: 'approved', decidedBy: 'alice', registry: createDefaultRegistry()});
  const back = deserializeStore(serializeStore(store), {now: clock});
  assert.equal(back.nextSubmissionId, 2);
  assert.equal(back.decisions.length, 1);
  assert.equal(back.decisions[0].outcome, 'approved');
  assert.equal(back.events.length, 3);
  assert.deepEqual(back.permissions.get('bob'), {canSubmit: true, canApprove: false});
});

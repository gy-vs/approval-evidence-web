import test from 'node:test';
import assert from 'node:assert/strict';
import {createApprovalStore, decide, submit, updateSource} from '../src/approval-ledger.mjs';
test('a decision is tied to the submitted source version', () => { let store = updateSource(createApprovalStore(), 'change-a', {value: 1}); store = submit(store, 'change-a', {rule: 'r1'}); assert.equal(decide(store, 1, 'approved').decisions[0].sourceVersion, 1); });
test('a changed source invalidates an old approval', () => { let store = updateSource(createApprovalStore(), 'change-a', {value: 1}); store = submit(store, 'change-a', {rule: 'r1'}); store = updateSource(store, 'change-a', {value: 2}); assert.throws(() => decide(store, 1, 'approved'), /changed/); });

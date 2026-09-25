// Approval ledger.
//
// Three planes are kept deliberately separate:
//   current      — the live object (`current` map)
//   pending/frozen submission — what was asked for and why (immutable snapshot)
//   decisions    — append-only history of who decided what, bound to a digest
//
// An approval executes the *frozen proposed value*, never a value read from the
// live object at decision time. If the live object moved meanwhile that is a
// conflict the caller must acknowledge explicitly; it can never pass silently.
import {LedgerError} from './errors.mjs';
import {checkEvidence, freezeSnapshot, replaySnapshot, snapshotDigest} from './evidence.mjs';
import {createRuleRegistry} from './rules.mjs';

export function createApprovalStore({now = () => new Date().toISOString()} = {}) {
  return {
    now,
    nextSubmissionId: 1,
    current: new Map(),                 // objectId -> {value, version, updatedAt}
    submissions: new Map(),             // id -> submission
    decisions: [],                      // append-only
    permissions: new Map([
      ['alice', {canSubmit: true, canApprove: true}],
      ['bob', {canSubmit: true, canApprove: false}],
      ['carol', {canSubmit: false, canApprove: true}],
    ]),
    events: [],
  };
}

export function createDefaultRegistry() {
  return createRuleRegistry();
}

// structuredClone the data planes while preserving the injected clock function.
function cloneStore(store) {
  const {now, ...data} = store;
  const next = structuredClone(data);
  next.now = now;
  return next;
}

function requireActorPermission(store, actor, key, action) {
  const perms = store.permissions.get(actor);
  if (!perms || !perms[key]) {
    throw new LedgerError('PERMISSION_DENIED', `${actor} is not allowed to ${action}`, {details: {actor, required: key}});
  }
}

// Direct save path — unchanged contract for callers that bypass approval.
export function updateSource(store, id, value, actor = 'system') {
  const previous = store.current.get(id);
  const newVersion = (previous?.version || 0) + 1;
  let next = cloneStore(store);
  next.current.set(id, {value: structuredClone(value), version: newVersion, updatedAt: store.now()});
  // Any still-pending review based on an older base version is now in conflict.
  for (const sub of next.submissions.values()) {
    if (sub.status !== 'pending' || sub.objectId !== id) continue;
    if (sub.sourceVersion !== newVersion) {
      sub.conflict = {baseVersion: sub.sourceVersion, currentVersion: newVersion, detectedAt: store.now()};
    }
  }
  next.events = [...next.events, {
    type: 'source-updated', at: store.now(), actor, objectId: id,
    details: {previousVersion: previous?.version ?? 0, newVersion},
  }].slice(-500);
  return next;
}

// Legacy call: submit(store, id, evidence)  -> clones arbitrary evidence
// Evidence-backed call: submit(store, {objectId, input, submittedBy, rule, registry})
export function submit(store, idOrOptions, maybeEvidence, maybeActor = 'anonymous') {
  const legacy = typeof idOrOptions === 'string';
  let objectId, submission, actor;

  if (legacy) {
    objectId = idOrOptions;
    actor = maybeActor;
    const source = store.current.get(objectId) || {value: null, version: 0};
    // Old flow: no input, no rule version, no digest — kept working but the
    // review UI marks it as non-replayable legacy evidence.
    submission = {
      id: store.nextSubmissionId,
      objectId,
      status: 'pending',
      mode: 'legacy',
      sourceVersion: source.version,
      submittedBy: actor,
      submittedAt: store.now(),
      snapshot: {legacy: true, evidence: structuredClone(maybeEvidence)},
      conflict: null,
      result: null,
    };
  } else {
    const opts = idOrOptions;
    objectId = opts.objectId;
    actor = opts.submittedBy ?? 'anonymous';
    requireActorPermission(store, actor, 'canSubmit', 'submit changes');
    const registry = opts.registry;
    if (!registry) throw new LedgerError('INVALID_INPUT', 'registry is required for evidence-backed submissions', {status: 400});
    const base = store.current.get(objectId) || null;
    const snapshot = freezeSnapshot({
      registry,
      objectId,
      base,
      input: opts.input,
      submittedBy: actor,
      submittedAt: store.now(),
      ruleRef: opts.rule,
    });
    submission = {
      id: store.nextSubmissionId,
      objectId,
      status: 'pending',
      mode: 'frozen',
      sourceVersion: snapshot.baseVersion,
      submittedBy: actor,
      submittedAt: store.now(),
      snapshot,
      conflict: null,
      result: null,
    };
  }

  let next = cloneStore(store);
  next.nextSubmissionId = store.nextSubmissionId + 1;
  next.submissions.set(submission.id, submission);
  next.events = [...next.events, {
    type: 'submitted', at: store.now(), actor, objectId,
    details: {submissionId: submission.id, mode: submission.mode, baseVersion: submission.sourceVersion, digest: submission.snapshot?.digest ?? null},
  }].slice(-500);
  return next;
}

// Legacy call: decide(store, submissionId, 'approved')
// Evidence call: decide(store, submissionId, {outcome, decidedBy, reason, allowConflict, registry})
export function decide(store, submissionId, outcomeOrOptions) {
  const submission = store.submissions.get(submissionId);
  if (!submission) throw new LedgerError('SUBMISSION_NOT_FOUND', `submission ${submissionId} not found`, {status: 404});

  const legacy = typeof outcomeOrOptions === 'string';
  const opts = legacy ? {outcome: outcomeOrOptions} : (outcomeOrOptions ?? {});
  const outcome = opts.outcome;
  if (!['approved', 'rejected'].includes(outcome)) {
    throw new LedgerError('INVALID_OUTCOME', `outcome must be approved or rejected, got ${String(outcome)}`, {status: 400});
  }
  const actor = legacy ? 'anonymous' : (opts.decidedBy ?? 'anonymous');
  if (!legacy) requireActorPermission(store, actor, 'canApprove', 'approve or reject');

  if (submission.status !== 'pending') {
    throw new LedgerError('DECISION_CONFLICT', `submission ${submissionId} is already ${submission.status}; a finished review cannot be decided again`, {details: {status: submission.status}});
  }

  const live = store.current.get(submission.objectId) || {value: null, version: 0};
  const sourceMoved = live.version !== submission.sourceVersion;

  if (sourceMoved) {
    if (legacy) {
      // Preserve original strict behavior for the legacy direct path.
      throw new LedgerError('SOURCE_CHANGED', 'source changed since submission; legacy approval cannot act on a different version', {details: {baseVersion: submission.sourceVersion, currentVersion: live.version}});
    }
    if (!opts.allowConflict) {
      throw new LedgerError('CONFLICT', `source changed since submission (v${submission.sourceVersion} -> v${live.version}); re-review the diff and acknowledge the conflict to act on the frozen snapshot`, {details: {baseVersion: submission.sourceVersion, currentVersion: live.version}});
    }
  }

  // Verify the frozen evidence before executing anything.
  let snapshotDigestValue = null;
  if (submission.mode === 'frozen') {
    const registry = opts.registry;
    if (!registry) throw new LedgerError('INVALID_INPUT', 'registry is required to decide on a frozen submission', {status: 400});
    const replay = replaySnapshot(submission.snapshot, registry);
    if (!replay.matches) throw new LedgerError('EVIDENCE_REPLAY_FAILED', 'frozen evidence failed replay; refusing to act', {details: replay.steps});
    snapshotDigestValue = submission.snapshot.digest;
  }

  let next = cloneStore(store);
  const record = {
    submissionId,
    outcome,
    sourceVersion: submission.sourceVersion, // legacy-compatible field
    decidedBy: actor,
    decidedAt: store.now(),
    reason: opts.reason ?? null,
    mode: submission.mode,
    actedOnSnapshotDigest: snapshotDigestValue,
    currentVersionAtDecision: live.version,
    conflictAcknowledged: Boolean(sourceMoved && opts.allowConflict),
  };
  next.decisions = [...next.decisions, record];

  const copy = next.submissions.get(submissionId);
  copy.status = outcome;
  copy.decidedAt = record.decidedAt;

  if (outcome === 'approved') {
    if (submission.mode === 'frozen') {
      // Execution target comes exclusively from the frozen snapshot.
      const appliedValue = structuredClone(submission.snapshot.proposedValue);
      const appliedVersion = live.version + 1;
      next.current.set(submission.objectId, {value: appliedValue, version: appliedVersion, updatedAt: store.now()});
      copy.result = {applied: true, appliedVersion, appliedValue, digest: snapshotDigestValue};
      record.appliedVersion = appliedVersion;
    } else {
      copy.result = {applied: false, reason: 'legacy submission has no frozen proposed value; direct path only'};
    }
  } else {
    copy.result = {applied: false, reason: 'rejected'};
  }

  next.events = [...next.events, {
    type: 'decided', at: store.now(), actor, objectId: submission.objectId,
    details: {submissionId, outcome, sourceMoved, conflictAcknowledged: record.conflictAcknowledged, appliedVersion: record.appliedVersion ?? null, digest: snapshotDigestValue},
  }].slice(-500);
  return next;
}

// Withdrawal is a first-class terminal state, not a missing button.
export function withdraw(store, submissionId, actor) {
  const submission = store.submissions.get(submissionId);
  if (!submission) throw new LedgerError('SUBMISSION_NOT_FOUND', `submission ${submissionId} not found`, {status: 404});
  if (submission.status !== 'pending') {
    throw new LedgerError('NOT_PENDING', `submission ${submissionId} is ${submission.status}; only pending submissions can be withdrawn`, {details: {status: submission.status}});
  }
  if (submission.submittedBy !== actor) {
    throw new LedgerError('PERMISSION_DENIED', `only ${submission.submittedBy} can withdraw this submission`, {details: {actor, owner: submission.submittedBy}});
  }
  let next = cloneStore(store);
  next.submissions.get(submissionId).status = 'withdrawn';
  next.submissions.get(submissionId).withdrawnAt = store.now();
  next.decisions = [...next.decisions, {
    submissionId, outcome: 'withdrawn', sourceVersion: submission.sourceVersion,
    decidedBy: actor, decidedAt: store.now(), reason: null, mode: submission.mode,
    actedOnSnapshotDigest: submission.snapshot?.digest ?? null,
    currentVersionAtDecision: store.current.get(submission.objectId)?.version ?? submission.sourceVersion,
    conflictAcknowledged: false,
  }];
  next.events = [...next.events, {type: 'withdrawn', at: store.now(), actor, objectId: submission.objectId, details: {submissionId}}].slice(-500);
  return next;
}

// Permission changes are themselves auditable and take effect on the next op.
export function setPermission(store, actor, perms, by = 'admin') {
  let next = cloneStore(store);
  next.permissions.set(actor, {
    canSubmit: perms?.canSubmit ?? false,
    canApprove: perms?.canApprove ?? false,
  });
  next.events = [...next.events, {type: 'permission-changed', at: store.now(), actor: by, objectId: null, details: {target: actor, ...perms}}].slice(-500);
  return next;
}

export {checkEvidence, replaySnapshot, snapshotDigest};

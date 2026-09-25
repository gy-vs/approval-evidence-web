import {createHash} from 'node:crypto';

/**
 * Approval evidence ledger.
 *
 * Three independently stored things must never be conflated:
 *  - the live object (object versions, head moves on every save/approval)
 *  - the frozen evidence snapshot captured at submission time (immutable)
 *  - the append-only decision record (bound to a specific snapshot and base version)
 *
 * Every state transition is explicit; version conflicts, permission loss,
 * duplicate actions and corrupt evidence raise typed LedgerErrors instead of
 * being silently ignored.
 */

export class LedgerError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.details = details;
  }
}

const EVENT_LIMIT = 200;
const EVIDENCE_FIELDS = ['inputs', 'ruleVersion', 'summary'];
const TERMINAL = new Set(['approved', 'rejected', 'withdrawn']);
const ACTION_ALIASES = {approved: 'approve', rejected: 'reject', withdrawn: 'withdraw'};

export function createApprovalStore() {
  return {
    nextSubmissionId: 1,
    nextDecisionSeq: 1,
    eventSeq: 0,
    objects: new Map(),
    submissions: new Map(),
    decisions: [],
    rules: new Map(),
    grants: new Map(),
    events: [],
  };
}

/* ----------------------------- utilities ----------------------------- */

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function digestOf(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function cloneStore(store) {
  const next = structuredClone(store);
  next.objects = new Map(store.objects);
  next.submissions = new Map(store.submissions);
  next.rules = new Map(store.rules);
  next.grants = new Map(store.grants);
  next.decisions = [...store.decisions];
  next.events = [...store.events];
  return next;
}

function record(store, type, detail = {}) {
  store.eventSeq += 1;
  store.events.push({seq: store.eventSeq, type, at: new Date().toISOString(), ...detail});
  if (store.events.length > EVENT_LIMIT) store.events.splice(0, store.events.length - EVENT_LIMIT);
}

function ensureObject(store, objectId) {
  let object = store.objects.get(objectId);
  if (!object) {
    object = {id: objectId, headVersion: 0, versions: []};
    store.objects.set(objectId, object);
  }
  return object;
}

export function getCurrent(store, objectId) {
  const object = store.objects.get(objectId);
  if (!object || object.versions.length === 0) return {id: objectId, version: 0, value: null};
  const head = object.versions.at(-1);
  return {id: objectId, version: head.version, value: structuredClone(head.value)};
}

function hasGrant(store, actor, permission) {
  if (!actor) return true; // unauthenticated legacy callers keep working
  return Boolean(store.grants.get(actor)?.[permission]);
}

/* ----------------------------- rules & grants ----------------------------- */

export function defineRule(store, {version, name, body} = {}) {
  if (!version || typeof version !== 'string') {
    throw new LedgerError('invalid-rule', 'rule version is required', {missing: ['version']});
  }
  const existing = store.rules.get(version);
  if (existing && (stableJson(existing.body) !== stableJson(body ?? {}) || existing.name !== (name ?? existing.name))) {
    throw new LedgerError('invalid-rule', `rule ${version} is frozen and cannot be redefined; register a new rule version`, {
      ruleVersion: version,
    });
  }
  if (existing) return store; // identical re-registration is a no-op
  const next = cloneStore(store);
  next.rules.set(version, {version, name: name ?? version, body: structuredClone(body ?? {}), at: new Date().toISOString()});
  record(next, 'rule-defined', {ruleVersion: version});
  return next;
}

export function setGrant(store, actor, permission, granted) {
  if (!actor || !permission) throw new LedgerError('invalid-evidence', 'actor and permission are required');
  const next = cloneStore(store);
  const perms = {...(next.grants.get(actor) ?? {})};
  if (granted) perms[permission] = true;
  else delete perms[permission];
  next.grants.set(actor, perms);
  record(next, 'grant-changed', {actor, permission, granted: Boolean(granted)});
  return next;
}

/* ----------------------------- live object (direct save) ----------------------------- */

export function updateSource(store, id, value, meta = {}) {
  if (id == null) throw new LedgerError('invalid-evidence', 'object id is required', {missing: ['id']});
  const next = cloneStore(store);
  const object = ensureObject(next, id);
  const version = object.headVersion + 1;
  object.headVersion = version;
  object.versions.push({version, value: structuredClone(value), at: new Date().toISOString(), by: meta.by ?? null, via: meta.via ?? {type: 'direct-save'}});
  record(next, 'source-updated', {objectId: id, version});
  return next;
}

/* ----------------------------- submission / evidence freeze ----------------------------- */

function missingEvidenceFields({inputs, ruleVersion, summary}) {
  const missing = [];
  const empty = (value) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
  if (empty(inputs)) missing.push('inputs');
  if (empty(ruleVersion)) missing.push('ruleVersion');
  if (empty(summary)) missing.push('summary');
  return missing;
}

function freezeEvidence({inputs, ruleVersion, summary, ruleBody, proposedValue, baseValue}) {
  const digests = {
    inputs: digestOf(inputs ?? null),
    ruleVersion: digestOf(ruleVersion ?? null),
    summary: digestOf(summary ?? null),
    ruleBody: digestOf(ruleBody ?? null),
    proposedValue: digestOf(proposedValue ?? null),
    baseValue: digestOf(baseValue ?? null),
  };
  return {
    inputs: structuredClone(inputs ?? null),
    ruleVersion: ruleVersion ?? null,
    summary: summary ?? null,
    ruleBody: structuredClone(ruleBody ?? null),
    frozenAt: new Date().toISOString(),
    digests,
    digest: digestOf(digests),
  };
}

function isNewStyleArgs(args) {
  return args !== null && typeof args === 'object' && !Array.isArray(args);
}

export function submit(store, args, legacyEvidence = undefined) {
  // Legacy positional call: submit(store, objectId, evidence)
  const legacy = !isNewStyleArgs(args);
  const objectId = legacy ? args : args.objectId;
  if (objectId == null) throw new LedgerError('invalid-evidence', 'objectId is required', {missing: ['objectId']});
  if (!hasGrant(store, legacy ? null : args.actor, 'submit')) {
    throw new LedgerError('forbidden', 'actor may not submit changes', {actor: args.actor, permission: 'submit'});
  }

  let inputs;
  let ruleVersion;
  let summary;
  let proposedValue;
  let baseVersion;
  let actor;
  if (legacy) {
    inputs = legacyEvidence ?? {};
    ruleVersion = legacyEvidence?.ruleVersion ?? null;
    summary = legacyEvidence?.summary ?? null;
    proposedValue = undefined;
    baseVersion = undefined;
    actor = null;
  } else {
    ({inputs, ruleVersion, summary, proposedValue, baseVersion, actor} = args);
    if (proposedValue === undefined) {
      throw new LedgerError('invalid-evidence', 'proposedValue is required', {missing: ['proposedValue']});
    }
    const missing = missingEvidenceFields({inputs, ruleVersion, summary});
    if (missing.length) {
      throw new LedgerError('invalid-evidence', `evidence is missing: ${missing.join(', ')}`, {missing});
    }
  }

  const next = cloneStore(store);
  const object = ensureObject(next, objectId);
  const current = getCurrent(next, objectId);
  const requestedBase = baseVersion ?? current.version;
  if (requestedBase !== current.version) {
    throw new LedgerError('conflict', `submission base version ${requestedBase} is not the head version ${current.version}`, {
      code: 'stale-base',
      objectId,
      baseVersion: requestedBase,
      headVersion: current.version,
    });
  }

  // A newer pending submission supersedes earlier pending ones for the same object.
  for (const older of next.submissions.values()) {
    if (older.objectId === objectId && older.status === 'pending') {
      older.status = 'superseded';
      older.supersededBy = next.nextSubmissionId;
    }
  }

  const rule = ruleVersion ? next.rules.get(ruleVersion) : undefined;
  const submission = {
    id: next.nextSubmissionId++,
    objectId,
    status: 'pending',
    actor: actor ?? null,
    submittedAt: new Date().toISOString(),
    baseVersion: current.version,
    baseValue: structuredClone(current.value),
    proposedValue: structuredClone(proposedValue),
    // Legacy positional callers never provided structured evidence; their
    // snapshots still freeze value/rule hashes but skip completeness checks.
    legacyEvidence: legacy,
    evidence: freezeEvidence({
      inputs,
      ruleVersion,
      summary,
      ruleBody: rule ? {version: rule.version, name: rule.name, body: rule.body} : null,
      proposedValue,
      baseValue: current.value,
    }),
    outcomeDecisionSeq: null,
    supersededBy: null,
  };
  next.submissions.set(submission.id, submission);
  record(next, 'submitted', {submissionId: submission.id, objectId, baseVersion: submission.baseVersion});
  return next;
}

/* ----------------------------- evidence verification & diff ----------------------------- */

export function verifySnapshot(store, submissionId) {
  const submission = store.submissions.get(submissionId);
  if (!submission) throw new LedgerError('not-found', 'submission not found', {submissionId});

  const evidence = submission.evidence ?? {};
  const digests = evidence.digests ?? {};
  const missing = [];
  const tampered = [];

  const check = (path, value, recorded) => {
    if (value === null || value === undefined) missing.push(path);
    else if (digestOf(value) !== recorded) tampered.push(path);
  };

  if (submission.legacyEvidence) {
    // Legacy submissions never carried structured evidence: verify only the
    // frozen values and the digest envelope, not the new required fields.
    check('evidence.baseValue', submission.baseValue ?? null, digests.baseValue);
  } else {
    check('evidence.inputs', evidence.inputs ?? null, digests.inputs);
    check('evidence.ruleVersion', evidence.ruleVersion ?? null, digests.ruleVersion);
    check('evidence.summary', evidence.summary ?? null, digests.summary);
    check('evidence.proposedValue', submission.proposedValue ?? null, digests.proposedValue);
    check('evidence.baseValue', submission.baseValue ?? null, digests.baseValue);
    if (evidence.ruleBody !== null && evidence.ruleBody !== undefined && digestOf(evidence.ruleBody) !== digests.ruleBody) {
      tampered.push('evidence.ruleBody');
    }
  }
  if (evidence.digests && digestOf(evidence.digests) !== evidence.digest) {
    if (!tampered.includes('evidence.digests')) tampered.push('evidence.digests');
  }

  const current = getCurrent(store, submission.objectId);
  const rule = evidence.ruleVersion ? store.rules.get(evidence.ruleVersion) : undefined;
  const ruleKnown = Boolean(rule) || Boolean(evidence.ruleBody);
  const ruleChanged = Boolean(rule && evidence.ruleBody && stableJson({name: rule.name, body: rule.body}) !== stableJson({name: evidence.ruleBody.name, body: evidence.ruleBody.body}));

  return {
    submissionId,
    status: submission.status,
    ok: missing.length === 0 && tampered.length === 0,
    digestMatches: tampered.length === 0,
    missing,
    tampered,
    ruleVersion: evidence.ruleVersion ?? null,
    ruleKnown,
    ruleChanged,
    frozenAt: evidence.frozenAt ?? null,
    baseVersion: submission.baseVersion,
    headVersion: current.version,
    objectChanged: current.version !== submission.baseVersion,
  };
}

function diffPaths(a, b, prefix = '') {
  const paths = [];
  const aIsObject = a !== null && typeof a === 'object';
  const bIsObject = b !== null && typeof b === 'object';
  if (!aIsObject || !bIsObject) {
    if (stableJson(a) !== stableJson(b)) paths.push(prefix || '$');
    return paths;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of [...keys].sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in a)) paths.push(`${path} (added)`);
    else if (!(key in b)) paths.push(`${path} (removed)`);
    else paths.push(...diffPaths(a[key], b[key], path));
  }
  return paths;
}

export function snapshotDiff(store, submissionId) {
  const submission = store.submissions.get(submissionId);
  if (!submission) throw new LedgerError('not-found', 'submission not found', {submissionId});
  const current = getCurrent(store, submission.objectId);
  return {
    objectId: submission.objectId,
    baseVersion: submission.baseVersion,
    currentVersion: current.version,
    changed: current.version !== submission.baseVersion,
    paths: current.version === submission.baseVersion ? [] : diffPaths(submission.baseValue, current.value),
  };
}

/* ----------------------------- decisions (approve / reject / withdraw) ----------------------------- */

function normalizeAction(action) {
  const normalized = ACTION_ALIASES[action] ?? action;
  if (!['approve', 'reject', 'withdraw'].includes(normalized)) {
    throw new LedgerError('invalid-action', `unknown decision action: ${action}`, {action});
  }
  return normalized;
}

export function decisionsFor(store, submissionId) {
  if (!store.submissions.has(submissionId)) throw new LedgerError('not-found', 'submission not found', {submissionId});
  return store.decisions.filter((decision) => decision.submissionId === submissionId);
}

export function decide(store, args, legacyOutcome = undefined) {
  const legacy = !isNewStyleArgs(args);
  const submissionId = legacy ? args : args.submissionId;
  const action = normalizeAction(legacy ? legacyOutcome : args.action);
  const actor = legacy ? null : (args.actor ?? null);
  const reason = legacy ? null : (args.reason ?? null);

  const submission = store.submissions.get(submissionId);
  if (!submission) throw new LedgerError('not-found', 'submission not found', {submissionId});

  // Permissions are evaluated against the current grant set: a revoke made
  // while the approval is pending blocks the decision instead of being hidden.
  if (action === 'withdraw') {
    const own = actor && submission.actor && actor === submission.actor;
    if (!own && !hasGrant(store, actor, 'withdraw.any')) {
      throw new LedgerError('forbidden', 'only the submitter or an actor with withdraw.any may withdraw', {
        actor, submissionId, submitter: submission.actor,
      });
    }
  } else if (!hasGrant(store, actor, 'approve')) {
    throw new LedgerError('forbidden', 'actor may not approve or reject submissions', {actor, permission: 'approve'});
  }

  if (TERMINAL.has(submission.status)) {
    throw new LedgerError('conflict', `submission ${submissionId} is already ${submission.status}; duplicate decisions are not allowed`, {
      code: 'already-decided', submissionId, status: submission.status,
    });
  }
  if (action === 'approve' && submission.status === 'superseded') {
    throw new LedgerError('conflict', `submission ${submissionId} was superseded by submission ${submission.supersededBy}; approving it would act on stale evidence`, {
      code: 'superseded', submissionId, supersededBy: submission.supersededBy,
    });
  }

  // A decision is only meaningful when the frozen basis is still intact.
  // Withdrawal is allowed on damaged evidence so the submitter can pull it back.
  const verification = verifySnapshot(store, submissionId);
  if (!verification.ok && action !== 'withdraw') {
    throw new LedgerError('corrupt-evidence', `frozen evidence for submission ${submissionId} is incomplete or tampered`, {
      code: 'evidence-damaged', submissionId, missing: verification.missing, tampered: verification.tampered,
    });
  }

  const next = cloneStore(store);
  const target = next.submissions.get(submissionId);
  const seq = next.nextDecisionSeq++;
  const statusAfter = {approve: 'approved', reject: 'rejected', withdraw: 'withdrawn'}[action];

  const decision = {
    seq,
    submissionId,
    action,
    actor,
    at: new Date().toISOString(),
    reason,
    priorStatus: submission.status,
    status: statusAfter,
    basis: {
      objectId: submission.objectId,
      sourceVersion: submission.baseVersion,
      evidenceDigest: submission.evidence.digest,
      ruleVersion: submission.evidence.ruleVersion,
    },
    // Back-compat alias for callers reading decision.sourceVersion directly.
    sourceVersion: submission.baseVersion,
    execution: null,
  };

  if (action === 'approve') {
    const current = getCurrent(next, submission.objectId);
    if (current.version !== submission.baseVersion) {
      // Refuse to silently execute on top of a different version: the frozen
      // basis and the execution target must stay explicitly separable.
      throw new LedgerError('conflict',
        `object ${submission.objectId} changed since submission: frozen against v${submission.baseVersion}, head is now v${current.version}`,
        {code: 'version-conflict', submissionId, baseVersion: submission.baseVersion, headVersion: current.version, verification});
    }
    const object = next.objects.get(submission.objectId);
    if (submission.proposedValue !== undefined) {
      object.headVersion = current.version + 1;
      object.versions.push({
        version: object.headVersion,
        value: structuredClone(submission.proposedValue),
        at: new Date().toISOString(),
        by: actor ?? 'approval',
        via: {type: 'approval', submissionId, decisionSeq: seq, baseVersion: submission.baseVersion, evidenceDigest: submission.evidence.digest},
      });
      decision.execution = {applied: true, version: object.headVersion, baseVersion: submission.baseVersion};
    } else {
      decision.execution = {applied: true, version: current.version, baseVersion: submission.baseVersion, noChange: true};
    }
  }

  target.status = statusAfter;
  target.outcomeDecisionSeq = seq;
  next.decisions.push(decision);
  record(next, 'decision', {decisionSeq: seq, submissionId, action, executed: decision.execution?.applied === true});
  return next;
}

/* ----------------------------- read models / replay ----------------------------- */

function capabilities(store, submission, actor) {
  const active = submission.status === 'pending' || submission.status === 'superseded';
  const own = Boolean(actor && submission.actor === actor);
  return {
    approve: active && submission.status !== 'superseded' && hasGrant(store, actor, 'approve'),
    reject: active && hasGrant(store, actor, 'approve'),
    withdraw: active && (own || hasGrant(store, actor, 'withdraw.any')),
  };
}

export function submissionView(store, submission, actor = null) {
  const current = getCurrent(store, submission.objectId);
  return {
    id: submission.id,
    objectId: submission.objectId,
    status: submission.status,
    actor: submission.actor,
    submittedAt: submission.submittedAt,
    baseVersion: submission.baseVersion,
    headVersion: current.version,
    stale: current.version !== submission.baseVersion,
    supersededBy: submission.supersededBy,
    outcomeDecisionSeq: submission.outcomeDecisionSeq,
    baseValue: structuredClone(submission.baseValue ?? null),
    proposedValue: structuredClone(submission.proposedValue ?? null),
    evidence: structuredClone(submission.evidence),
    can: capabilities(store, submission, actor),
  };
}

export function approvalOverview(store, actor = null) {
  const objects = [...store.objects.values()].map((object) => getCurrent(store, object.id));
  return {
    viewer: actor,
    eventSeq: store.eventSeq,
    objects,
    // Legacy alias: entries shaped like the old Map serialization.
    current: objects.map((object) => [object.id, {value: object.value, version: object.version}]),
    submissions: [...store.submissions.values()].map((submission) => submissionView(store, submission, actor)),
    decisions: structuredClone(store.decisions),
    rules: [...store.rules.values()],
    grants: Object.fromEntries([...store.grants].map(([name, perms]) => [name, Object.keys(perms)])),
  };
}

export function objectHistory(store, objectId) {
  const object = store.objects.get(objectId);
  if (!object) throw new LedgerError('not-found', 'object not found', {objectId});
  return {
    id: objectId,
    headVersion: object.headVersion,
    versions: object.versions.map((version) => structuredClone(version)),
  };
}

export function replayDecision(store, decisionSeq) {
  const decision = store.decisions.find((entry) => entry.seq === decisionSeq);
  if (!decision) throw new LedgerError('not-found', 'decision not found', {decisionSeq});
  const submission = store.submissions.get(decision.submissionId);
  if (!submission) throw new LedgerError('corrupt-evidence', 'decision points at a missing submission', {decisionSeq, submissionId: decision.submissionId});
  const current = getCurrent(store, submission.objectId);
  return structuredClone({
    decision,
    submission: submissionView(store, submission, decision.actor),
    frozen: {
      evidence: submission.evidence,
      baseValue: submission.baseValue,
      proposedValue: submission.proposedValue,
    },
    verification: verifySnapshot(store, submission.id),
    execution: decision.execution,
    current: {version: current.version, value: current.value},
    diff: snapshotDiff(store, submission.id),
  });
}

/* ----------------------------- persistence ----------------------------- */

export function serialize(store) {
  return JSON.stringify({
    version: 2,
    nextSubmissionId: store.nextSubmissionId,
    nextDecisionSeq: store.nextDecisionSeq,
    eventSeq: store.eventSeq,
    objects: [...store.objects.values()],
    submissions: [...store.submissions.values()],
    decisions: store.decisions,
    rules: [...store.rules.values()],
    grants: [...store.grants.entries()],
    events: store.events,
  }, null, 2);
}

export function deserialize(text) {
  const data = typeof text === 'string' ? JSON.parse(text) : text;
  const store = createApprovalStore();
  store.nextSubmissionId = data.nextSubmissionId ?? 1;
  store.nextDecisionSeq = data.nextDecisionSeq ?? 1;
  store.eventSeq = data.eventSeq ?? 0;
  for (const object of data.objects ?? []) {
    store.objects.set(object.id, {
      id: object.id,
      headVersion: object.headVersion ?? object.versions?.at(-1)?.version ?? 0,
      versions: object.versions ?? [],
    });
  }
  for (const submission of data.submissions ?? []) store.submissions.set(submission.id, submission);
  store.decisions = data.decisions ?? [];
  for (const rule of data.rules ?? []) store.rules.set(rule.version, rule);
  for (const [actor, perms] of data.grants ?? []) {
    store.grants.set(actor, perms instanceof Set ? Object.fromEntries([...perms].map((p) => [p, true])) : perms);
  }
  store.events = data.events ?? [];
  return store;
}

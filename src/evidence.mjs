// Evidence freezing and replay.
//
// A submission does NOT point at the live object. At submit time the server
// evaluates a versioned rule over the *frozen input*, stores the rule version
// + digest and a digest of the whole snapshot. Replay re-runs the same rule
// version against the frozen input and compares every digest, so the reviewer
// sees the exact basis of the request regardless of what the object looks like
// now. Nothing here reads live state.
import {LedgerError} from './errors.mjs';
import {canonicalJson, findRule, latestRule, sha256} from './rules.mjs';

export function snapshotDigest(snapshot) {
  return sha256(canonicalJson({
    objectId: snapshot.objectId,
    baseVersion: snapshot.baseVersion,
    baseValue: snapshot.baseValue ?? null,
    input: snapshot.input ?? null,
    proposedValue: snapshot.proposedValue ?? null,
    rule: snapshot.rule,
    ruleOutcome: snapshot.ruleOutcome ?? null,
    submittedBy: snapshot.submittedBy ?? null,
    submittedAt: snapshot.submittedAt ?? null,
  }));
}

const SNAPSHOT_FIELDS = ['objectId', 'baseVersion', 'baseValue', 'input', 'proposedValue', 'rule', 'ruleOutcome', 'submittedBy', 'submittedAt', 'digest'];

// Locate evidence problems at field granularity so the page can point at the
// broken/missing piece instead of just saying "evidence broken".
export function checkEvidence(snapshot, registry) {
  const problems = [];
  if (snapshot === null || typeof snapshot !== 'object') {
    return {complete: false, replayable: false, problems: [{field: 'snapshot', code: 'EVIDENCE_MISSING', message: 'snapshot is missing'}]};
  }
  const missing = SNAPSHOT_FIELDS.filter((f) => snapshot[f] === undefined);
  for (const field of missing) problems.push({field, code: 'EVIDENCE_MISSING', message: `field "${field}" is missing from the frozen snapshot`});
  if (snapshot.rule) {
    if (snapshot.rule.ruleId === undefined || snapshot.rule.version === undefined) {
      problems.push({field: 'rule', code: 'RULE_VERSION_MISSING', message: 'rule identity (ruleId/version) is missing'});
    } else if (!findRule(registry, snapshot.rule.ruleId, snapshot.rule.version)) {
      problems.push({field: 'rule', code: 'RULE_VERSION_UNKNOWN', message: `rule ${snapshot.rule.ruleId}@v${snapshot.rule.version} is no longer registered; original basis cannot be replayed`});
    }
    if (typeof snapshot.rule === 'object' && snapshot.rule.digest === undefined) {
      problems.push({field: 'rule.digest', code: 'EVIDENCE_MISSING', message: 'rule digest is missing'});
    }
  } else if (snapshot.rule === undefined) {
    problems.push({field: 'rule', code: 'EVIDENCE_MISSING', message: 'rule reference is missing from the frozen snapshot'});
  }
  if (typeof snapshot.digest === 'string') {
    const recomputed = snapshotDigest({...snapshot, digest: undefined});
    if (recomputed !== snapshot.digest) {
      problems.push({field: 'digest', code: 'EVIDENCE_TAMPERED', message: 'snapshot digest does not match its contents; evidence was altered after freezing'});
    }
  }
  return {complete: problems.length === 0, replayable: problems.length === 0, problems};
}

// Server-side freeze at submission time. This is the only place a snapshot is
// created, so clients can never invent evidence.
export function freezeSnapshot({registry, objectId, base, input, submittedBy, submittedAt, ruleRef}) {
  if (!objectId || typeof objectId !== 'string') throw new LedgerError('INVALID_INPUT', 'objectId is required', {status: 400});
  const rule = ruleRef
    ? findRule(registry, ruleRef.ruleId, ruleRef.version)
    : latestRule(registry);
  if (!rule) throw new LedgerError('RULE_VERSION_UNKNOWN', `unknown rule version ${ruleRef.ruleId}@v${ruleRef.version}`, {status: 400});
  if (input === undefined) throw new LedgerError('INVALID_INPUT', 'input is required for an evidence-backed submission', {status: 400});

  const ruleOutcome = rule.compute(structuredClone(input));
  if (ruleOutcome === null || typeof ruleOutcome !== 'object' || !('value' in ruleOutcome)) {
    throw new LedgerError('RULE_COMPUTATION_FAILED', `rule ${rule.ruleId}@v${rule.version} produced no proposed value for the given input`, {status: 422});
  }
  const snapshot = {
    objectId,
    baseVersion: base?.version ?? 0,
    baseValue: base ? structuredClone(base.value) : null,
    input: structuredClone(input),
    proposedValue: structuredClone(ruleOutcome.value),
    rule: {ruleId: rule.ruleId, version: rule.version, digest: rule.digest},
    ruleOutcome: structuredClone(ruleOutcome),
    submittedBy: submittedBy ?? null,
    submittedAt: submittedAt ?? new Date().toISOString(),
  };
  snapshot.digest = snapshotDigest(snapshot);
  return snapshot;
}

// Re-evaluate the frozen input with the frozen rule version and verify all
// digests. Pure: never touches the live object or current rules.
export function replaySnapshot(snapshot, registry) {
  const check = checkEvidence(snapshot, registry);
  const fatal = check.problems.find((p) => p.code === 'RULE_VERSION_UNKNOWN');
  if (fatal) throw new LedgerError(fatal.code, fatal.message, {details: check.problems});
  // A missing field also breaks the digest; report the actionable cause first.
  const miss = check.problems.find((p) => p.code === 'EVIDENCE_MISSING');
  if (miss) throw new LedgerError('EVIDENCE_MISSING', miss.message, {details: check.problems});
  const tampered = check.problems.find((p) => p.code === 'EVIDENCE_TAMPERED');
  if (tampered) throw new LedgerError(tampered.code, tampered.message, {details: check.problems});

  const rule = findRule(registry, snapshot.rule.ruleId, snapshot.rule.version);
  const replay = rule.compute(structuredClone(snapshot.input));
  const steps = [];
  steps.push({check: 'rule.digest', expected: snapshot.rule.digest, actual: rule.digest, matches: rule.digest === snapshot.rule.digest});
  steps.push({check: 'ruleOutcome', expected: snapshot.ruleOutcome, actual: replay, matches: canonicalJson(replay) === canonicalJson(snapshot.ruleOutcome)});
  steps.push({check: 'proposedValue', expected: snapshot.proposedValue, actual: replay?.value, matches: canonicalJson(replay?.value) === canonicalJson(snapshot.proposedValue)});
  const recomputed = snapshotDigest({...snapshot, digest: undefined});
  steps.push({check: 'snapshot.digest', expected: snapshot.digest, actual: recomputed, matches: recomputed === snapshot.digest});
  return {matches: steps.every((s) => s.matches), steps, ruleDescription: rule.description};
}

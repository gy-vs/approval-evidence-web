// Read models built for the API/UI. These are projections only — they never
// mutate the ledger.
import {checkEvidence, replaySnapshot} from './evidence.mjs';

function shallow(value) {
  return value === undefined ? null : value;
}

// Field-level diff between frozen basis and live object (deep, JSON-shaped).
export function diffValues(base, current, path = '') {
  const changes = [];
  const walk = (a, b, p) => {
    const aMissing = a === undefined;
    const bMissing = b === undefined;
    if (aMissing || bMissing) {
      if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) {
        changes.push({path: p || '$', kind: aMissing ? 'added' : 'removed', from: a ?? null, to: b ?? null});
      }
      return;
    }
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of keys) walk(a[key], b[key], p ? `${p}.${key}` : key);
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({path: p || '$', kind: 'changed', from: a, to: b});
  };
  walk(base, current, path);
  return changes;
}

export function submissionView(store, registry, submission) {
  const live = store.current.get(submission.objectId) || null;
  const history = store.decisions
    .filter((d) => d.submissionId === submission.id)
    .map((d) => ({...d}));

  const view = {
    id: submission.id,
    objectId: submission.objectId,
    status: submission.status,
    mode: submission.mode,
    submittedBy: submission.submittedBy,
    submittedAt: submission.submittedAt,
    decidedAt: shallow(submission.decidedAt),
    withdrawnAt: shallow(submission.withdrawnAt),
    baseVersion: submission.sourceVersion,
    currentVersion: live?.version ?? 0,
    conflict: submission.conflict ?? null,
    sourceMoved: (live?.version ?? 0) !== submission.sourceVersion,
    result: submission.result ? structuredClone(submission.result) : null,
    history,
  };

  if (submission.mode === 'frozen') {
    const check = checkEvidence(submission.snapshot, registry);
    let replay = null;
    if (check.complete) {
      try { replay = replaySnapshot(submission.snapshot, registry); }
      catch (error) { replay = {matches: false, error: {code: error.code, message: error.message}}; }
    }
    view.snapshot = structuredClone(submission.snapshot);
    view.evidence = {
      complete: check.complete,
      replayable: check.complete,
      problems: check.problems,
      replay,
    };
    view.diff = {
      baseToCurrent: diffValues(submission.snapshot.baseValue, live ? live.value : null),
      proposedToCurrent: diffValues(submission.snapshot.proposedValue, live ? live.value : null),
    };
  } else {
    view.snapshot = structuredClone(submission.snapshot);
    view.evidence = {
      complete: false,
      replayable: false,
      problems: [
        {field: 'snapshot.input', code: 'EVIDENCE_MISSING', message: 'legacy submission: input was not frozen'},
        {field: 'rule', code: 'RULE_VERSION_MISSING', message: 'legacy submission: rule version was not recorded'},
        {field: 'digest', code: 'EVIDENCE_MISSING', message: 'legacy submission: no integrity digest'},
      ],
      replay: null,
    };
    view.diff = {baseToCurrent: [], proposedToCurrent: []};
  }
  return view;
}

export function appState(store, registry, viewer) {
  const submissions = [...store.submissions.values()]
    .sort((a, b) => a.id - b.id)
    .map((s) => submissionView(store, registry, s));
  const perms = viewer ? (store.permissions.get(viewer) ?? null) : null;
  return {
    asOf: store.now(),
    viewer: viewer ?? null,
    permissions: perms,
    current: Object.fromEntries([...store.current.entries()].map(([k, v]) => [k, structuredClone(v)])),
    submissions,
    decisions: store.decisions.map((d) => ({...d})),
    events: [...store.events],
    rules: registry.entries.map((r) => ({ruleId: r.ruleId, version: r.version, description: r.description, digest: r.digest})),
  };
}

// Approval evidence review UI.
//
// Nothing on this page is a client-side cache of "the JSON before submit":
// every snapshot, diff and decision is fetched from server-persisted state.
// The three tabs deliberately separate:
//   snapshot -> the frozen basis (inputs / rule version+body / digests)
//   diff     -> frozen base vs the CURRENT object
//   history  -> append-only decisions replayed with their bound basis

const $ = (selector) => document.querySelector(selector);

const state = {
  actor: $('#actor').value,
  overview: null,
  selectedId: null,
  tab: 'snapshot',
  detail: null,
  live: false,
};

/* ------------------------------- api helpers ------------------------------- */

async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(state.actor ? {'x-actor': state.actor} : {}),
      ...(options.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body.error ?? `request failed (${res.status})`);
    error.status = res.status;
    error.code = body.code;
    error.details = body.details;
    throw error;
  }
  return body;
}

const post = (path, body) => request(path, {method: 'POST', body: JSON.stringify(body)});
const put = (path, body) => request(path, {method: 'PUT', body: JSON.stringify(body)});

/* ------------------------------- rendering --------------------------------- */

function esc(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[char]));
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function banner(kind, text) {
  return `<div class="banner ${kind}">${esc(text)}</div>`;
}

function statusBadge(status) {
  return `<span class="badge ${status}">${status}</span>`;
}

function renderQueue() {
  const submissions = [...(state.overview?.submissions ?? [])].sort((a, b) => b.id - a.id);
  if (!submissions.length) {
    $('#queue').innerHTML = '<p class="muted">No submissions yet.</p>';
    return;
  }
  $('#queue').innerHTML = submissions.map((submission) => `
    <div class="submission ${submission.id === state.selectedId ? 'active' : ''}" data-id="${submission.id}">
      <div class="top">
        <strong>#${submission.id} ${esc(submission.objectId)}</strong>
        ${statusBadge(submission.status)}
      </div>
      <div class="meta">
        base v${submission.baseVersion} · head v${submission.headVersion}
        ${submission.stale ? '<span class="flag stale">object changed</span>' : ''}
        ${submission.status === 'superseded' ? `<span class="flag stale">superseded by #${submission.supersededBy}</span>` : ''}
      </div>
      <div class="meta">by ${esc(submission.actor ?? 'legacy')} · ${new Date(submission.submittedAt).toLocaleString()}</div>
    </div>
  `).join('');
  for (const element of document.querySelectorAll('.submission')) {
    element.addEventListener('click', () => selectSubmission(Number(element.dataset.id)));
  }
}

function renderReview() {
  const root = $('#review');
  if (!state.selectedId) {
    root.innerHTML = '<p class="muted">Select a submission from the queue.</p>';
    return;
  }
  if (!state.detail) {
    root.innerHTML = '<p class="muted">Loading…</p>';
    return;
  }

  const {submission, verification, diff, decisions} = state.detail;
  const damaged = !verification.ok;
  const active = submission.status === 'pending' || submission.status === 'superseded';

  let warnings = '';
  if (damaged) {
    const parts = [];
    if (verification.missing.length) parts.push(`missing: ${verification.missing.join(', ')}`);
    if (verification.tampered.length) parts.push(`tampered: ${verification.tampered.join(', ')}`);
    warnings += banner('error', `Frozen evidence is damaged — ${parts.join('; ')}`);
  }
  if (verification.objectChanged) {
    warnings += banner('warn',
      `Current object is at v${verification.headVersion}; this submission froze v${verification.baseVersion}. ` +
      'An approval cannot execute until the conflict is resolved explicitly.');
  }
  if (submission.status === 'superseded') {
    warnings += banner('warn', `This submission was superseded by #${submission.supersededBy}. Approving it is blocked.`);
  }

  root.innerHTML = `
    <div class="top" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
      <div>
        <strong style="font-size:16px">#${submission.id} ${esc(submission.objectId)}</strong>
        ${statusBadge(submission.status)}
        ${submission.stale ? '<span class="flag stale">stale</span>' : ''}
        ${damaged ? '<span class="flag damaged">evidence damaged</span>' : ''}
      </div>
    </div>
    ${warnings}
    <div class="tabs">
      <button class="tab ${state.tab === 'snapshot' ? 'active' : ''}" data-tab="snapshot">Original snapshot</button>
      <button class="tab ${state.tab === 'diff' ? 'active' : ''}" data-tab="diff">Current difference</button>
      <button class="tab ${state.tab === 'history' ? 'active' : ''}" data-tab="history">History (${decisions.length})</button>
    </div>
    <div id="tab-body"></div>
    <div id="action-bar"></div>
  `;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => { state.tab = tab.dataset.tab; renderReview(); });
  }
  renderTab();
  renderActions(submission, verification, active);
}

function renderTab() {
  const body = $('#tab-body');
  const {submission, verification, diff, decisions} = state.detail;

  if (state.tab === 'snapshot') {
    // Highlight missing/tampered paths inline so the reviewer can locate the damage.
    const evidenceHtml = highlightEvidence(submission.evidence, verification);
    body.innerHTML = `
      <dl class="kv">
        <dt>Submitted by</dt><dd>${esc(submission.actor ?? 'legacy client')} at ${new Date(submission.submittedAt).toLocaleString()}</dd>
        <dt>Frozen against</dt><dd>${esc(submission.objectId)} v${submission.baseVersion}</dd>
        <dt>Rule version</dt><dd>${esc(submission.evidence.ruleVersion ?? '—')} ${verification.ruleKnown ? '' : '<span class="flag damaged">rule no longer registered</span>'}</dd>
        <dt>Evidence digest</dt><dd title="sha256 of the field digest set">${esc(submission.evidence.digest.slice(0, 24))}…</dd>
        <dt>Frozen at</dt><dd>${esc(submission.evidence.frozenAt)}</dd>
      </dl>
      <h2 style="margin-top:8px">Inputs</h2>
      <pre>${esc(pretty(submission.evidence.inputs))}</pre>
      <h2 style="margin-top:8px">Computed summary</h2>
      <pre>${esc(pretty(submission.evidence.summary))}</pre>
      <h2 style="margin-top:8px">Frozen rule body</h2>
      <pre>${esc(pretty(submission.evidence.ruleBody))}</pre>
      <h2 style="margin-top:8px">Base value → proposed value</h2>
      <pre>${esc(pretty({baseValue: submission.baseValue, proposedValue: submission.proposedValue}))}</pre>
      <h2 style="margin-top:8px">Evidence envelope (field digests)</h2>
      ${evidenceHtml}
    `;
    return;
  }

  if (state.tab === 'diff') {
    body.innerHTML = `
      <p class="meta">Comparing the frozen base (v${diff.baseVersion}) with the object's current head (v${diff.currentVersion}).</p>
      ${diff.changed
        ? `<div class="banner warn">The object changed after submission — ${diff.paths.length} path(s) differ.</div>
           <div>${diff.paths.map((path) => `<span class="diff-path">${esc(path)}</span>`).join('')}</div>
           <h2 style="margin-top:12px">Frozen base value</h2><pre>${esc(pretty(state.detail.frozenBase ?? submission.baseValue))}</pre>
           <h2>Current live value</h2><pre>${esc(pretty(state.detail.currentValue))}</pre>
           <h2>What approval would have applied</h2><pre>${esc(pretty(submission.proposedValue))}</pre>`
        : '<div class="banner ok">Current object still matches the frozen base.</div>'}
    `;
    return;
  }

  // history
  if (!decisions.length) {
    body.innerHTML = '<p class="muted">No decisions recorded yet. The first approve/reject/withdraw will be bound to this exact snapshot and replayable here.</p>';
    return;
  }
  body.innerHTML = decisions.map((entry) => `
    <div class="decision ${entry.decision.action}">
      <strong>${entry.decision.action}</strong>
      by ${esc(entry.decision.actor ?? 'legacy')} · ${new Date(entry.decision.at).toLocaleString()}
      ${entry.decision.reason ? `— <em>${esc(entry.decision.reason)}</em>` : ''}
      <div class="meta">
        prior state: ${entry.decision.priorStatus} → ${entry.decision.status} ·
        bound basis v${entry.decision.basis.sourceVersion} ·
        digest ${esc(entry.decision.basis.evidenceDigest.slice(0, 16))}…
      </div>
      <div class="meta">
        execution: ${entry.execution
          ? (entry.execution.noChange
              ? 'recorded (legacy no-change)'
              : `applied as v${entry.execution.version} on top of v${entry.execution.baseVersion}`)
          : 'none (object not modified)'}
      </div>
      <div class="meta">at decision time head was v${entry.current.version}; now head is v${state.detail.currentHead}</div>
    </div>
  `).join('') + `
    <h2 style="margin-top:12px">Last decision replay bundle</h2>
    <pre>${esc(pretty({
      basis: decisions.at(-1).frozen.evidence,
      execution: decisions.at(-1).execution,
      verification: decisions.at(-1).verification,
    }))}</pre>`;
}

function highlightEvidence(evidence, verification) {
  const missing = new Set(verification.missing);
  const tampered = new Set(verification.tampered);
  const rows = Object.entries(evidence.digests ?? {}).map(([field, hash]) => {
    const path = `evidence.${field}`;
    const mark = missing.has(path)
      ? '<span class="flag damaged">missing</span>'
      : tampered.has(path)
        ? '<span class="flag damaged">tampered</span>'
        : '<span class="flag" style="background:#e3f5ea;color:#1d5c3d">ok</span>';
    return `<tr><td style="padding:2px 10px 2px 0">${field} ${mark}</td><td><code>${esc(hash.slice(0, 20))}…</code></td></tr>`;
  }).join('');
  const envelope = tampered.has('evidence.digests')
    ? banner('error', 'digest envelope itself was modified')
    : verification.digestMatches ? banner('ok', 'envelope digest matches') : '';
  return `${envelope}<table style="font-size:12px">${rows}</table>`;
}

function renderActions(submission, verification, active) {
  const can = submission.can;
  const reason = (allowed, why) => allowed ? '' : `disabled title="${esc(why)}"`;
  const bars = [];

  if (!active) {
    bars.push(`<div class="banner ok">Finished: ${submission.status} (decision #${submission.outcomeDecisionSeq}). Further decisions are refused server-side, not hidden.</div>`);
  }

  const blockReasons = [];
  if (verification.objectChanged && can.approve) blockReasons.push('object drifted since submission');
  if (submission.status === 'superseded') blockReasons.push('submission superseded');
  if (!verification.ok) blockReasons.push('evidence damaged');

  bars.push(`
    <div class="row">
      <button id="approve-btn" ${can.approve && !blockReasons.length ? '' : reason(false, can.approve ? blockReasons.join('; ') : 'you lack approve permission')}>Approve</button>
      <button class="secondary" id="reject-btn" ${can.reject && verification.ok ? '' : reason(false, !can.reject ? 'you lack approve permission' : 'evidence damaged')}>Reject</button>
      <button class="ghost" id="withdraw-btn" ${can.withdraw ? '' : reason(false, 'only the submitter or withdraw.any may withdraw')}>Withdraw</button>
      <span class="muted" style="align-self:center">permissions evaluated live for <code>${esc(state.actor || 'anonymous')}</code></span>
    </div>
    <div id="action-msg"></div>
  `);
  $('#action-bar').innerHTML = bars.join('');

  $('#approve-btn')?.addEventListener('click', () => decide('approve'));
  $('#reject-btn')?.addEventListener('click', () => decide('reject'));
  $('#withdraw-btn')?.addEventListener('click', () => decide('withdraw'));
}

/* -------------------------------- actions ---------------------------------- */

function explain(error) {
  if (error.code === 'version-conflict') {
    return `Version conflict: frozen against v${error.details.baseVersion}, but the object is now at v${error.details.headVersion}. The approval was refused — no version was modified.`;
  }
  if (error.code === 'superseded') return `This submission was superseded by #${error.details.supersededBy}; the server refused to approve stale evidence.`;
  if (error.code === 'already-decided') return `Already ${error.details.status}. Duplicate decisions are rejected.`;
  if (error.code === 'forbidden') return `Forbidden (403): ${error.message}`;
  if (error.code === 'corrupt-evidence') {
    const d = error.details;
    return `Evidence damaged${d.missing?.length ? ` — missing ${d.missing.join(', ')}` : ''}${d.tampered?.length ? ` — tampered ${d.tampered.join(', ')}` : ''}`;
  }
  if (error.code === 'invalid-evidence' && error.details?.missing) {
    return `Submission rejected (400), missing: ${error.details.missing.join(', ')}`;
  }
  if (error.code === 'stale-base') return `Stale base: your form was built on v${error.details.baseVersion}, head is v${error.details.headVersion}. Reload and resubmit.`;
  return error.message;
}

async function decide(action) {
  const reasonText = action === 'reject' ? prompt('Reason for rejection (optional):') ?? '' : '';
  const msg = $('#action-msg');
  msg.innerHTML = '';
  try {
    await post('/api/decisions', {submissionId: state.selectedId, action, reason: reasonText || null});
    await refresh(state.selectedId);
  } catch (error) {
    msg.innerHTML = banner('error', explain(error));
    await refresh(state.selectedId);
  }
}

async function selectSubmission(id) {
  state.selectedId = id;
  state.tab = 'snapshot';
  renderQueue();
  await loadDetail();
}

async function loadDetail() {
  if (!state.selectedId) return;
  try {
    const detail = await request(`/api/submissions/${state.selectedId}`);
    state.detail = detail;
    state.detail.currentValue = (state.overview.objects.find((object) => object.id === detail.submission.objectId) ?? {}).value;
    state.detail.currentHead = (state.overview.objects.find((object) => object.id === detail.submission.objectId) ?? {}).version;
    state.detail.frozenBase = detail.submission.baseValue;
  } catch (error) {
    state.detail = null;
    $('#review').innerHTML = banner('error', explain(error));
    return;
  }
  renderReview();
}

async function refresh(keepSelected = state.selectedId) {
  state.overview = await request('/api/approvals');
  if (keepSelected && !state.overview.submissions.some((s) => s.id === keepSelected)) state.selectedId = null;
  renderQueue();
  if (state.selectedId) await loadDetail();
  else renderReview();
}

/* --------------------------------- forms ----------------------------------- */

function parseJsonField(element, label) {
  try {
    return JSON.parse(element.value);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

$('#submit-btn').addEventListener('click', async () => {
  const msg = $('#submit-msg');
  msg.innerHTML = '';
  try {
    const body = {
      objectId: $('#f-object').value.trim(),
      proposedValue: parseJsonField($('#f-proposed'), 'Proposed value'),
      inputs: parseJsonField($('#f-inputs'), 'Inputs'),
      ruleVersion: $('#f-rule').value.trim(),
      summary: parseJsonField($('#f-summary'), 'Summary'),
    };
    const created = await post('/api/submissions', body);
    msg.innerHTML = banner('ok', `Submitted #${created.id}; evidence frozen against v${created.baseVersion}.`);
    state.selectedId = created.id;
    state.tab = 'snapshot';
    await refresh(created.id);
  } catch (error) {
    msg.innerHTML = banner('error', explain(error));
  }
});

$('#direct-btn').addEventListener('click', async () => {
  const msg = $('#submit-msg');
  msg.innerHTML = '';
  try {
    const value = parseJsonField($('#d-value'), 'Direct-save value');
    const current = await put('/api/source', {id: $('#f-object').value.trim(), value});
    msg.innerHTML = banner('warn', `Direct save applied: object is now v${current.version} (no approval required). Pending evidence against older versions will show drift.`);
    await refresh(state.selectedId);
  } catch (error) {
    msg.innerHTML = banner('error', explain(error));
  }
});

$('#actor').addEventListener('change', async () => {
  state.actor = $('#actor').value;
  await refresh();
});

/* ------------------------------ real-time SSE ------------------------------ */

let eventSource = null;

function connect() {
  const since = state.overview?.eventSeq ?? 0;
  eventSource = new EventSource(`/api/events?since=${since}`);
  eventSource.addEventListener('hello', () => setLive(true));
  eventSource.addEventListener('open', () => setLive(true));
  eventSource.addEventListener('error', () => setLive(false));
  // Server emits typed events; default listeners catch everything not named above.
  for (const type of ['source-updated', 'submitted', 'decision-recorded', 'rule-defined', 'grant-changed']) {
    eventSource.addEventListener(type, (event) => {
      const data = JSON.parse(event.data);
      if (data.replay) return; // backlog already represented in overview
      refresh().catch((error) => console.error('refresh failed', error));
    });
  }
}

function setLive(online) {
  state.live = online;
  const indicator = $('#live');
  indicator.className = online ? 'online' : 'offline';
  indicator.textContent = online ? 'live: connected' : 'live: reconnecting…';
  if (!online && eventSource) {
    eventSource.close();
    eventSource = null;
    setTimeout(() => { refresh().then(connect).catch((error) => console.error('reconnect sync failed', error)); }, 1500);
  }
}

/* --------------------------------- boot ------------------------------------ */

(async function boot() {
  await refresh(null);
  connect();
  // Safety net: refocus always re-syncs with the server, never with local state.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh().catch(() => {}); });
})();

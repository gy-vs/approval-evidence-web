// Approval evidence review UI.
//
// The client never invents evidence: the snapshot tabs render server-frozen
// data, and every button reflects an explicit server state (including errors).
// Real-time updates come from SSE with a polling fallback.

const $ = (sel, root = document) => root.querySelector(sel);
const actorSelect = $('#actor');
let state = null;

const getActor = () => actorSelect.value;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}
function pretty(value) {
  return JSON.stringify(value, null, 2);
}

let bannerTimer = null;
function banner(text, kind = 'error') {
  const el = $('#banner');
  el.textContent = text;
  el.className = `banner ${kind}`;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.add('hidden'), 6000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {'content-type': 'application/json', 'x-actor': getActor(), ...(options.headers || {})},
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || `请求失败 (${response.status})`);
    err.code = data.code;
    err.details = data.details;
    err.status = response.status;
    throw err;
  }
  return data;
}

async function loadState() {
  state = await api(`/api/state?viewer=${encodeURIComponent(getActor())}`);
  render();
}

function renderPerms() {
  const p = state.permissions;
  $('#perms').textContent = p
    ? `权限：可提交=${p.canSubmit ? '是' : '否'} · 可审批=${p.canApprove ? '是' : '否'}`
    : '权限：未知用户（无可执行操作）';
  $('#rule-select').innerHTML = '';
  for (const rule of state.rules) {
    const opt = document.createElement('option');
    opt.value = `${rule.ruleId}@${rule.version}`;
    opt.textContent = `${rule.ruleId} v${rule.version} — ${rule.description}`;
    $('#rule-select').append(opt);
  }
}

function renderCurrent() {
  $('#current').textContent = pretty(state.current);
}

function badge(label, cls) {
  return `<span class="badge badge-${cls}">${escapeHtml(label)}</span>`;
}

function evidenceProblemsHtml(sub) {
  if (sub.evidence.complete) return '';
  return sub.evidence.problems.map((p) =>
    `<div class="problem">定位：<span class="field">${escapeHtml(p.field)}</span> · ${escapeHtml(p.code)} — ${escapeHtml(p.message)}</div>`
  ).join('');
}

function replayHtml(sub) {
  const ev = sub.evidence;
  if (!ev.replay) return '<p class="state-note">证据不完整，无法回放（见上方定位信息）。</p>';
  if (ev.replay.error) return `<p class="fail">回放失败：${escapeHtml(ev.replay.error.code)} — ${escapeHtml(ev.replay.error.message)}</p>`;
  const rows = ev.replay.steps.map((s) =>
    `<tr class="${s.matches ? '' : 'removed'}"><td>${escapeHtml(s.check)}</td><td class="${s.matches ? 'ok' : 'fail'}">${s.matches ? '一致' : '不一致'}</td><td><code>${escapeHtml(pretty(s.expected))}</code></td><td><code>${escapeHtml(pretty(s.actual))}</code></td></tr>`
  ).join('');
  return `<p class="${ev.replay.matches ? 'ok' : 'fail'}">${ev.replay.matches ? '✓ 用冻结的规则版本重算冻结输入，全部摘要一致' : '✗ 重算结果与冻结证据不一致'}（${escapeHtml(ev.replay.ruleDescription || '')}）</p>
    <table class="diff-table"><tr><th>检查项</th><th>结果</th><th>冻结值</th><th>重算值</th></tr>${rows}</table>`;
}

function diffHtml(rows, emptyText) {
  if (!rows.length) return `<p class="ok">无差异</p>`;
  const body = rows.map((d) =>
    `<tr class="${escapeHtml(d.kind)}"><td><code>${escapeHtml(d.path)}</code></td><td>${escapeHtml(d.kind)}</td><td><code>${escapeHtml(pretty(d.from))}</code></td><td><code>${escapeHtml(pretty(d.to))}</code></td></tr>`
  ).join('');
  return `<table class="diff-table"><tr><th>路径</th><th>类型</th><th>提交时</th><th>现在</th></tr>${body}</table><p class="state-note">${escapeHtml(emptyText)}</p>`;
}

function historyHtml(sub) {
  if (!sub.history.length) return '<p class="state-note">尚无决定记录。</p>';
  return sub.history.map((d) => `
    <div class="kv">
      ${badge(d.outcome, d.outcome)}
      <strong>${escapeHtml(d.decidedBy || '匿名')}</strong>
      @ ${escapeHtml(d.decidedAt)}
      · 依据快照 <code>${escapeHtml(d.actedOnSnapshotDigest ? d.actedOnSnapshotDigest.slice(0, 16) + '…' : '(无)')}</code>
      · 决定时源版本 v${d.currentVersionAtDecision}，提交基线 v${d.sourceVersion}
      ${d.conflictAcknowledged ? ' · <span class="badge badge-conflict">已确认版本冲突</span>' : ''}
      ${d.appliedVersion ? ` · 执行落库版本 v${d.appliedVersion}` : ''}
      ${d.reason ? ` · 理由：${escapeHtml(d.reason)}` : ''}
    </div>`).join('');
}

function snapshotPaneHtml(sub) {
  if (sub.mode === 'frozen') {
    const s = sub.snapshot;
    return `
      ${evidenceProblemsHtml(sub)}
      <p class="kv">对象 <code>${escapeHtml(sub.objectId)}</code> · 提交人 <code>${escapeHtml(sub.submittedBy)}</code> · 提交于 ${escapeHtml(sub.submittedAt)}</p>
      <p class="kv">规则版本 <code>${escapeHtml(s.rule.ruleId)}@v${s.rule.version}</code> · 规则摘要 <code>${escapeHtml(s.rule.digest.slice(0, 20))}…</code></p>
      <p class="kv">基线版本 <code>v${s.baseVersion}</code> · 快照摘要 <code>${escapeHtml(s.digest)}</code></p>
      <details open><summary>冻结输入</summary><pre class="codeblock">${escapeHtml(pretty(s.input))}</pre></details>
      <details open><summary>规则计算结果 / 拟执行值</summary><pre class="codeblock">${escapeHtml(pretty({ruleOutcome: s.ruleOutcome, proposedValue: s.proposedValue}))}</pre></details>
      <details><summary>基线对象值（提交当时）</summary><pre class="codeblock">${escapeHtml(pretty(s.baseValue))}</pre></details>
      ${replayHtml(sub)}`;
  }
  return `
    ${evidenceProblemsHtml(sub)}
    <p><span class="badge badge-legacy">legacy</span> 该提交走旧的直接路径，未冻结输入/规则/摘要，只能查看原始 evidence：</p>
    <pre class="codeblock">${escapeHtml(pretty(sub.snapshot))}</pre>`;
}

function actionBlock(sub, perms) {
  if (sub.status !== 'pending') {
    const label = {approved: '已批准（执行对象见“历史决定”）', rejected: '已拒绝', withdrawn: '已撤回'}[sub.status];
    return `<p class="state-note">${escapeHtml(label)}——终态操作按钮不再可用，重复操作会被服务端拒绝并返回 DECISION_CONFLICT / NOT_PENDING。</p>`;
  }
  const blocks = [];
  if (sub.sourceMoved) {
    blocks.push(`<div class="problem">版本冲突：提交基线 v${sub.baseVersion}，当前对象已是 v${sub.currentVersion}。
      批准将只作用于冻结的拟执行值（不会采用当前值）。请先查看“当前差异”，勾选确认后才能操作；不确认时服务端返回 CONFLICT。</div>`);
  }
  if (!perms || !perms.canApprove) {
    blocks.push(`<p class="state-note">当前用户没有审批权限（服务端会返回 PERMISSION_DENIED，而非隐藏流程）。</p>`);
  }
  if (sub.mode === 'legacy') {
    blocks.push(`<p class="state-note">旧版提交在源数据变化后按原契约拒绝（SOURCE_CHANGED）；当前未变化时可直接决定。</p>`);
  }
  const canAct = Boolean(perms?.canApprove);
  blocks.push(`<div class="actions">
      <input type="text" data-role="reason" placeholder="审批理由（可选）">
      <label class="state-note" style="${sub.sourceMoved ? '' : 'display:none'}">
        <input type="checkbox" data-role="ack"> 我已知悉源数据已变化，按冻结快照执行
      </label>
      <button class="primary" data-action="approve" ${canAct ? '' : 'disabled'}>批准（作用于冻结值）</button>
      <button class="danger" data-action="reject" ${canAct ? '' : 'disabled'}>拒绝</button>
      <button data-action="withdraw" ${sub.submittedBy === getActor() ? '' : 'disabled'}>撤回（仅提交人）</button>
    </div>`);
  return blocks.join('');
}

function submissionCard(sub) {
  const perms = state.permissions;
  const cls = ['submission'];
  if (sub.status !== 'pending') cls.push(sub.status);
  if (sub.sourceMoved && sub.status === 'pending') cls.push('conflict');
  if (!sub.evidence.complete) cls.push('evidence-bad');
  const badges = [badge(sub.status, sub.status)];
  if (sub.mode === 'legacy') badges.push(badge('legacy', 'legacy'));
  if (sub.sourceMoved && sub.status === 'pending') badges.push(badge(`源已变化 v${sub.baseVersion}→v${sub.currentVersion}`, 'conflict'));
  if (!sub.evidence.complete && sub.status === 'pending') badges.push(badge('证据缺失', 'rejected'));

  return `<article class="${cls.join(' ')}" data-id="${sub.id}">
    <div class="sub-head">
      <span class="sub-title">#${sub.id} · ${escapeHtml(sub.objectId)} · 提交人 ${escapeHtml(sub.submittedBy || '匿名')}</span>
      <span>${badges.join(' ')}</span>
    </div>
    ${sub.result?.applied ? `<p class="ok">已执行落库：v${sub.result.appliedVersion} = ${escapeHtml(pretty(sub.result.appliedValue))}（绑定快照 ${escapeHtml((sub.result.digest || '').slice(0, 16))}…）</p>` : ''}
    <div class="tabs">
      <button data-tab="snapshot" class="active">原始快照</button>
      <button data-tab="diff">当前差异</button>
      <button data-tab="history">历史决定</button>
    </div>
    <div class="tabpane active" data-pane="snapshot">${snapshotPaneHtml(sub)}</div>
    <div class="tabpane" data-pane="diff">
      <p class="kv">基线 → 当前</p>${diffHtml(sub.diff.baseToCurrent, '提交时的对象值与当前 live 对象的差异')}
      <p class="kv">拟执行值 → 当前</p>${diffHtml(sub.diff.proposedToCurrent, '批准将写入的值与当前 live 对象的差异')}
    </div>
    <div class="tabpane" data-pane="history">${historyHtml(sub)}</div>
    ${actionBlock(sub, perms)}
  </article>`;
}

function renderSubmissions() {
  const pending = state.submissions.filter((s) => s.status === 'pending');
  const finished = state.submissions.filter((s) => s.status !== 'pending');
  $('#pending').innerHTML = pending.length ? pending.map(submissionCard).join('') : '<p class="state-note">没有待审批项。</p>';
  $('#finished').innerHTML = finished.length ? finished.map(submissionCard).join('') : '<p class="state-note">尚无已结束的审批。</p>';
}

function render() {
  renderPerms();
  renderCurrent();
  renderSubmissions();
}

// --- actions ---------------------------------------------------------------
document.addEventListener('click', async (event) => {
  const tab = event.target.closest('[data-tab]');
  if (tab) {
    const card = tab.closest('.submission');
    card.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === tab));
    const name = tab.dataset.tab;
    card.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const card = button.closest('.submission');
  const id = Number(card.dataset.id);
  const action = button.dataset.action;
  try {
    if (action === 'withdraw') {
      await api(`/api/submissions/${id}/withdraw`, {method: 'POST', body: JSON.stringify({})});
      banner(`提交 #${id} 已撤回`, 'success');
    } else {
      const reason = card.querySelector('[data-role=reason]').value;
      const ack = card.querySelector('[data-role=ack]')?.checked;
      await api('/api/decisions', {method: 'POST', body: JSON.stringify({submissionId: id, outcome: action, reason, allowConflict: Boolean(ack)})});
      banner(`提交 #${id} 已${action === 'approve' ? '批准' : '拒绝'}`, 'success');
    }
    await loadState();
  } catch (error) {
    banner(`[${error.code || error.status}] ${error.message}`, 'error');
    await loadState();
  }
});

$('#direct-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  let value;
  try { value = JSON.parse(form.get('value')); }
  catch { return banner('直接保存的值不是合法 JSON', 'error'); }
  try {
    await api('/api/source', {method: 'PUT', body: JSON.stringify({id: form.get('id'), value})});
    banner('已直接保存（原路径兼容）', 'success');
    await loadState();
  } catch (error) { banner(`[${error.code}] ${error.message}`, 'error'); }
});

$('#submit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  let input;
  try { input = JSON.parse(form.get('input')); }
  catch { return banner('输入不是合法 JSON', 'error'); }
  const [ruleId, version] = form.get('rule').split('@');
  try {
    await api('/api/submissions', {method: 'POST', body: JSON.stringify({objectId: form.get('objectId'), input, rule: {ruleId, version: Number(version)}})});
    banner('证据已冻结并提交', 'success');
    await loadState();
  } catch (error) { banner(`[${error.code}] ${error.message}`, 'error'); }
});

actorSelect.addEventListener('change', loadState);
$('#refresh').addEventListener('click', loadState);

// --- realtime: SSE with polling fallback ------------------------------------
function setLive(on, label) {
  const el = $('#live');
  el.className = `live ${on ? 'live-on' : 'live-off'}`;
  el.textContent = label;
}

function connectStream() {
  const es = new EventSource('/api/events');
  let polling = null;
  es.addEventListener('hello', () => setLive(true, '实时 ●'));
  es.addEventListener('ledger', () => { loadState().catch(() => {}); });
  es.onerror = () => {
    setLive(false, '离线，轮询中 ○');
    es.close();
    polling = setInterval(() => loadState().catch(() => {}), 3000);
    // Try to restore SSE periodically.
    setTimeout(() => { clearInterval(polling); connectStream(); }, 15000);
  };
}

loadState().catch((error) => banner(`加载失败：${error.message}`, 'error'));
connectStream();

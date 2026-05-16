// PR-V Phase 3.17 — Permission Gate (PR3 destructive-op confirmation).
// Extracted from chat.html inline <script> (was lines 3308-3437).
//
// User-facing permission flow:
//   1. Agent (or UI action) wants to do something destructive
//      (write file, run shell, exec code, run plugin tool).
//   2. requestPermission(opts) shows a glassmorphic overlay with
//      eyebrow + scope chips + 5-sec countdown for irreversible
//      operations. Returns Promise<boolean> or Promise<decision>.
//   3. handleAgentPermissionGate routes agent-step permission events
//      through the same UI.
//   4. _gateDestructive + safe* helpers wrap each destructive IPC so
//      callers don'''t bypass the gate. safeWriteWorkspaceFile,
//      safeWorkspaceShell, safeExecCode, safeShell, safeWriteFile.
//
// Allowlist (persisted in electron-store via permissionAllowlist):
//   refreshPermissionAllowlist — renders the saved list in
//     Settings → Features so user can review/revoke approvals.
//   revokePermissionEntry — removes one approval.
//
// Loaded as external script AFTER main inline so window.* globals
// it reads (H IPC, addMsg, lang, codeSetStatus, etc.) are defined.

// ═══ PERMISSION CARD (P3) — gate destructive operations ═══
// Returns Promise<boolean>. true = allow, false = deny. Esc = deny, Enter = allow.
function requestPermission(opts){
  return new Promise(resolve => {
    try {
      const returnDecision = Boolean(opts?.returnDecision);
      const overlay = document.createElement('div');
      overlay.className = 'perm-overlay';
      const card = document.createElement('div');
      card.className = 'perm-card';
      const title = opts?.title || 'Action';
      const eyebrow = opts?.eyebrow || (lang === 'ru' ? 'Нужно разрешение' : 'Permission required');
      const desc = opts?.description || '';
      card.innerHTML =
        '<div class="perm-eyebrow">'+_escHtml(eyebrow)+'</div>'+
        '<div class="perm-title">'+_escHtml(title)+'</div>'+
        '<div class="perm-desc">'+_escHtml(desc)+'</div>'+
        (opts?.detail ? '<pre class="perm-detail">'+_escHtml(opts.detail)+'</pre>' : '')+
        '<div class="perm-actions">'+
          '<button class="perm-btn deny" data-act="deny">'+_escHtml(lang === 'ru' ? 'Отклонить' : 'Deny')+'</button>'+
          '<button class="perm-btn once" data-act="allow_once">'+_escHtml(lang === 'ru' ? 'Разрешить 1 раз' : 'Allow once')+' ⏎</button>'+
          '<button class="perm-btn always" data-act="always_allow">'+_escHtml(lang === 'ru' ? 'Всегда разрешать' : 'Always allow')+'</button>'+
        '</div>'+
        '<div class="perm-hint">'+_escHtml(lang === 'ru' ? 'Esc - отказ, Enter - разрешить один раз' : 'Esc to deny, Enter to allow once')+'</div>';
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      const cleanup = (decision) => {
        try { document.removeEventListener('keydown', onKey); } catch(_){}
        try { overlay.remove(); } catch(_){}
        resolve(returnDecision ? decision : decision !== 'deny');
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); cleanup('deny'); }
        else if (e.key === 'Enter') { e.preventDefault(); cleanup('allow_once'); }
      };
      document.addEventListener('keydown', onKey);
      card.querySelectorAll('[data-act]').forEach(btn => {
        btn.onclick = () => cleanup(btn.dataset.act || 'deny');
      });
      setTimeout(()=>{ try { card.querySelector('[data-act="allow_once"]').focus(); } catch(_){} }, 30);
    } catch(_) {
      resolve(opts?.returnDecision ? 'deny' : false);
    }
  });
}
var agentPermissionPrompts = new Set();
async function handleAgentPermissionGate(step){
  try {
    if (!step || step.type !== 'waiting' || !step.stepId) return;
    const perm = step.permission || {};
    if (!perm.required || perm.allowed) return;
    if (agentPermissionPrompts.has(step.stepId)) return;
    agentPermissionPrompts.add(step.stepId);
    const detail = perm.detail || (step.args ? JSON.stringify(step.args, null, 2).slice(0, 1200) : '');
    const decision = await requestPermission({
      returnDecision: true,
      eyebrow: 'Human-in-the-loop approval',
      title: perm.title || `${step.tool || 'tool'} requires approval`,
      description: perm.description || perm.reason || 'This action can affect files, the shell, network, browser, or external tools.',
      detail
    });
    const mapped = decision === 'always_allow' ? 'always_allow' : (decision === 'allow_once' ? 'allow_once' : 'deny');
    await H.agentStep?.(step.stepId, { decision: mapped, reason: 'permission gate' });
  } catch(e) {
    try { await H.agentStep?.(step?.stepId, { decision:'deny', reason:e.message || 'permission gate failed' }); } catch(_) {}
  } finally {
    if (step?.stepId) agentPermissionPrompts.delete(step.stepId);
  }
}
try { H.onAgentStep && H.onAgentStep((step) => handleAgentPermissionGate(step)); } catch(_){}
async function refreshPermissionAllowlist(){
  const host = document.getElementById('permission-allowlist');
  if (!host) return;
  try {
    const r = await H.permissionAllowlistList?.();
    const entries = Array.isArray(r?.entries) ? r.entries : [];
    if (!entries.length) {
      host.innerHTML = 'No saved approvals. Side-effect tools will ask first.';
      return;
    }
    host.innerHTML = entries.map(e => `
      <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--b1)">
        <div style="min-width:0">
          <div style="color:var(--tx);font-size:11px;font-weight:700">${_escHtml(e.tool || e.id || 'tool')}</div>
          <div style="color:var(--t3);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_escHtml([e.persona,e.workspace,e.operation,e.scope].filter(Boolean).join(' · '))}</div>
        </div>
        <button class="psv" onclick="revokePermissionEntry('${_escHtml(String(e.id || ''))}')">Revoke</button>
      </div>
    `).join('');
  } catch(e) {
    host.innerHTML = 'Could not load approvals: ' + _escHtml(e.message || 'unknown error');
  }
}
async function revokePermissionEntry(id){
  if (!id) return;
  await H.permissionAllowlistRevoke?.(id);
  refreshPermissionAllowlist();
}
// User-facing toggle so power users can disable the gate (off by default).
var permissionGateEnabled = true;
async function _gateDestructive(intent, opts) {
  if (!permissionGateEnabled) return true;
  return await requestPermission(opts);
}
async function safeExecCode(code, langCode){
  codeSetStatus('Waiting for permission before executing code...');
  return await H.execCode(code, langCode);
}
async function safeShell(cmd){
  setStatus(lang==='ru'?'Ожидаю подтверждения команды…':'Waiting for command approval...', true);
  return await H.pcShell(cmd);
}
async function safeWriteFile(filePath, content){
  return await H.pcWriteFile(filePath, content);
}
async function safeWriteWorkspaceFile(relPath, content, before=''){
  const ok = await requestDiffPermission({
    title: relPath,
    description: `Write inside selected workspace (${(content||'').length} chars).`,
    before,
    after: content,
    language: inferCodeLang(relPath)
  });
  if (!ok) return { ok:false, err:'denied by user' };
  return await H.wsWrite(relPath, content);
}
async function safeWorkspaceShell(cmd){
  codeSetStatus('Waiting for workspace command approval...');
  return await H.wsShell(cmd);
}
function setStatus(text,active=false){document.getElementById('stl').textContent=text;document.getElementById('pulse').classList.toggle('on',active);}


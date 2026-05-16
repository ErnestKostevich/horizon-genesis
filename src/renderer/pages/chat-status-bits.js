// PR-V Phase 3.23 — Git branch chip + Cost preview (status-bar bits).
// Extracted from chat.html inline <script> (was lines 1956-2195).
//
// Three closely-related status-bar features bundled:
//
//   1. Git branch indicator (PR-C4): reads .git/HEAD when workspace
//      changes + 30s poll; shows current branch in the shell chip.
//      State: _gitBranchPollTimer
//      Fns: refreshGitBranchChip, startGitBranchPoll, stopGitBranchPoll
//
//   2. Cost preview (PR-U-MEGA): live token + USD estimate under
//      composer as user types.
//      Fns: _estimateInputTokens, _estimateContextOverhead,
//           refreshCostPreview
//      DOMContentLoaded handler wires the input-listener.
//
//   3. Git branch dropdown: click chip → list of recent branches
//      → checkout (with permission gate via codeSetStatus).
//      Fns: toggleGitBranchDropdown, checkoutGitBranch
//
// Loaded as external script AFTER main inline so window.* globals
// (H IPC, prov, chatHistory, getSelectedModelForProvider, getModelPricing,
// _modelCache, MODEL_PRICING, codeSetStatus, etc.) are defined.

// ═══ PR-C4 — Git branch indicator + recent-branch dropdown ═══════════
// `refreshGitBranchChip()` is called whenever the workspace changes
// (see openCodeFile / chooseCodeWorkspace) and on a 30s poll while
// Code Mode is open so external CLI checkouts get reflected. Cheap:
// reads `.git/HEAD` directly, no shell-out for the common path.
var _gitBranchPollTimer = null;

async function refreshGitBranchChip() {
  const chip = document.getElementById('shell-git-branch');
  const nameEl = document.getElementById('shell-git-branch-name');
  if (!chip || !nameEl) return;
  const ws = (typeof codeWorkspace !== 'undefined' && codeWorkspace) ? codeWorkspace : null;
  if (!ws) {
    chip.style.display = 'none';
    return;
  }
  try {
    const r = await H.gitBranch?.(ws);
    if (r && r.ok && r.branch) {
      // Truncate long branch names so the chip doesn't push the rest
      // of the title bar off-screen.
      const display = r.branch.length > 28 ? r.branch.slice(0, 26) + '…' : r.branch;
      nameEl.textContent = display;
      nameEl.title = r.branch;
      chip.style.display = '';
      chip.classList.toggle('detached', !!r.detached);
    } else {
      chip.style.display = 'none';
    }
  } catch (_) {
    chip.style.display = 'none';
  }
}

function startGitBranchPoll() {
  if (_gitBranchPollTimer) return;
  refreshGitBranchChip().catch(() => {});
  _gitBranchPollTimer = setInterval(() => {
    if (!document.body.classList.contains('code-mode-active')) return;
    refreshGitBranchChip().catch(() => {});
  }, 30000);
}
function stopGitBranchPoll() {
  if (_gitBranchPollTimer) { clearInterval(_gitBranchPollTimer); _gitBranchPollTimer = null; }
}
// Auto-start poll once the renderer + IPC are ready.
window.addEventListener('DOMContentLoaded', () => { startGitBranchPoll(); });

// PR-B5 — set body class so per-OS CSS rules can hide the custom
// .wbtn buttons in favour of native window controls. Detection is
// best-effort (renderer can't read process.platform directly because
// nodeIntegration:false; we sniff via navigator.userAgent which is
// stable enough for this single decision).
(function _detectPlatform() {
  try {
    const ua = (navigator.userAgent || '').toLowerCase();
    if (ua.includes('mac os x') || ua.includes('darwin')) {
      document.body.classList.add('os-mac');
    } else if (ua.includes('windows') || ua.includes('win64') || ua.includes('win32')) {
      document.body.classList.add('os-win');
    } else {
      document.body.classList.add('os-linux');
    }
  } catch (_) { /* default to no-class behaviour (Linux-style custom .wbtn) */ }
})();

// PR-U-MEGA — single source of truth for layout cleanup. The
// `body.shell-clean` class hides the duplicated mode strip + chat
// status bar; composer-toolbar + composer-foot become the only
// ambient controls. Default ON for all users; can be toggled off
// via `H.set('shellClean', false)` for diagnostics.
(async function _bootShellClean() {
  try {
    const v = await H.get?.('shellClean');
    // Default ON unless explicitly disabled.
    document.body.classList.toggle('shell-clean', v !== false);
  } catch (_) {
    document.body.classList.add('shell-clean');
  }
})();

// PR-U-MEGA — cost preview line below the composer. Updates live
// as the user types so they SEE the cost-of-this-turn before sending.
// Estimate: input.length / 4 (≈ tokens) + a fixed 1500-token
// overhead for system prompt + persona + recent history. Uses the
// active provider's pricing from MODEL_PRICING (PR-C3).
function _estimateInputTokens(text) {
  // Rough char→token: 4 chars/token average for English code+prose.
  // Cyrillic averages closer to 2.5; we average to 3.5 → conservative.
  const chars = String(text || '').length;
  return Math.ceil(chars / 3.5);
}
function _estimateContextOverhead() {
  // System prompt + persona + recent history estimate.
  // History contributes ~150 tok per message; cap at 12 messages.
  try {
    const recent = Array.isArray(chatHistory) ? chatHistory.slice(-12) : [];
    const histTok = recent.reduce((s, m) => s + Math.ceil((m.content || '').length / 3.5), 0);
    return 800 + histTok; // 800 = system + persona baseline
  } catch (_) { return 800; }
}
function refreshCostPreview() {
  try {
    const inp = document.getElementById('inp');
    const tokEl = document.getElementById('composer-foot-tokens-n');
    const costEl = document.getElementById('composer-foot-cost');
    if (!tokEl || !costEl) return;
    const inputTok = _estimateInputTokens(inp?.value || '');
    const ctxTok = _estimateContextOverhead();
    const totalTok = inputTok + ctxTok;
    tokEl.textContent = totalTok > 1000 ? (totalTok / 1000).toFixed(1) + 'k' : String(totalTok);
    // Cost: input × $/Mtok + assumed 600-token output × $/Mtok
    const activeProv = (typeof prov !== 'undefined' && prov) ? prov : 'gemini';
    const activeModel = typeof getSelectedModelForProvider === 'function'
      ? getSelectedModelForProvider(activeProv)
      : '';
    const pricing = (typeof getModelPricing === 'function') ? getModelPricing(activeProv, activeModel) : null;
    if (pricing && pricing.in != null && pricing.out != null) {
      const costIn  = (totalTok / 1_000_000) * pricing.in;
      const costOut = (600       / 1_000_000) * pricing.out;
      const total = costIn + costOut;
      costEl.textContent = total === 0 ? 'free' : (total < 0.001 ? '< $0.001' : '$' + total.toFixed(4));
      costEl.title = `Input: $${costIn.toFixed(5)} (${totalTok} tok @ $${pricing.in}/Mtok) · Output est: $${costOut.toFixed(5)} (600 tok @ $${pricing.out}/Mtok)`;
    } else {
      // Local provider or no pricing data → show "free" or "—".
      const isLocal = ['ollama','lmstudio','localai'].includes(activeProv);
      costEl.textContent = isLocal ? 'free' : '—';
      costEl.title = isLocal ? 'Local model — no API cost' : 'Pricing data unavailable for this model';
    }
  } catch (_) { /* best-effort */ }
}
// Hook the existing `ar()` autosize handler (called on every keystroke)
// to also refresh the cost preview. We can't modify ar in-place
// because it's used everywhere — instead, install a MutationObserver-
// like input listener once.
window.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('inp');
  if (inp) {
    inp.addEventListener('input', () => { refreshCostPreview(); });
    refreshCostPreview();
  }
});


// PR-V Phase 3.19 — Agent HUD + Plan-Act gate + Provider Health
// traffic-light extracted to chat-hud-gates.js. setAgentHud,
// planActShowGate/HideGate, _planActApplyToggleVisuals,
// setProviderHealth all live there. H.ai-wrapping IIFE runs at
// file-load time.

// Recent-branches dropdown (click on the chip).
window.toggleGitBranchDropdown = async function (ev) {
  try { ev?.stopPropagation(); } catch (_) {}
  const pop = document.getElementById('git-branch-pop');
  const chip = document.getElementById('shell-git-branch');
  if (!pop || !chip) return;
  if (pop.classList.contains('show')) { pop.classList.remove('show'); return; }
  pop.innerHTML = `<div class="git-branch-pop-h">Loading branches…</div>`;
  // Position relative to chip BEFORE async fetch so user sees the
  // popover open immediately.
  const r = chip.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top = (r.bottom + 6) + 'px';
  pop.style.left = Math.max(8, Math.min(window.innerWidth - 280, r.left)) + 'px';
  pop.classList.add('show');

  let branches = [];
  let currentName = '';
  try {
    const cur = await H.gitBranch?.(codeWorkspace);
    if (cur && cur.ok) currentName = cur.branch;
    const list = await H.gitRecentBranches?.(codeWorkspace);
    if (list && list.ok) branches = list.branches;
  } catch (_) {}

  if (!branches.length) {
    pop.innerHTML = `<div class="git-branch-pop-empty">No recent branches found.</div>`;
  } else {
    pop.innerHTML = `
      <div class="git-branch-pop-h">RECENT BRANCHES · ${branches.length}</div>
      <ul class="git-branch-pop-list">
        ${branches.map(b => {
          const isCurrent = b === currentName;
          return `<li class="git-branch-pop-item${isCurrent ? ' on' : ''}" onclick="checkoutGitBranch('${String(b).replace(/'/g, "\\'")}')">
            <span class="git-branch-pop-icon">${isCurrent ? '●' : '○'}</span>
            <span class="git-branch-pop-name">${esc(b)}</span>
          </li>`;
        }).join('')}
      </ul>
      <div class="git-branch-pop-foot">Click a branch to checkout (asks permission)</div>`;
  }
  // Outside-click / Esc closes.
  const offClick = (e) => {
    if (pop.contains(e.target) || chip.contains(e.target)) return;
    pop.classList.remove('show');
    document.removeEventListener('mousedown', offClick);
    document.removeEventListener('keydown', offEsc);
  };
  const offEsc = (e) => {
    if (e.key !== 'Escape') return;
    pop.classList.remove('show');
    document.removeEventListener('mousedown', offClick);
    document.removeEventListener('keydown', offEsc);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', offClick);
    document.addEventListener('keydown', offEsc);
  }, 0);
};

window.checkoutGitBranch = async function (branchName) {
  if (!branchName) return;
  const pop = document.getElementById('git-branch-pop');
  if (pop) pop.classList.remove('show');
  if (!codeWorkspace) return;
  // Permission gate via existing requestPermission path.
  const ok = typeof requestPermission === 'function'
    ? await requestPermission({
        eyebrow: 'GIT CHECKOUT',
        title: `Switch to branch "${branchName}"?`,
        description: 'Runs `git checkout <branch>` in the workspace. Uncommitted changes may be lost — Horizon does not stash automatically.',
        detail: `git checkout ${branchName}`,
      })
    : confirm(`Run git checkout ${branchName}?`);
  if (!ok) return;
  try {
    const safe = String(branchName).replace(/[^A-Za-z0-9_./\-]/g, '');
    const r = await H.wsShell?.(`git checkout ${safe}`);
    if (r && r.ok) {
      if (typeof opLog === 'function') opLog(`git checkout ${safe}`, 'tool');
      if (typeof codeSetStatus === 'function') codeSetStatus(`Switched to branch "${safe}".`);
      refreshGitBranchChip();
    } else {
      const msg = (r?.err || r?.error || 'unknown').slice(0, 200);
      if (typeof codeSetStatus === 'function') codeSetStatus(`git checkout failed: ${msg}`, true);
    }
  } catch (e) {
    if (typeof codeSetStatus === 'function') codeSetStatus(`git checkout threw: ${e?.message || e}`, true);
  }
};



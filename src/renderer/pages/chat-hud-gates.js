// PR-V Phase 3.19 — Agent HUD + Plan-Act gate + Provider Health.
// Extracted from chat.html inline <script> (was lines 2134-2267).
//
// Three small features tightly coupled by listening on the same
// agent-step stream and rendering into composer-foot widgets:
//
//   1. Agent activity HUD (PR-U-MEGA): tri-state chip in composer
//      footer (ready/running/done|error) that auto-fades back to
//      ready 3s after completion.
//
//   2. Plan-Act gate (PR-Plan-Act): pauses agent runs before first
//      tool execution so user can review and approve/reject the plan.
//      Renders a CTA above messages via #step-rail-gate.
//
//   3. Provider Health traffic-light (PR-U-MEGA): tiny dot on the
//      Model chip — green = OK, amber = slow, red = auth/rate-limit
//      fail. Wraps H.ai with a timing/error observer.
//
// State:  _agentHudTimer, _planActActiveRunId
// Fns:    setAgentHud, planActShowGate, planActHideGate,
//         _planActApplyToggleVisuals, togglePlanActGate (if any),
//         setProviderHealth
// Boot:   IIFE wraps H.ai with provider-health observer at file load.

// PR-U-MEGA — agent activity HUD wired to the existing onAgentStep
// stream. Three states: ready / running / done|error. Auto-fades back
// to ready 3s after completion so the chip doesn't permanently glow.
var _agentHudTimer = null;
function setAgentHud(state, text) {
  const el = document.getElementById('composer-foot-agent');
  const txt = document.getElementById('composer-foot-agent-text');
  if (!el || !txt) return;
  el.classList.remove('running', 'done', 'error');
  if (state) el.classList.add(state);
  if (text) txt.textContent = text;
  if (_agentHudTimer) { clearTimeout(_agentHudTimer); _agentHudTimer = null; }
  if (state === 'done' || state === 'error') {
    _agentHudTimer = setTimeout(() => setAgentHud('', 'ready'), 3000);
  }
}
window.addEventListener('DOMContentLoaded', () => {
  if (typeof H?.onAgentStep === 'function') {
    H.onAgentStep((step) => {
      try {
        if (!step) return;
        if (step.type === 'run-start') {
          setAgentHud('running', 'starting…');
        } else if (step.type === 'thinking' || step.type === 'plan') {
          setAgentHud('running', 'thinking…');
        } else if (step.type === 'executing') {
          setAgentHud('running', String(step.tool || 'tool').slice(0, 24));
        } else if (step.type === 'result') {
          // Keep running label until run-end fires.
        } else if (step.type === 'run-end') {
          const ok = step.status === 'done' || step.result?.ok;
          setAgentHud(ok ? 'done' : 'error', ok ? 'done' : (step.result?.error || 'error').toString().slice(0, 24));
          // Plan-Act: hide gate on run end (covers stopped runs).
          planActHideGate();
        } else if (step.type === 'plan-pending') {
          // PR-Plan-Act — first executing step intercepted by main.
          // Show the Approve/Reject gate above the messages.
          setAgentHud('running', 'awaiting approval…');
          planActShowGate(step);
        } else if (step.type === 'plan-decision') {
          // User clicked → main echoed the decision back to us.
          planActHideGate();
        } else if (step.type === 'plan-rejected') {
          planActHideGate();
          setAgentHud('error', 'plan rejected');
        }
      } catch (_) {}
    });
  }
});

// PR-Plan-Act — gate UI controllers + persisted toggle.
//
// Sprint-2.9: keyboard support (Enter=approve, Esc=reject), auto-focus
// the Approve button when the gate appears, plus a tool-aware detail
// line ("First tool: <code>") that always renders even when `reason`
// is absent. Detail line is kept in sync with the markup contract:
//
// Sprint-2.9.1: dynamic positioning. The previous static top:60px
// assumed only the 52px title bar + 8px gap above the gate; when the
// wake-bar is open (+28px) or the step-rail is showing (+24px), the
// gate would overlap them. Now position is computed from actual
// element rects at show time. Width also accounts for the chatside
// (left, 280px when open) and the inspector-pane (right, ~360px when
// open) so the gate lives in the visible chat surface, not the full
// viewport.
//
//   <span id="plan-act-gate-detail">
//     First tool: <code id="plan-act-gate-tool">tool</code>
//   </span>
//
// Replacing detail.textContent would obliterate the <code> child, so
// we instead replace only the trailing tool name and (optionally)
// surface step.reason on a second line.
var _planActActiveRunId = null;
var _planActKeyHandler = null;
var _planActResizeHandler = null;

// Compute live top/left/width for the gate based on what's currently
// visible: title bar (.tb), wake bar (.wake-bar.show), step rail
// (.step-rail.show), chat sidebar (.chatside / body.with-sidebar) and
// inspector pane (body.inspector-active). The audit found the gate
// "floating" because all of these had hard-coded assumptions baked in.
function _planActPositionGate(gate) {
  if (!gate) return;
  // Vertical anchor — bottom of the bottom-most top-of-screen element.
  let top = 0;
  const tb = document.querySelector('.tb');
  if (tb) top = Math.max(top, tb.getBoundingClientRect().bottom);
  const wakeBar = document.querySelector('.wake-bar.show');
  if (wakeBar) top = Math.max(top, wakeBar.getBoundingClientRect().bottom);
  // Sprint-2.9.3 — defensive: even though we hide step-rail in
  // planActShowGate via .plan-act-suppressed, there's a race between
  // the 'plan' event (which shows the rail) and the 'plan-pending'
  // event (which suppresses it). On the very first frame the rail can
  // still be visible behind the gate. So if its rect bottom is below
  // our current top, push the gate further down to clear it.
  const rail = document.querySelector('.step-rail.show:not(.plan-act-suppressed)');
  if (rail) {
    const r = rail.getBoundingClientRect();
    if (r.height > 0) top = Math.max(top, r.bottom);
  }
  // Add an 8px gap below the bottom-most fixed element.
  top = Math.max(60, Math.round(top + 8));
  gate.style.top = top + 'px';

  // Horizontal — span the visible chat surface, not the full viewport.
  const sidebarOpen = document.body.classList.contains('with-sidebar') &&
                      !document.body.classList.contains('chat-sidebar-collapsed');
  const inspectorOpen = document.body.classList.contains('inspector-active');
  const sidebar = sidebarOpen ? (document.getElementById('chatside')?.offsetWidth || 280) : 0;
  const inspector = inspectorOpen ? (document.getElementById('inspector-pane')?.offsetWidth || 360) : 0;
  // Available width for centring; subtract 32px breathing room (16 each side).
  const avail = window.innerWidth - sidebar - inspector - 32;
  const w = Math.max(320, Math.min(720, avail));
  gate.style.width = w + 'px';
  // Center of available region — left edge of the available band + half its width.
  const centerOfAvail = sidebar + (window.innerWidth - sidebar - inspector) / 2;
  gate.style.left = centerOfAvail + 'px';
  // The CSS still applies translateX(-50%) so the gate is centred on `left`.
}

function planActShowGate(step) {
  const gate = document.getElementById('step-rail-gate');
  if (!gate) return;
  _planActActiveRunId = step?.runId || null;
  // Sprint-2.9.1/.3 — hide the step-rail while the gate is up so they
  // don't compete for the same vertical strip. Two mechanisms:
  //   1. Class on the rail itself (.plan-act-suppressed).
  //   2. Class on <body> (body.plan-act-active) — CSS uses this to
  //      catch any future re-render of step-rail that might clobber
  //      class (1). Belt + suspenders.
  document.body.classList.add('plan-act-active');
  const rail = document.getElementById('step-rail');
  if (rail) rail.classList.add('plan-act-suppressed');
  _planActPositionGate(gate);
  if (_planActResizeHandler) window.removeEventListener('resize', _planActResizeHandler);
  _planActResizeHandler = () => _planActPositionGate(gate);
  window.addEventListener('resize', _planActResizeHandler);
  const toolEl = document.getElementById('plan-act-gate-tool');
  if (toolEl) toolEl.textContent = String(step?.firstTool || 'unknown');
  // If we have a richer reason, append it after the inline <code>.
  const detail = document.getElementById('plan-act-gate-detail');
  if (detail) {
    // Strip any prior reason suffix (text node we appended last time).
    while (detail.lastChild && detail.lastChild.nodeType === 3 && detail.lastChild !== detail.childNodes[0]) {
      // keep the leading "First tool: " text node, but drop any tail we added.
      const txt = detail.lastChild.textContent || '';
      if (txt.startsWith(' · ')) detail.removeChild(detail.lastChild);
      else break;
    }
    if (step?.reason) {
      const suffix = document.createTextNode(' · ' + String(step.reason).slice(0, 100));
      detail.appendChild(suffix);
    }
  }
  gate.classList.add('show');
  // Auto-focus Approve for keyboard discoverability after the slide-in
  // animation settles (220ms). The setTimeout dodges Electron eating the
  // focus during the same task as the .show class addition.
  setTimeout(() => {
    const approveBtn = gate.querySelector('.srg-btn-approve');
    try { approveBtn?.focus({ preventScroll: true }); } catch (_) { try { approveBtn?.focus(); } catch (__) {} }
  }, 240);
  // Bind Esc/Enter globally while the gate is visible.
  if (_planActKeyHandler) document.removeEventListener('keydown', _planActKeyHandler, true);
  _planActKeyHandler = (ev) => {
    if (!document.getElementById('step-rail-gate')?.classList.contains('show')) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      window.planActReject?.();
    } else if (ev.key === 'Enter' && !ev.shiftKey) {
      // Only treat Enter as approve when the composer doesn't have focus.
      const active = document.activeElement;
      const inComposer = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable);
      if (!inComposer) {
        ev.preventDefault();
        ev.stopPropagation();
        window.planActApprove?.();
      }
    }
  };
  document.addEventListener('keydown', _planActKeyHandler, true);
}
function planActHideGate() {
  document.getElementById('step-rail-gate')?.classList.remove('show');
  _planActActiveRunId = null;
  // Sprint-2.9.1/.3 — unsuppress the step-rail (which was hidden in show).
  document.body.classList.remove('plan-act-active');
  const rail = document.getElementById('step-rail');
  if (rail) rail.classList.remove('plan-act-suppressed');
  if (_planActKeyHandler) {
    document.removeEventListener('keydown', _planActKeyHandler, true);
    _planActKeyHandler = null;
  }
  if (_planActResizeHandler) {
    window.removeEventListener('resize', _planActResizeHandler);
    _planActResizeHandler = null;
  }
}
window.planActShowGate = planActShowGate;
window.planActHideGate = planActHideGate;
window.planActApprove = async function () {
  if (!_planActActiveRunId) { planActHideGate(); return; }
  try { await H.agentControl?.(_planActActiveRunId, 'approve-plan'); } catch (_) {}
  planActHideGate();
};
window.planActReject = async function () {
  if (!_planActActiveRunId) { planActHideGate(); return; }
  try { await H.agentControl?.(_planActActiveRunId, 'reject-plan'); } catch (_) {}
  planActHideGate();
};

// Toggle pill in composer-foot — persisted via H.set('planActGate').
window.togglePlanActGate = async function () {
  let cur = false;
  try { cur = await H.get?.('planActGate'); } catch (_) {}
  const next = !cur;
  try { await H.set?.('planActGate', next); } catch (_) {}
  _planActApplyToggleVisuals(next);
};
function _planActApplyToggleVisuals(on) {
  const btn = document.getElementById('plan-act-toggle');
  if (!btn) return;
  btn.classList.toggle('on', !!on);
  const lbl = document.getElementById('plan-act-toggle-label');
  if (lbl) lbl.textContent = on ? 'Plan-Act ON' : 'Plan-Act';
}
(async function _bootPlanActToggle() {
  try {
    const cur = await H.get?.('planActGate');
    _planActApplyToggleVisuals(!!cur);
  } catch (_) { _planActApplyToggleVisuals(false); }
})();

// PR-U-MEGA — provider-health traffic-light on the Model chip.
// setProviderHealth('ok' | 'slow' | 'fail'). Drives the .ph-* CSS
// modifier classes on .composer-chip.strong. Wired to the AI send
// path: latency < 3s → ok, 3-10s → slow, error → fail.
function setProviderHealth(state) {
  const chip = document.getElementById('composer-model-chip')?.closest('.composer-chip');
  if (!chip) return;
  chip.classList.remove('ph-ok', 'ph-slow', 'ph-fail');
  if (state) chip.classList.add('ph-' + state);
}
// Wrap H.ai once to intercept timing and set the dot. Idempotent —
// only wraps if not already wrapped.
(function _wrapAiForHealth() {
  if (!window.H || !H.ai || H.__aiWrapped) return;
  const orig = H.ai.bind(H);
  H.ai = async function (...args) {
    const t0 = performance.now();
    try {
      const r = await orig(...args);
      const dt = performance.now() - t0;
      if (r && r.error) setProviderHealth('fail');
      else if (dt > 10000) setProviderHealth('slow');
      else if (dt > 3000) setProviderHealth('slow');
      else setProviderHealth('ok');
      return r;
    } catch (e) {
      setProviderHealth('fail');
      throw e;
    }
  };
  H.__aiWrapped = true;
})();



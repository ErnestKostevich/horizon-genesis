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
var _planActActiveRunId = null;
function planActShowGate(step) {
  const gate = document.getElementById('step-rail-gate');
  if (!gate) return;
  _planActActiveRunId = step?.runId || null;
  const tool = document.getElementById('plan-act-gate-tool');
  if (tool) tool.textContent = String(step?.firstTool || 'unknown');
  const detail = document.getElementById('plan-act-gate-detail');
  if (detail && step?.reason) {
    detail.textContent = String(step.reason).slice(0, 140);
  }
  gate.classList.add('show');
}
function planActHideGate() {
  document.getElementById('step-rail-gate')?.classList.remove('show');
  _planActActiveRunId = null;
}
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



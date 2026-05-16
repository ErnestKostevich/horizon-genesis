// PR-V Phase 3.22 — Token tracking + cost estimation.
// Extracted from chat.html inline <script> (was lines 1371-1408).
//
// trackTokens(text, role, provider, usage, estimatedTokens) — main
// entry called after every AI request. Reads provider-reported usage
// if available, falls back to a character/word estimate otherwise.
// Bumps sessionTokens + sessionMsgs counters and calls
// updateTokenDisplay to refresh the chat-status-bar pill.
//
// estimateTokensForText(text) — char/word heuristic for providers
// that don'''t return usage.
// updateTokenDisplay() — write counters into #stat-msgs, #stat-tokens,
// #stat-usage, #csb-tokens.

// trackTokens(text, role, provider [, usage])
// `usage` is the normalised {prompt, completion, total} object that the
// main-process H.ai handler now returns next to `reply`. When a provider does
// not return usage (many local/OpenAI-compatible servers do this), Horizon
// keeps an honest estimate instead of showing "usage unavailable" forever.
function estimateTokensForText(text) {
  const raw = String(text || '').trim();
  if (!raw) return 0;
  const words = raw.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(raw.length / 4), Math.ceil(words * 1.3));
}
function trackTokens(text, role, provider, usage, estimatedTokens) {
  let pTok = 0, cTok = 0;
  if (usage && (usage.total != null || usage.prompt != null || usage.completion != null)) {
    pTok = usage.prompt || 0;
    cTok = usage.completion || 0;
    if (usage.total != null && !pTok && !cTok) cTok = Number(usage.total) || 0;
    sessionUsageKnown = true;
  } else {
    cTok = Number(estimatedTokens || estimateTokensForText(text)) || 0;
    sessionHasEstimatedUsage = true;
  }
  const tokens = pTok + cTok;
  sessionTokens += tokens;
  if (role === 'user') sessionMsgs++;
  updateTokenDisplay();
  return tokens;
}
function updateTokenDisplay() {
  const fmt = n => n >= 1000 ? (n/1000).toFixed(1)+'k' : String(n);
  try {
    document.getElementById('stat-msgs').textContent = sessionMsgs;
    document.getElementById('stat-tokens').textContent = (sessionHasEstimatedUsage ? '~' : '') + fmt(sessionTokens);
    document.getElementById('stat-usage').textContent = sessionUsageKnown
      ? (sessionHasEstimatedUsage ? 'mixed usage' : 'provider usage')
      : 'estimated';
    document.getElementById('csb-tokens').textContent = `${sessionHasEstimatedUsage ? '~' : ''}${fmt(sessionTokens)} tokens`;
  } catch(_) {}
}


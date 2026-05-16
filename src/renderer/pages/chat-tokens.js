// Token tracking for the chat UI.
//
// Important product rule: Horizon must not invent token totals or dollar
// amounts. We count provider-reported usage only; when a provider does not
// return usage, the UI says "usage unavailable".

function estimateTokensForText(text) {
  const raw = String(text || '').trim();
  if (!raw) return 0;
  const words = raw.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(raw.length / 4), Math.ceil(words * 1.3));
}

function trackTokens(text, role, provider, usage, estimatedTokens) {
  let pTok = 0, cTok = 0;
  if (usage && (usage.total != null || usage.prompt != null || usage.completion != null)) {
    pTok = Number(usage.prompt || 0);
    cTok = Number(usage.completion || 0);
    if (usage.total != null && !pTok && !cTok) cTok = Number(usage.total) || 0;
    sessionUsageKnown = true;
  } else {
    if (role === 'user') sessionMsgs++;
    sessionUsageUnavailable = true;
    updateTokenDisplay();
    return 0;
  }
  const tokens = pTok + cTok;
  sessionTokens += tokens;
  if (role === 'user') sessionMsgs++;
  updateTokenDisplay();
  return tokens;
}

function updateTokenDisplay() {
  const fmt = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  const hasUsage = sessionUsageKnown && sessionTokens > 0;
  const tokenText = hasUsage ? fmt(sessionTokens) : 'usage unavailable';
  const usageText = hasUsage
    ? (sessionUsageUnavailable ? 'partial provider usage' : 'provider usage')
    : 'usage unavailable';
  try {
    const msgs = document.getElementById('stat-msgs');
    if (msgs) msgs.textContent = sessionMsgs;
    const statTokens = document.getElementById('stat-tokens');
    if (statTokens) statTokens.textContent = hasUsage ? fmt(sessionTokens) : '0';
    const statUsage = document.getElementById('stat-usage');
    if (statUsage) statUsage.textContent = usageText;
    const csb = document.getElementById('csb-tokens');
    if (csb) csb.textContent = hasUsage ? `${fmt(sessionTokens)} tokens` : 'usage unavailable';
    const footTok = document.getElementById('composer-foot-tokens-n');
    if (footTok) footTok.textContent = tokenText;
    const footCost = document.getElementById('composer-foot-cost');
    if (footCost) footCost.textContent = hasUsage ? 'provider usage' : 'usage unavailable';
  } catch (_) {}
}

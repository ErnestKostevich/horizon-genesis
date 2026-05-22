// PR-V Phase 3.25 — Model Picker + Provider settings shortcut.
// Extracted from chat.html inline <script> (was lines 2009-2182).
//
// The composer Model chip + ⌘M shortcut both open this picker. Lists
// every model from MODEL_PICKER_REGISTRY (and local-server-fetched
// dynamic lists for ollama/lmstudio/openrouter) grouped by provider
// with search + click-to-switch.
//
// State: MODEL_PICKER_PROVIDERS — display order for the popover
// Fns:
//   openProviderSettings — legacy shortcut to Settings → Providers
//   providerPickerLabel — provider id → display name
//   openModelPicker(ev) — build + show the popover
//   pickModel(p, m) — apply selection for cloud providers
//   pickAnyModel(p, m) — route to local or cloud handler
//   pickLocalModel(p, m) — apply selection for ollama/lmstudio/localai
//   closeModelPicker — hide popover
//   filterModelPicker(q) — search filter
//
// Also registers two global listeners at file load:
//   - outside-click closes popover
//   - Escape closes both model + persona popovers

// ═══ PROVIDER / MODEL CLICK-SWITCH (P1) ═══
function openProviderSettings(){
  // Legacy entry point — still used by a few buttons. Tabbed Settings means
  // we just jump straight to the Providers tab.
  openPanel('providers');
}

// ═══ MODEL VARIANT POPOVER ═══
// Click on the model pill in the chat header → small floating popover with
// the current provider's model dropdown. No need to open Settings for a
// simple variant switch. Mirrors the ChatGPT / Claude pattern.
var MODEL_PICKER_PROVIDERS = [
  'gemini', 'claude', 'openai', 'openrouter',
  'groq', 'deepseek', 'mistral', 'qwen',
  'perplexity', 'cohere', 'grok',
  'ollama', 'lmstudio', 'localai'
];

function providerPickerLabel(p) {
  return ({
    gemini: 'Gemini',
    claude: 'Claude',
    openai: 'OpenAI',
    openrouter: 'OpenRouter',
    groq: 'Groq',
    deepseek: 'DeepSeek',
    mistral: 'Mistral',
    qwen: 'Qwen',
    perplexity: 'Perplexity',
    cohere: 'Cohere',
    grok: 'Grok',
    ollama: 'Ollama',
    lmstudio: 'LM Studio',
    localai: 'LocalAI'
  })[p] || String(p || '').toUpperCase();
}

function positionPicker(pop, anchor) {
  if (!pop) return;
  const fallback = document.getElementById('inp') || document.body;
  const target = anchor || fallback;
  const r = target.getBoundingClientRect();

  // Earlier this set { left:16px, top:16px } first and repositioned via
  // requestAnimationFrame. On Electron 28 the rAF could be coalesced so
  // the popover stuck at the top-left corner where the user wasn't
  // looking — looked like the picker "doesn't open". Fix: pre-position
  // BEFORE adding .show, using a sane initial estimate (centred above
  // the anchor for composer chips), then refine in rAF once the popover
  // has measured its actual size. Width-estimate 380 ≈ min-width of
  // .mode-popover / .persona-popover (340 + 8 padding either side).
  const initW = 380;
  const initH = Math.min(420, window.innerHeight - 80);
  const margin = 14;
  const fitLeft = Math.min(Math.max(margin, r.left), Math.max(margin, window.innerWidth - initW - margin));
  const preferAboveInit = r.top > initH + 24;
  const fitTop = preferAboveInit
    ? Math.max(margin, r.top - initH - 10)
    : Math.min(window.innerHeight - initH - margin, r.bottom + 10);
  pop.style.left = `${fitLeft}px`;
  pop.style.top = `${fitTop}px`;
  pop.classList.add('show');

  // Refine in next frame with the popover's REAL rendered size.
  requestAnimationFrame(() => {
    if (!pop.classList.contains('show')) return; // closed in the meantime
    const pr = pop.getBoundingClientRect();
    const preferAbove = r.top > pr.height + 24;
    const left = Math.min(Math.max(margin, r.left), Math.max(margin, window.innerWidth - pr.width - margin));
    const topCandidate = preferAbove ? (r.top - pr.height - 10) : (r.bottom + 10);
    const top = Math.min(Math.max(margin, topCandidate), Math.max(margin, window.innerHeight - pr.height - margin));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  });
}

async function openModelPicker(ev){
  try { ev?.stopPropagation(); } catch(_) {}
  closePersonaPicker();
  const pop = document.getElementById('model-popover');
  if (!pop) return;
  if (String(mode || '').toLowerCase() === 'image') {
    return openImageModelPicker(ev, pop);
  }
  const activeProv = (typeof prov !== 'undefined' ? prov : null) || 'gemini';
  const sections = MODEL_PICKER_PROVIDERS.map(p => {
    const choices = modelChoicesForProvider(p);
    if (!choices.length) return '';
    const selected = getSelectedModelForProvider(p) || '';
    const providerOn = p === activeProv;
    const local = p === 'ollama' || p === 'lmstudio' || p === 'localai';
    const rows = choices.map(item => {
      const escProv = p.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const escVal = item.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const on = providerOn && item.value === selected;
      const meta = on ? 'active' : (local ? 'local' : providerPickerLabel(p));
      return `
        <button class="model-popover-opt${on ? ' on' : ''}" data-model-row data-provider="${_escHtml(p)}" data-label="${_escHtml((item.label || item.value) + ' ' + p)}" onclick="pickAnyModel('${escProv}','${escVal}')" title="${_escHtml(item.value)}">
          <span class="model-popover-opt-name">${_escHtml(item.label || item.value)}</span>
          <span class="model-popover-opt-meta">${_escHtml(meta)}</span>
        </button>`;
    }).join('');
    return `
      <section class="model-provider-section" data-provider-section data-label="${_escHtml(providerPickerLabel(p) + ' ' + p)}">
        <div class="model-provider-title"><b>${_escHtml(providerPickerLabel(p))}</b><span>${choices.length} models</span></div>
        <div class="model-provider-models">${rows}</div>
      </section>`;
  }).filter(Boolean).join('');

  pop.innerHTML = `
    <div class="picker-head">
      <div>
        <div class="picker-title">Choose Model</div>
        <div class="picker-sub">One switcher for every connected provider. Prices are not guessed here.</div>
      </div>
      <input class="picker-search" id="model-picker-search" placeholder="Search models..." oninput="filterModelPicker(this.value)" />
    </div>
    <div class="picker-body">${sections || '<div class="model-popover-empty">No model lists are loaded yet. Open Settings → Models and refresh local providers.</div>'}</div>
  `;
  positionPicker(pop, ev?.currentTarget || document.getElementById('composer-model-chip'));
  setTimeout(() => document.getElementById('model-picker-search')?.focus(), 30);
}

function fallbackImageModels() {
  return {
    openai: [
      { id: 'gpt-image-2',      label: 'GPT Image 2' },
      { id: 'gpt-image-1.5',    label: 'GPT Image 1.5' },
      { id: 'gpt-image-1',      label: 'GPT Image 1' },
      { id: 'gpt-image-1-mini', label: 'GPT Image 1 mini' },
    ],
    gemini: [
      { id: 'gemini-2.5-flash-image',         label: 'Gemini 2.5 Flash Image (Nano Banana)' },
      { id: 'gemini-3.1-flash-image-preview', label: 'Gemini 3.1 Flash Image Preview (Nano Banana 2)' },
      { id: 'gemini-3-pro-image-preview',     label: 'Gemini 3 Pro Image Preview (Nano Banana Pro)' },
      { id: 'imagen-4.0-generate-001',         label: 'Imagen 4' },
      { id: 'imagen-4.0-ultra-generate-001',   label: 'Imagen 4 Ultra' },
      { id: 'imagen-4.0-fast-generate-001',    label: 'Imagen 4 Fast' },
    ],
  };
}

async function getImageModelRegistry() {
  try {
    const r = await H.aiImageModels?.();
    if (r?.ok && r.models && typeof r.models === 'object') return r.models;
  } catch (_) {}
  return fallbackImageModels();
}

async function getSelectedImageProvider() {
  try {
    const configured = String(await H.get?.('image.provider') || 'auto').toLowerCase();
    if (configured === 'openai' || configured === 'gemini') return configured;
  } catch (_) {}
  const cur = String(prov || provider || '').toLowerCase();
  if (cur === 'openai' || cur === 'gemini') return cur;
  return 'openai';
}

async function getSelectedImageModel(provider) {
  const fallback = provider === 'gemini' ? 'gemini-2.5-flash-image' : 'gpt-image-2';
  const key = provider === 'gemini' ? 'image.model.gemini' : 'image.model.openai';
  try {
    return String(await H.get?.(key) || fallback).trim() || fallback;
  } catch (_) {
    return fallback;
  }
}

async function openImageModelPicker(ev, pop) {
  const registry = await getImageModelRegistry();
  const activeProvider = await getSelectedImageProvider();
  const selectedByProvider = {
    openai: await getSelectedImageModel('openai'),
    gemini: await getSelectedImageModel('gemini'),
  };
  const sections = ['openai', 'gemini'].map(p => {
    const choices = Array.isArray(registry[p]) ? registry[p] : [];
    if (!choices.length) return '';
    const rows = choices.map(item => {
      const id = String(item.id || item.value || '').trim();
      if (!id) return '';
      const label = item.label || id;
      const on = p === activeProvider && id === selectedByProvider[p];
      const escProv = p.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const escVal = id.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      return `
        <button class="model-popover-opt${on ? ' on' : ''}" data-model-row data-provider="${_escHtml(p)}" data-label="${_escHtml(label + ' ' + id + ' ' + p)}" onclick="pickImageModel('${escProv}','${escVal}')" title="${_escHtml(id)}">
          <span class="model-popover-opt-name">${_escHtml(label)}</span>
          <span class="model-popover-opt-meta">${on ? 'active image' : providerPickerLabel(p)}</span>
        </button>`;
    }).join('');
    return `
      <section class="model-provider-section" data-provider-section data-label="${_escHtml(providerPickerLabel(p) + ' image ' + p)}">
        <div class="model-provider-title"><b>${_escHtml(providerPickerLabel(p))} Image</b><span>${choices.length} models</span></div>
        <div class="model-provider-models">${rows}</div>
      </section>`;
  }).filter(Boolean).join('');

  pop.innerHTML = `
    <div class="picker-head">
      <div>
        <div class="picker-title">Choose Image Model</div>
        <div class="picker-sub">Image mode uses BYOK image models only. Chat model selection stays untouched.</div>
      </div>
      <input class="picker-search" id="model-picker-search" placeholder="Search image models..." oninput="filterModelPicker(this.value)" />
    </div>
    <div class="picker-body">${sections || '<div class="model-popover-empty">No image models are available.</div>'}</div>
  `;
  positionPicker(pop, ev?.currentTarget || document.getElementById('composer-model-chip'));
  setTimeout(() => document.getElementById('model-picker-search')?.focus(), 30);
}

async function pickImageModel(provider, model) {
  provider = String(provider || '').toLowerCase();
  if (provider !== 'openai' && provider !== 'gemini') return;
  const key = provider === 'gemini' ? 'image.model.gemini' : 'image.model.openai';
  try { await H.set?.('image.provider', provider); } catch (_) {}
  try { await H.set?.(key, model); } catch (_) {}
  const chip = document.getElementById('composer-model-chip');
  if (chip) chip.textContent = model;
  try { refreshImageComposerChip?.(); } catch (_) {}
  try { H.notify?.('Image model selected', `${provider}: ${model}`); } catch(_) {}
  closeModelPicker();
}

async function pickModel(provider, model){
  try { await saveModelSetting(provider, model); } catch(_) {}
  // PR-TECHDEBT — csb-model removed in PR-U-MEGA; saveModelSetting +
  // updateShellChrome already update the surviving surfaces. Keep a
  // null-guarded write for any future reincarnation of the element.
  const cm = document.getElementById('csb-model');
  if (cm) cm.textContent = model;
  try { H.notify?.('Model selected', `${provider}: ${model}`); } catch(_) {}
  closeModelPicker();
}

async function pickAnyModel(provider, model) {
  try { setProv(provider); } catch (_) {}
  const isLocalProvider = provider === 'ollama' || provider === 'lmstudio' || provider === 'localai';
  if (isLocalProvider) return pickLocalModel(provider, model);
  return pickModel(provider, model);
}

async function pickLocalModel(provider, model){
  try {
    const sel = document.getElementById('pi-' + provider + '-model');
    if (sel) sel.value = model;
    await saveLocalProvider(provider);
    const cm = document.getElementById('csb-model');
    if (cm) cm.textContent = model;
    // PR-LAYOUT-V2 — same root cause as saveModelSetting; the composer
    // Model chip wasn't refreshing after selecting a local model.
    try { updateShellChrome(); } catch(_) {}
    try { H.notify?.('Model selected', `${provider}: ${model}`); } catch(_) {}
  } catch(_) {}
  closeModelPicker();
}

function closeModelPicker(){
  document.getElementById('model-popover')?.classList.remove('show');
}

function filterModelPicker(q) {
  const query = String(q || '').trim().toLowerCase();
  const pop = document.getElementById('model-popover');
  if (!pop) return;
  pop.querySelectorAll('[data-model-row]').forEach(row => {
    const hit = !query || String(row.dataset.label || '').toLowerCase().includes(query);
    row.style.display = hit ? '' : 'none';
  });
  pop.querySelectorAll('[data-provider-section]').forEach(section => {
    const hasVisible = [...section.querySelectorAll('[data-model-row]')].some(row => row.style.display !== 'none');
    const sectionHit = !query || String(section.dataset.label || '').toLowerCase().includes(query);
    section.style.display = (hasVisible || sectionHit) ? '' : 'none';
  });
}

// Outside-click closes the popover. Escape too.
// PR-TECHDEBT — #csb-model was retired in PR-U-MEGA; the picker
// anchor is now the composer-toolbar Model chip. Allow clicks on
// either the (legacy) csb-model OR the new #composer-model-chip
// without closing the popover.
document.addEventListener('click', (e) => {
  const pop = document.getElementById('model-popover');
  if (!pop?.classList.contains('show')) return;
  if (e.target.closest('#model-popover')) return;
  if (e.target.closest('#csb-model')) return;
  if (e.target.closest('#composer-model-chip')) return;
  if (e.target.closest('.composer-chip.strong')) return;
  closeModelPicker();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModelPicker();
    closePersonaPicker();
  }
});

// Sprint 2.8 — sandbox-proof inline onclick exposure.
if (typeof window !== 'undefined') {
  ['openModelPicker'].forEach(function (n) {
    try {
      var fn = eval('typeof ' + n + " === 'function' ? " + n + ' : null');
      if (fn) window[n] = fn;
    } catch (_) {}
  });
}

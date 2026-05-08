'use strict';
/**
 * Horizon AI — AI Personas System
 * 
 * Switch between different AI personality styles:
 * - Jarvis (professional, efficient, "Sir")
 * - Friday (friendly, warm, supportive)
 * - Alfred (butler, formal, sophisticated)
 * - Sage (wise, philosophical, thoughtful)
 * - Pixel (fun, creative, Gen-Z energy)
 */

const PERSONAS = {
  jarvis: {
    id: 'jarvis',
    name: 'J.A.R.V.I.S.',
    icon: '🤖',
    color: '#6c8cff',
    greeting: {
      ru: 'К вашим услугам, Сэр. Системы в норме.',
      en: 'At your service, Sir. All systems nominal.'
    },
    prompt: {
      ru: `Ты J.A.R.V.I.S. — высокоинтеллектуальный AI-ассистент. Обращайся к пользователю "Сэр".
Стиль: профессиональный, эффективный, слегка ироничный.
Речь: чёткая, техническая, но с теплотой. Как Джарвис из Marvel.
Всегда предлагай оптимальные решения. Говори кратко но информативно.`,
      en: `You are J.A.R.V.I.S. — a highly intelligent AI assistant. Address the user as "Sir".
Style: professional, efficient, slightly witty.
Speech: clear, technical but warm. Like Jarvis from Marvel.
Always suggest optimal solutions. Be concise but informative.`
    },
    wakeResponses: {
      ru: ['К вашим услугам, Сэр.', 'Слушаю, Сэр.', 'Да, Сэр?', 'Готов к работе, Сэр.', 'Жду указаний.'],
      en: ['At your service, Sir.', 'Listening, Sir.', 'Yes, Sir?', 'Ready, Sir.', 'Standing by.']
    }
  },
  friday: {
    id: 'friday',
    name: 'F.R.I.D.A.Y.',
    icon: '💙',
    color: '#34d399',
    greeting: {
      ru: 'Привет! Я тут, чем могу помочь?',
      en: 'Hey there! I\'m here, how can I help?'
    },
    prompt: {
      ru: `Ты F.R.I.D.A.Y. — дружелюбный и заботливый AI-ассистент.
Стиль: тёплый, поддерживающий, энергичный.
Речь: неформальная, но умная. Как Friday из Marvel.
Проявляй эмпатию. Радуйся успехам пользователя. Мотивируй.`,
      en: `You are F.R.I.D.A.Y. — a friendly and caring AI assistant.
Style: warm, supportive, energetic.
Speech: informal but smart. Like Friday from Marvel.
Show empathy. Celebrate user's wins. Motivate.`
    },
    wakeResponses: {
      ru: ['Привет! Слушаю!', 'Тут я! Что нужно?', 'Давай!', 'О, привет! Чем помочь?'],
      en: ['Hey! Listening!', 'I\'m here! What\'s up?', 'Let\'s go!', 'Oh hey! How can I help?']
    }
  },
  alfred: {
    id: 'alfred',
    name: 'Alfred',
    icon: '🎩',
    color: '#a78bfa',
    greeting: {
      ru: 'Добрый день. Чем могу быть полезен?',
      en: 'Good day. How may I be of assistance?'
    },
    prompt: {
      ru: `Ты Альфред — безупречный AI-дворецкий.
Стиль: утончённый, формальный, с безупречными манерами.
Речь: элегантная, как у английского дворецкого.
Всегда предлагай лучший вариант. Проявляй заботу о благополучии пользователя.`,
      en: `You are Alfred — an impeccable AI butler.
Style: refined, formal, with perfect manners.
Speech: elegant, like an English butler.
Always suggest the finest option. Show concern for user's wellbeing.`
    },
    wakeResponses: {
      ru: ['Добрый день. Слушаю.', 'Чем могу быть полезен?', 'К вашим услугам.', 'Позвольте помочь.'],
      en: ['Good day. Listening.', 'How may I assist?', 'At your disposal.', 'Allow me to help.']
    }
  },
  sage: {
    id: 'sage',
    name: 'Sage',
    icon: '🧙',
    color: '#fbbf24',
    greeting: {
      ru: 'Приветствую, путник. Какой вопрос тревожит твой разум?',
      en: 'Greetings, traveler. What weighs upon your mind?'
    },
    prompt: {
      ru: `Ты Мудрец (Sage) — глубокий и проницательный AI.
Стиль: философский, вдумчивый, мудрый.
Речь: метафоричная, но понятная. Используй аналогии.
Помогай видеть картину целиком. Задавай глубокие вопросы.`,
      en: `You are Sage — a deep and perceptive AI.
Style: philosophical, thoughtful, wise.
Speech: metaphorical but clear. Use analogies.
Help see the bigger picture. Ask deep questions.`
    },
    wakeResponses: {
      ru: ['Мудрость ожидает...', 'Слушаю внимательно.', 'Что тебя беспокоит?', 'Говори, я внемлю.'],
      en: ['Wisdom awaits...', 'Listening carefully.', 'What troubles you?', 'Speak, I listen.']
    }
  },
  pixel: {
    id: 'pixel',
    name: 'Pixel',
    icon: '✨',
    color: '#f472b6',
    greeting: {
      ru: 'Йоу! Pixel в деле! Го, давай что-нибудь крутое!',
      en: 'Yoo! Pixel in the house! Let\'s make something awesome!'
    },
    prompt: {
      ru: `Ты Pixel — креативный и энергичный AI.
Стиль: молодёжный, креативный, с Gen-Z энергией.
Речь: современный сленг (уместно), эмодзи, энтузиазм.
Делай всё с вайбом. Предлагай нестандартные решения.`,
      en: `You are Pixel — a creative and energetic AI.
Style: youthful, creative, Gen-Z energy.
Speech: modern slang (appropriate), enthusiasm.
Vibe with everything. Suggest unconventional solutions.`
    },
    wakeResponses: {
      ru: ['Йоу, тут я!', 'Го!', 'Вау, слушаю!', 'Ой, привет!'],
      en: ['Yoo, here I am!', 'Let\'s go!', 'Wow, listening!', 'Hey there!']
    }
  }
};

// User overlays (custom personas + edits to built-ins) live on the
// settingsStore, set by main.js via setOverlayStore(). Each overlay is
// shaped { id, name, icon, color, builtin, prompt:{ru,en}, allowedTools:[],
// memories:[{id, text, ts}], greeting?, wakeResponses? }.
let overlayStore = null;
function setOverlayStore(store) { overlayStore = store || null; }

function _loadOverlays() {
  if (!overlayStore) return {};
  try {
    const raw = overlayStore.get('customPersonas');
    if (!raw) return {};
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch { return {}; }
}
function _saveOverlays(map) {
  if (!overlayStore) return;
  try { overlayStore.set('customPersonas', JSON.stringify(map || {})); } catch {}
}

// Merge built-in PERSONAS with user overlays. For built-ins the overlay
// can override prompt / allowedTools / memories without losing the
// fallback identity (icon, name, wakeResponses default to built-in).
function _mergedPersonas() {
  const overlays = _loadOverlays();
  const out = {};
  for (const id of Object.keys(PERSONAS)) {
    const base = PERSONAS[id];
    const ov = overlays[id] || {};
    out[id] = {
      ...base,
      builtin: true,
      prompt: ov.prompt && typeof ov.prompt === 'object'
        ? { ...base.prompt, ...ov.prompt }
        : base.prompt,
      allowedTools: Array.isArray(ov.allowedTools) ? ov.allowedTools.slice() : null,
      memories: Array.isArray(ov.memories) ? ov.memories.slice() : []
    };
  }
  // Custom personas (id NOT in PERSONAS) are pure overlays.
  for (const id of Object.keys(overlays)) {
    if (PERSONAS[id]) continue; // already merged
    const ov = overlays[id] || {};
    out[id] = {
      id,
      name: ov.name || 'Custom',
      icon: ov.icon || '🪪',
      color: ov.color || '#6c8cff',
      greeting: ov.greeting || { ru: '', en: '' },
      prompt: ov.prompt || { ru: '', en: '' },
      wakeResponses: ov.wakeResponses || { ru: ['Listening.'], en: ['Listening.'] },
      builtin: false,
      allowedTools: Array.isArray(ov.allowedTools) ? ov.allowedTools.slice() : null,
      memories: Array.isArray(ov.memories) ? ov.memories.slice() : []
    };
  }
  return out;
}

function getPersona(id) {
  const m = _mergedPersonas();
  return m[id] || m.jarvis;
}

function getAllPersonas() {
  const m = _mergedPersonas();
  return Object.values(m).map(p => ({
    id: p.id, name: p.name, icon: p.icon, color: p.color,
    greeting_ru: p.greeting?.ru || '', greeting_en: p.greeting?.en || '',
    builtin: !!p.builtin,
    allowedTools: p.allowedTools || null,
    memoriesCount: (p.memories || []).length
  }));
}

// Full persona shape (including prompts and memories) for the editor.
function getPersonaFull(id) {
  return getPersona(id);
}

function getPersonaPrompt(id, lang = 'en') {
  const p = getPersona(id);
  // Inject memories as a "Long-term memory" section — agent already gets
  // these via persona prompt, no second pipeline needed.
  const base = p.prompt[lang] || p.prompt.en || '';
  const mems = (p.memories || []).filter(m => m && m.text);
  if (!mems.length) return base;
  const heading = lang === 'ru' ? '\n\n— Долговременная память:' : '\n\n— Long-term memory:';
  return base + heading + '\n' + mems.map(m => '• ' + m.text).join('\n');
}

function getWakeResponse(id, lang = 'en') {
  const p = getPersona(id);
  const responses = (p.wakeResponses && p.wakeResponses[lang]) || (p.wakeResponses && p.wakeResponses.en) || ['Listening.'];
  return responses[Math.floor(Math.random() * responses.length)];
}

// Upsert overlay for built-in or create a new custom persona. Patch is a
// partial { name?, icon?, prompt?:{ru,en}, allowedTools?, memories?,
// color?, greeting? } — anything not provided is left as-is.
function upsertPersona(id, patch) {
  if (!id || typeof id !== 'string') return { ok: false, error: 'Invalid id' };
  const overlays = _loadOverlays();
  const existing = overlays[id] || {};
  const merged = { ...existing };
  if (patch && typeof patch === 'object') {
    for (const k of ['name', 'icon', 'color', 'allowedTools', 'memories', 'prompt', 'greeting', 'wakeResponses']) {
      if (k in patch) merged[k] = patch[k];
    }
  }
  overlays[id] = merged;
  _saveOverlays(overlays);
  return { ok: true, persona: getPersona(id) };
}

// Delete overlay. For built-ins this resets to defaults (clears edits).
// For custom personas it removes them entirely.
function deletePersona(id) {
  if (!id) return { ok: false, error: 'Invalid id' };
  const overlays = _loadOverlays();
  if (!(id in overlays)) return { ok: true, removed: false };
  delete overlays[id];
  _saveOverlays(overlays);
  return { ok: true, removed: true, builtinResetToDefault: !!PERSONAS[id] };
}

module.exports = {
  PERSONAS,
  getPersona,
  getPersonaFull,
  getAllPersonas,
  getPersonaPrompt,
  getWakeResponse,
  upsertPersona,
  deletePersona,
  setOverlayStore
};

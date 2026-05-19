// PR-V Phase 3 — Wake Word Engine + Echo Detection + Hot Window.
// Extracted from chat.html inline <script> (was lines 1409-2006).
// Behaviour identical; loaded as external script AFTER main inline so
// window.* globals it reads (lang, wakeOn, prov, etc.) are defined.
//
// Originally Codex/PR-Y JARVIS-style wake activation. Owner had reported
// this entire feature as missing because legacy #tc-wake button lived
// in .sb (display:none). PR-LAYOUT-V3 restored the toggle as a composer
// chip; PR-V keeps the engine isolated so it can be tested/maintained
// without touching the rest of chat.html.
//
// IMPORTANT: all top-level var declarations stay as  so they bind
// to window (cross-script visible). If you change  to 
// here, anything referencing the var from chat.html will break.

// ═══ WAKE WORD ENGINE STATE ═══
var wakeActive=false;
var wakePhase='off';
var wakeStream=null;
var wakeRec=null;
var wakeChunks=[];
var wakeLoopTimer=null;
var wakeDebounce=false;
var wakeLastDebug=null;
var wakeLastFireAt=0;
var cmdRec=null;

// ═══ ECHO DETECTION — prevents wake word from triggering on Horizon's own voice ═══
var isSpeaking = false;  // true while TTS is playing
var speakEndTime = 0;    // timestamp when TTS finished
var ECHO_COOLDOWN = 1500; // ignore mic for 1.5s after TTS ends

var MIN_SUSTAINED_SPEECH_FRAMES = 3; // 300ms
function isSustainedSpeech(frames) { return frames >= MIN_SUSTAINED_SPEECH_FRAMES; }

function pauseWakeForTts(){
  if(!wakeActive) return;
  if(wakePhase==='command') return;
  try { if(wakeRec && wakeRec.state === 'recording') wakeRec.stop(); } catch(_){}
  clearTimeout(wakeLoopTimer);
  setWakeBar('paused');
}
function resumeWakeAfterTts(){
  if(!wakeActive) return;
  if(wakePhase==='command') return;
  const remaining = Math.max(0, ECHO_COOLDOWN - (Date.now() - speakEndTime));
  setTimeout(()=>{
    if(wakeActive && wakePhase!=='command') runWakeChunk();
  }, remaining + 50);
}

// ═══ AMBIENT MODE STATE ═══
var ambientOn = false;
var ambientInterval = null;
var AMBIENT_INTERVAL_MS = 45000; // check every 45 sec

// ═══ SMART NOTIFICATIONS STATE ═══  
var notificationsOn = false;
var dailyBriefingDone = false;
var notifCheckInterval = null;

// ═══════════════════════════════════════════════════════════════
// TRANSLATIONS
// ═══════════════════════════════════════════════════════════════
var TX={
  ru:{
    ready:'Готов',thinking:'Думаю…',searching:'Ищу…',recording:'Запись…',processing:'Обрабатываю…',
    opening:'Открываю',
    hello:'Привет! Я Хорайзон ◈',
    sub:'Персональный AI-агент для ПК.\nВключи Wake Mode и скажи «Горизонт», или напечатай запрос.',
    wakeIdle:'Слушаю «Горизонт» / «Хорайзон»…',
    wakeListening:'Записываю… (скажи «Горизонт»)',
    wakeTranscribing:'Распознаю…',
    wakeCommand:'Слушаю команду…',
    chips:['Что ты умеешь?','Открой YouTube','Открой папку Game на D','Что запущено?','Помоги с кодом','Переведи текст на английский','Напиши письмо','Планы на день'],
    newChat:'+ Новый чат',
    today:'Сегодня',
    yesterday:'Вчера',
    thisWeek:'На этой неделе',
    thisMonth:'В этом месяце',
    older:'Раньше',
    untitledChat:'Без названия',
    renameChat:'Переименовать',
    deleteChat:'Удалить',
    confirmDeleteChat:'Удалить этот чат? Это действие необратимо.',
    noChatsYet:'Чатов пока нет',
    chatRenamePrompt:'Новое название чата:'
  },
  en:{
    ready:'Ready',thinking:'Thinking…',searching:'Searching…',recording:'Recording…',processing:'Processing…',
    opening:'Opening',
    hello:"Hello! I'm Horizon ◈",
    sub:"Your personal desktop AI agent.\nEnable Wake Mode and say 'Horizon', or type a message.",
    wakeIdle:'Listening for "Horizon"…',
    wakeListening:'Recording… (say "Horizon")',
    wakeTranscribing:'Transcribing…',
    wakeCommand:'Listening for command…',
    chips:['What can you do?','Open YouTube','Open folder Documents','Take screenshot','Help me code','Translate to Russian','Write an email','Plan my day'],
    newChat:'+ New chat',
    today:'Today',
    yesterday:'Yesterday',
    thisWeek:'This week',
    thisMonth:'This month',
    older:'Older',
    untitledChat:'Untitled',
    renameChat:'Rename',
    deleteChat:'Delete',
    confirmDeleteChat:'Delete this chat? This cannot be undone.',
    noChatsYet:'No chats yet',
    chatRenamePrompt:'New chat title:'
  }
};
var t=k=>TX[lang]?.[k]||TX.en[k]||k;

// ═══════════════════════════════════════════════════════════════
// WAKE WORD — ULTRA-STRICT DETECTION
// Only triggers on exact "Horizon"/"Горизонт"/"Джарвис" words
// ═══════════════════════════════════════════════════════════════

// Wake words — matched as whole words anywhere in the transcription.
// Includes common Whisper mis-transcriptions of "Горизонт" / "Horizon".
var WAKE_EXACT = new Set([
  'горизонт','горизон','харизон','харизонт','хорайзон','хоризон','гаризонт','горизонте','горизонта',
  'horizon','horizan','horison','jarvis','джарвис','джарвиса',
  'hey horizon','эй горизонт','окей горизонт','окей хорайзон','слышь горизонт','hello horizon','ok horizon'
]);

// Tunable wake-word knobs persisted in localStorage so users can calibrate
// for their environment without editing code:
//   • wake.strictMode (default ON) — only fire when the wake word is the
//     entire utterance OR the first 1-2 words. Eliminates the common false
//     positive where "Horizon" appears mid-sentence (e.g. talking on a phone
//     nearby and saying "...did Horizon call?").
//   • wake.volumeThreshold (default 18, range 5-50) — peak volume during the
//     2.5s capture must exceed this to even attempt transcription. Higher =
//     less sensitive (skips quiet background) but might miss soft "Horizon".
//   • wake.confirmBeep (default OFF) — play a short tone after fire so the
//     user knows it heard them.
var WAKE_SETTING_KEYS = {
  strictMode: 'wakeStrictMode',
  volumeThreshold: 'wakeVolumeThreshold',
  confirmBeep: 'wakeConfirmBeep',
  talkMode: 'wakeTalkMode',
};
var wakeSettings = {
  strictMode: true,
  // Default was 10 — too high for many built-in laptop mics where typical
  // speech reads 5–8 on the frequency-bin average. With 10 the audio gate
  // dropped quiet "Хорайзон" utterances before they ever reached Whisper.
  // 6 is the sweet spot: still rejects pure room noise (typically 2–4) but
  // catches normal voice. User can still raise via Settings → Voice.
  volumeThreshold: 6,
  confirmBeep: false,
  // Continuous Talk Mode: when ON, after the bot finishes replying we
  // automatically reopen the command listener for ~10s, so the user can
  // keep speaking without saying "Horizon" again. When the window passes
  // with no speech, we fall back to normal wake-word listening.
  talkMode: false,
};
// Last raw transcription so debugSurfacing tools and the wake bar can show
// what Whisper heard. Surfaced via window.getWakeDebug() and the wake bar
// tooltip — invaluable when the user reports "wake doesn't work".
var wakeLastText = '';
var wakeLastTextAt = 0;
var wakeTranscribeErrorShown = false;

function localWakeCfg(key, def) {
  try {
    const v = localStorage.getItem('wake.' + key);
    if (v === null) return def;
    if (typeof def === 'boolean') return v === 'true';
    if (typeof def === 'number')  return Number.isFinite(+v) ? +v : def;
    return v;
  } catch { return def; }
}
function wakeCfg(key, def) {
  if (Object.prototype.hasOwnProperty.call(wakeSettings, key)) return wakeSettings[key];
  return localWakeCfg(key, def);
}
function setWakeCfg(key, val) {
  if (Object.prototype.hasOwnProperty.call(wakeSettings, key)) wakeSettings[key] = val;
  try { localStorage.setItem('wake.' + key, String(val)); } catch {}
  const storeKey = WAKE_SETTING_KEYS[key];
  if (storeKey) saveSetting(storeKey, val, 'Wake calibration');
}
async function loadWakeSettings() {
  const strict = await H.get('wakeStrictMode').catch(() => null);
  const vol = await H.get('wakeVolumeThreshold').catch(() => null);
  const beep = await H.get('wakeConfirmBeep').catch(() => null);
  const talk = await H.get('wakeTalkMode').catch(() => null);
  wakeSettings.strictMode = strict === null ? localWakeCfg('strictMode', true) : !!strict;
  wakeSettings.volumeThreshold = vol === null ? localWakeCfg('volumeThreshold', 10) : Math.max(5, Math.min(50, +vol || 10));
  wakeSettings.confirmBeep = beep === null ? localWakeCfg('confirmBeep', false) : !!beep;
  wakeSettings.talkMode = talk === null ? localWakeCfg('talkMode', false) : !!talk;
}

// Hot window
var hotWindowActive = false;
var hotWindowTimeout = null;
var HOT_WINDOW_DURATION = 15000;

function activateHotWindow() {
  hotWindowActive = true;
  clearTimeout(hotWindowTimeout);
  hotWindowTimeout = setTimeout(() => { hotWindowActive = false; }, HOT_WINDOW_DURATION);
}

// ═══════════════════════════════════════════════════════════════
// WAKE WORD ENGINE — MediaRecorder + Groq Whisper
// This is the ONLY method that reliably works in Electron.
// Web Speech API throws "network error" in Electron — confirmed bug.
// ═══════════════════════════════════════════════════════════════
function normalizeWakeText(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.,!?'"()[\]{}\-_:;…«»“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wakeDistance(a, b, maxDistance = 2) {
  a = String(a || '');
  b = String(b || '');
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, curr[j]);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function matchWakeWord(text) {
  const normalized = normalizeWakeText(text);
  const now = Date.now();
  const debug = { ok: false, normalized, matched: '', confidence: 0, reason: '' };
  if (!normalized) return { ...debug, reason: 'empty' };
  if (isSpeaking || (now - speakEndTime < ECHO_COOLDOWN)) return { ...debug, reason: 'echo-cooldown' };
  if (/^\[.*\]$/.test(normalized) || /^\(.*\)$/.test(normalized)) return { ...debug, reason: 'subtitle-artifact' };
  if (normalized.length > 90) return { ...debug, reason: 'too-long' };
  const hallucinations = /^(thanks|thank you|bye|okay|ok|oh|ah|um|uh|hmm|hm|yeah|yes|no|so|well|music|playing|silence|noise|applause|laughter|спасибо|пока|ну|да|нет|ой|ах|эм|угу|ага|хм|ладно|субтитры|подписка|подписывайтесь)$/i;
  if (hallucinations.test(normalized)) return { ...debug, reason: 'common-hallucination' };

  const words = normalized.split(' ').filter(Boolean);
  const strict = wakeCfg('strictMode', true);
  const attention = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'эй', 'слушай', 'окей', 'привет']);
  const canonical = [
    'горизонт', 'горизон', 'хорайзон', 'хоризон', 'харизон', 'харизонт', 'horizon', 'horizan', 'horison',
    'jarvis', 'джарвис'
  ];
  const startWords = attention.has(words[0]) ? words.slice(1, 3) : words.slice(0, 2);
  const candidates = strict ? startWords : words;
  for (const token of candidates) {
    for (const wake of canonical) {
      if (token === wake) return { ok: true, normalized, matched: wake, confidence: 1, reason: 'exact' };
      const maxDist = wake.length >= 7 ? 2 : 1;
      const d = wakeDistance(token, wake, maxDist);
      if (d <= maxDist) {
        return { ok: true, normalized, matched: wake, confidence: Number((1 - d / Math.max(token.length, wake.length)).toFixed(2)), reason: 'fuzzy' };
      }
    }
  }
  if (hotWindowActive && normalized.length > 3 && words.length >= 1) {
    hotWindowActive = false;
    clearTimeout(hotWindowTimeout);
    return { ok: true, normalized, matched: 'hot-window', confidence: 0.75, reason: 'hot-window' };
  }
  return { ...debug, reason: strict ? 'no-start-match' : 'no-match' };
}

function isWakeWord(text){
  const match = matchWakeWord(text);
  wakeLastDebug = { ...match, at: new Date().toISOString() };
  return !!match.ok;
}

window.normalizeWakeText = normalizeWakeText;
window.matchWakeWord = matchWakeWord;
window.getWakeDebug = () => ({
  last: wakeLastDebug,
  lastText: wakeLastText,
  lastTextAt: wakeLastTextAt,
  active: wakeActive,
  phase: wakePhase,
  cfg: { ...wakeSettings },
  transcribeErrorShown: wakeTranscribeErrorShown,
});

function voiceAudioConstraints() {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  };
}

async function startWakeMode(){
  if(wakeActive) return;

  // Check Groq key first
  const hasGroq = await H.hasKey('groq');
  if(!hasGroq){
    addMsg('bot', lang==='ru'
      ? '⚠️ **Wake Word требует Groq ключ** для транскрипции голоса.\n\nПочему: Google Web Speech API сломан в Electron (network error — известный баг).\n\n✅ Решение: Добавь Groq ключ в ⚙️ Настройки → AI Providers → Groq\n\nПолучить ключ: console.groq.com'
      : '⚠️ **Wake Word requires a Groq key** for voice transcription.\n\nWhy: Google Web Speech API is broken in Electron (network error — known bug).\n\n✅ Fix: Add your Groq key in ⚙️ Settings → AI Providers → Groq\n\nGet key: console.groq.com');
    wakeOn=false;
    document.getElementById('tc-wake').classList.remove('on','special');
    return;
  }

  try {
    wakeStream = await navigator.mediaDevices.getUserMedia(voiceAudioConstraints());
  } catch(e){
    addMsg('bot', lang==='ru'
      ? `⚠️ Нет доступа к микрофону: ${e.message}`
      : `⚠️ Mic access denied: ${e.message}`);
    wakeOn=false; return;
  }

  wakeActive=true;
  wakePhase='idle';
  // Fresh start: re-arm the one-shot transcription-error toast so users who
  // fix their Groq key (or switch provider) get feedback again.
  wakeTranscribeErrorShown = false;
  wakeLastText = '';
  setWakeBar('idle');
  runWakeChunk(); // start the loop
}

function stopWakeMode(){
  wakeActive=false;
  wakePhase='off';
  clearTimeout(wakeLoopTimer);
  try { wakeRec?.stop(); } catch(_){}
  try { cmdRec?.stop(); } catch(_){}
  try { wakeStream?.getTracks().forEach(t=>t.stop()); } catch(_){}
  try { wakeAudioCtx?.close(); } catch(_){}
  wakeStream=null; wakeRec=null; cmdRec=null;
  wakeAudioCtx=null; wakeAnalyser=null;
  setWakeBar('off');
}

// Record a 2.5-second audio chunk, check volume, then transcribe for wake word
// KEY FIX: Added volume threshold to avoid sending silence/noise to Whisper
var wakeAudioCtx = null;
var wakeAnalyser = null;
var wakePeakVolume = 0;

function initWakeAudioAnalysis() {
  try {
    if (!wakeAudioCtx && wakeStream) {
      wakeAudioCtx = new AudioContext();
      const src = wakeAudioCtx.createMediaStreamSource(wakeStream);
      wakeAnalyser = wakeAudioCtx.createAnalyser();
      wakeAnalyser.fftSize = 512;
      src.connect(wakeAnalyser);
    }
  } catch(e) { console.log('Audio analysis init failed:', e); }
}

function getWakeVolume() {
  if (!wakeAnalyser) return 0;
  const data = new Uint8Array(wakeAnalyser.frequencyBinCount);
  wakeAnalyser.getByteFrequencyData(data);
  return data.reduce((a, b) => a + b, 0) / data.length;
}

function runWakeChunk(){
  if(!wakeActive) return;
  if(wakePhase==='command') return;

  // Initialize audio analysis for volume detection
  initWakeAudioAnalysis();

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';

  wakeChunks=[];
  wakePeakVolume = 0;
  let consecutiveSpeechFrames = 0;
  let maxConsecutiveSpeechFrames = 0;

  try {
    wakeRec = new MediaRecorder(wakeStream, {mimeType});
  } catch(e){
    try { wakeRec = new MediaRecorder(wakeStream); } catch(e2){ stopWakeMode(); return; }
  }

  // Track peak volume during recording
  let volumeCheckInterval = setInterval(() => {
    const vol = getWakeVolume();
    if (vol > wakePeakVolume) wakePeakVolume = vol;
    
    // Sustained-speech tracking
    const volThreshold = wakeCfg('volumeThreshold', 10);
    if (vol > volThreshold) {
      consecutiveSpeechFrames++;
      if (consecutiveSpeechFrames > maxConsecutiveSpeechFrames) {
        maxConsecutiveSpeechFrames = consecutiveSpeechFrames;
      }
    } else {
      consecutiveSpeechFrames = 0;
    }
    
    // Update wake bar
    try { document.getElementById('wb-bar').style.width = Math.min(vol * 2.5, 100) + '%'; } catch(_){}
  }, 100);

  wakeRec.ondataavailable = e => { if(e.data?.size>0) wakeChunks.push(e.data); };
  wakeRec.onstop = () => {
    clearInterval(volumeCheckInterval);
    try { document.getElementById('wb-bar').style.width = '0%'; } catch(_){}

    if(!wakeActive || wakePhase==='command') return;

    // Snapshot this chunk's data before we restart the next chunk.
    const chunkBlob = wakeChunks.length ? new Blob(wakeChunks, {type: wakeRec.mimeType||'audio/webm'}) : null;
    const peak = wakePeakVolume;
    const frames = maxConsecutiveSpeechFrames;
    const recMime = wakeRec.mimeType || 'audio/webm';

    // CRITICAL: restart recording IMMEDIATELY — don't wait for transcription.
    // The previous version awaited Groq Whisper (500-1500ms) before starting
    // the next chunk, which created a 600-1800ms "deaf" window every cycle.
    // If the user said "Хорайзон" during that gap, it was silently missed.
    // Now: schedule the next chunk on the next tick, then process THIS chunk
    // asynchronously. Worst case the two overlap slightly, which is fine —
    // the audio gate + dedup already handles duplicate matches.
    scheduleNextChunk();

    // Audio gate + transcribe + match happen in background.
    (async () => {
      if (!chunkBlob || chunkBlob.size < 1200) {
        wakeLastDebug = { ok: false, reason: 'no-data', bytes: chunkBlob?.size || 0, at: new Date().toISOString() };
        return;
      }

      const volThreshold = wakeCfg('volumeThreshold', 6);
      const strictMode = wakeCfg('strictMode', true);

      // Audio gate: need EITHER decent peak volume OR sustained speech frames.
      // Strict mode additionally requires at least 2 sustained frames (200ms).
      const volumeFail = peak < Math.max(3, volThreshold * 0.5) && frames < 2;
      const strictFail = strictMode && frames < 2;
      if (volumeFail || strictFail) {
        wakeLastDebug = {
          ok: false,
          reason: 'audio-gate',
          peak: Number(peak.toFixed(1)),
          frames,
          bytes: chunkBlob.size,
          threshold: volThreshold,
          at: new Date().toISOString(),
        };
        return;
      }

      // ECHO DETECTION: Skip if Horizon is speaking or just finished
      if (isSpeaking || (Date.now() - speakEndTime < ECHO_COOLDOWN)) {
        wakeLastDebug = { ok: false, reason: 'echo-cooldown', at: new Date().toISOString() };
        return;
      }

      const result = await transcribeWakeChunk(chunkBlob);
      if (!wakeActive) return;

      if (!result.ok) {
        wakeLastDebug = { ok: false, reason: 'transcribe-error', error: result.error, peak: Number(peak.toFixed(1)), frames, at: new Date().toISOString() };
        surfaceWakeTranscribeError(result.error);
        return;
      }

      const text = result.text || '';
      wakeLastText = text;
      wakeLastTextAt = Date.now();
      const wakeMatch = matchWakeWord(text);
      wakeLastDebug = { ...wakeMatch, text, peak: Number(peak.toFixed(1)), frames, bytes: chunkBlob.size, at: new Date().toISOString() };

      // Show what we heard in the wake bar's idle text so the user has live
      // feedback. If we heard something but didn't match, this is gold for
      // diagnosing "why didn't it fire" without opening DevTools.
      if (wakeActive && wakePhase !== 'command' && text && !wakeMatch.ok) {
        try {
          const txt = document.getElementById('wb-txt');
          if (txt) txt.textContent = (lang === 'ru' ? 'Услышал: ' : 'Heard: ') + '"' + text.slice(0, 40) + '"';
        } catch(_) {}
      }

      if (text && wakeMatch.ok && !wakeDebounce) {
        wakeDebounce = true;
        setTimeout(() => wakeDebounce = false, 2500);
        fireWake();
      }
    })().catch(e => console.warn('[wake] process chunk error:', e));
  };

  wakePhase='listening';
  setWakeBar('listening');
  wakeRec.start(100);
  // 2000ms chunk — gives users a comfortable window to say "Хорайзон" (~700ms)
  // after they see the bar pulse. Combined with the deafness-gap fix above,
  // effective continuous listening with ~50ms transition between chunks.
  wakeLoopTimer = setTimeout(()=>{ try{wakeRec?.stop();}catch(_){} }, 2000);
}

function scheduleNextChunk(){
  if(!wakeActive) return;
  wakePhase='idle';
  // Minimal gap — chunk processing now runs in background, so we no longer
  // need a buffer for transcription to finish. 30ms is just enough for the
  // browser to clean up the previous MediaRecorder.
  wakeLoopTimer = setTimeout(()=>{ if (wakeActive && wakePhase !== 'command') runWakeChunk(); }, 30);
}

// Continuous Talk Mode follow-up: after a successful command + bot reply,
// wait for TTS to finish playing through speakers, then open another
// command listener — no wake-word required. Mirrors the fireWake TTS-wait
// pattern: poll isSpeaking with a hard ceiling so a stuck TTS can't strand
// the user in command-prep limbo. If user stays silent, listenForCommand's
// own 8s silenceTimer + "no audio" early-return falls back to the regular
// wake-word loop — that's how you exit Talk Mode (just stop talking).
// Phase 21 — true continuous Talk Mode.
//
// This was already chaining ("as long as you keep speaking we re-open
// the mic without a wake word"), but the MAX_WAIT was 8s — multi-
// paragraph TTS replies could overshoot it and the follow-up listener
// would open mid-TTS, picking up the bot's own audio. Bumped to 30s
// so long replies finish playing before the mic re-opens.
//
// Exit is still natural: stay silent during the 8s command-listen
// window → no transcript → no follow-up → fall back to wake-word.
function scheduleTalkModeFollowup() {
  const start = Date.now();
  const MAX_WAIT = 30000;
  const tick = () => {
    if (!wakeActive) { wakePhase='idle'; setWakeBar('idle'); return; }
    const elapsed = Date.now() - start;
    const cooled = !isSpeaking && (Date.now() - speakEndTime) >= ECHO_COOLDOWN;
    if (cooled || elapsed >= MAX_WAIT) {
      if (!wakeActive) return;
      wakePhase = 'command';
      setWakeBar('command');
      try {
        const bar = document.getElementById('wake-bar');
        if (bar) bar.classList.add('talk-mode');
        const txt = document.getElementById('wb-txt');
        if (txt) txt.textContent = lang === 'ru'
          ? '◉ Talk mode — продолжай, без «Горизонт»'
          : '◉ Talk mode — keep going, no wake word';
      } catch (_) {}
      listenForCommand();
      return;
    }
    setTimeout(tick, 120);
  };
  setTimeout(tick, 120);
}

// Returns the FULL transcription result so the caller can surface errors —
// the old version dropped `{error}` results with `res?.text || ''` and the
// wake loop fell silent forever. Now: `{ ok, text, error }`.
async function transcribeWakeChunk(blob){
  try {
    const reader = new FileReader();
    return await new Promise(resolve=>{
      reader.onloadend = async ()=>{
        try {
          const b64 = reader.result.split(',')[1];
          const mime = blob.type.split(';')[0];
          const res = await H.transcribeAudio(b64, mime);
          if (res && res.error) return resolve({ ok: false, text: '', error: res.error });
          return resolve({ ok: true, text: res?.text || '', error: null });
        } catch(e) {
          resolve({ ok: false, text: '', error: e.message || 'transcribe failed' });
        }
      };
      reader.readAsDataURL(blob);
    });
  } catch(e){ return { ok: false, text: '', error: e.message || 'reader failed' }; }
}

function surfaceWakeTranscribeError(err) {
  if (!err) return;
  console.warn('[wake] transcribe error:', err);
  // Show ONCE per session — repeated toasts on every chunk would be noise.
  // Re-arm the flag when user toggles wake off → on.
  if (wakeTranscribeErrorShown) return;
  wakeTranscribeErrorShown = true;
  try {
    addMsg?.('bot', lang === 'ru'
      ? `⚠️ Wake-mode: транскрипция не работает — ${err}\n\nПроверь Groq-ключ в ⚙️ Настройки → Голос. Без рабочего Whisper bot никогда не услышит "Хорайзон".`
      : `⚠️ Wake mode: transcription failed — ${err}\n\nCheck Groq key in ⚙️ Settings → Voice. Without working Whisper the bot will never hear "Horizon".`);
  } catch(_) {}
}

// Wake word detected! Respond + record command
async function fireWake(){
  wakePhase='command';
  setWakeBar('heard');

  // Optional confirm beep — short cue so user knows we heard them. Off by
  // default; toggle via Settings -> Voice -> Confirm beep.
  if (wakeCfg('confirmBeep', false)) {
    try {
      const ctx = wakeAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.2);
    } catch (_) { /* don't let beep failure break wake flow */ }
  }

  let reply;
  try {
    reply = await H.getWakeResponse(currentPersona, lang);
  } catch(_) {
    const replies_ru=['К вашим услугам, Сэр.','Слушаю, Сэр.','Да, Сэр?','Готов, Сэр.'];
    const replies_en=['At your service, Sir.','Listening, Sir.','Yes, Sir?','Ready, Sir.'];
    const replies = lang==='ru' ? replies_ru : replies_en;
    reply = replies[Math.floor(Math.random()*replies.length)];
  }

  addMsg('bot', `◈ ${reply}`);
  wakeLastFireAt = Date.now();
  // Wait for TTS to actually finish playing before opening the command
  // recorder. Otherwise the bot's own voice leaks into the mic (laptop
  // speakers + AEC ≠ silence), and providers like Deepgram strip the
  // resulting garbled clip down to an empty transcript. We poll the
  // existing isSpeaking flag (set by speak() in chat-voice.js) until it
  // clears + the ECHO_COOLDOWN window passes, with a hard 5s ceiling
  // so we never get permanently stuck waiting on a broken TTS.
  const waitStart = Date.now();
  const MAX_TTS_WAIT = 5000;
  const tick = () => {
    if (!wakeActive) { wakePhase='idle'; setWakeBar('idle'); return; }
    const elapsed = Date.now() - waitStart;
    const cooled = !isSpeaking && (Date.now() - speakEndTime) >= ECHO_COOLDOWN;
    if (cooled || elapsed >= MAX_TTS_WAIT) {
      setWakeBar('command');
      listenForCommand();
      return;
    }
    setTimeout(tick, 120);
  };
  setTimeout(tick, 120);
}

// Record the command (up to 8 seconds of silence detection)
function listenForCommand(){
  // Voice barge-in: wake command recording stops any ongoing TTS playback.
  window.speechSynthesis?.cancel();
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';

  let cmdChunks=[];
  let silenceTimer=null;
  let hasAudio=false;

  try { cmdRec = new MediaRecorder(wakeStream, {mimeType}); }
  catch(e){ try{cmdRec=new MediaRecorder(wakeStream);}catch(e2){ scheduleNextChunk(); return; } }

  // Set up audio level detection to auto-stop on silence
  let audioCtx=null, analyser=null, checkInterval=null;
  try {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(wakeStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize=512;
    src.connect(analyser);
    const data=new Uint8Array(analyser.frequencyBinCount);
    let silentFrames=0;

    checkInterval = setInterval(()=>{
      analyser.getByteFrequencyData(data);
      const avg=data.reduce((a,b)=>a+b,0)/data.length;
      // Update wake bar level
      document.getElementById('wb-bar').style.width=Math.min(avg*2.5,100)+'%';
      if(avg>8) { hasAudio=true; silentFrames=0; }
      else if(hasAudio) {
        silentFrames++;
        // 1.2 seconds of silence after speech = stop
        if(silentFrames>12){ stopCommandRec(); }
      }
    }, 100);
  } catch(e){}

  function stopCommandRec(){
    clearInterval(checkInterval);
    if(audioCtx) try{audioCtx.close();}catch(_){}
    clearTimeout(silenceTimer);
    try{cmdRec?.stop();}catch(_){}
  }

  // Continuous Talk Mode tracking — if a real command was transcribed AND
  // the user has Talk Mode enabled, we'll reopen the command listener after
  // the bot's reply (no need to say "Хорайзон" again for the follow-up).
  let commandSucceeded = false;
  cmdRec.ondataavailable = e=>{ if(e.data?.size>0) cmdChunks.push(e.data); };
  cmdRec.onstop = async()=>{
    clearInterval(checkInterval);
    try { document.getElementById('wb-bar').style.width='0%'; } catch(_) {}

    // Hard guarantee: no matter what happens below (transcription error,
    // unhandled exception in sendMsg, etc.) we ALWAYS return wakePhase to
    // 'idle' and schedule the next wake chunk. The old code awaited the
    // transcription and then ran user-handling code synchronously; if any
    // step threw, the phase stayed at 'command' forever and the wake bar
    // froze at "Слушаю команду" with no recovery. That's the "зависает"
    // bug the user reported.
    try {
      if(!wakeActive){ wakePhase='idle'; setWakeBar('idle'); return; }
      if(cmdChunks.length===0 || !hasAudio){
        wakePhase='idle';
        setWakeBar('idle');
        scheduleNextChunk();
        return;
      }

      setStatus(t('processing'), true);
      const blob = new Blob(cmdChunks, {type: cmdRec.mimeType||'audio/webm'});
      // transcribeWakeChunk now returns {ok,text,error} — used to be a
      // plain string. Extract the text field and route any error through
      // the same one-shot surfaced-error path the wake loop uses.
      const result = await transcribeWakeChunk(blob);
      if (result?.error) surfaceWakeTranscribeError(result.error);
      const text = String(result?.text || '').trim();

      if(text && text.length > 1){
        commandSucceeded = true;
        const inp=document.getElementById('inp');
        inp.value=text;
        try { ar(inp); } catch(_){}
        setTimeout(() => { try { sendMsg(); } catch(e){ console.warn('[wake] sendMsg failed:', e); } }, 100);
      } else {
        addMsg('bot', lang==='ru'
          ? '◈ Не расслышал команду. Попробуй ещё — скажи «Горизонт» снова.'
          : '◈ Didn\'t catch that. Say "Horizon" again.');
      }
    } catch (e) {
      console.warn('[wake] command stop handler failed:', e);
      try { addMsg('bot', lang==='ru' ? `◈ Ошибка обработки команды: ${e.message}` : `◈ Command error: ${e.message}`); } catch(_) {}
    } finally {
      // ALWAYS resume listening — this is the recovery path.
      wakePhase='idle';
      setWakeBar('idle');
      // Continuous Talk Mode: if Talk Mode is on AND the user gave a real
      // command this turn, queue up another command listener once the bot's
      // reply finishes playing. No wake-word needed for follow-up. If no
      // command was given (silence/no transcript) we fall back to normal
      // wake-word listening — that's also the natural way to exit Talk Mode
      // (just stop speaking; next cycle returns to wake-word).
      if (wakeCfg('talkMode', false) && commandSucceeded) {
        scheduleTalkModeFollowup();
      } else {
        wakeLoopTimer = setTimeout(runWakeChunk, 500);
      }
    }
  };

  // Max 8 second timeout for command
  silenceTimer = setTimeout(stopCommandRec, 8000);
  cmdRec.start(100); // collect data every 100ms
}

function setWakeBar(state){
  const bar=document.getElementById('wake-bar');
  const txt=document.getElementById('wb-txt');
  bar.className='wake-bar';
  if(state==='off'){ return; }
  bar.classList.add('show');
  if(state==='idle'){ bar.classList.add('idle'); txt.textContent=t('wakeIdle'); }
  else if(state==='listening'){ bar.classList.add('recording'); txt.textContent=t('wakeListening'); }
  else if(state==='transcribing'){ bar.classList.add('recording'); txt.textContent=t('wakeTranscribing'); }
  else if(state==='command'){ bar.classList.add('command'); txt.textContent=t('wakeCommand'); }
  else if(state==='heard'){ bar.classList.add('heard'); txt.textContent='◈ Слышу тебя, Сэр…'; }
  else if(state==='paused'){ bar.classList.add('idle'); txt.textContent=t('wakePaused') || 'Пауза — Хорайзон говорит'; }
}

function toggleWake(){
  const next=!wakeOn;
  // PR-LAYOUT-V3 — legacy `tc-wake` lives in the hidden .sb provider
  // bar (display:none). Null-guard so toggleWake works whether the
  // legacy chip exists or not — composer chip is the canonical UI now.
  const legacyBtn=document.getElementById('tc-wake');
  legacyBtn?.classList.toggle('on', next);
  saveSetting('wakeOn', next, 'Wake mode').then(ok=>{
    if(!ok){legacyBtn?.classList.toggle('on', wakeOn);return;}
    wakeOn=next;
    if(wakeOn) startWakeMode(); else stopWakeMode();
    try { updateShellChrome(); } catch(_){}
  });
}


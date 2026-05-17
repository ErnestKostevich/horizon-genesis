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
};
var wakeSettings = {
  strictMode: true,
  volumeThreshold: 10,
  confirmBeep: false,
};

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
  wakeSettings.strictMode = strict === null ? localWakeCfg('strictMode', true) : !!strict;
  wakeSettings.volumeThreshold = vol === null ? localWakeCfg('volumeThreshold', 10) : Math.max(5, Math.min(50, +vol || 10));
  wakeSettings.confirmBeep = beep === null ? localWakeCfg('confirmBeep', false) : !!beep;
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
window.getWakeDebug = () => wakeLastDebug;

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
  wakeRec.onstop = async () => {
    clearInterval(volumeCheckInterval);
    try { document.getElementById('wb-bar').style.width = '0%'; } catch(_){}

    if(!wakeActive || wakePhase==='command') return;
    if(wakeChunks.length===0){ scheduleNextChunk(); return; }

    const blob = new Blob(wakeChunks, {type: wakeRec.mimeType||'audio/webm'});

    // Skip if blob too small OR peak volume too low (just background noise).
    // Threshold default 18; user-tunable via Settings -> Voice -> Sensitivity
    // (range 5-50). Lower = more sensitive (catches quiet "Horizon" but
    // more false positives), higher = stricter.
    const volThreshold = wakeCfg('volumeThreshold', 10);
    const strictMode = wakeCfg('strictMode', true);
    
    if(blob.size < 1200 || (wakePeakVolume < Math.max(4, volThreshold * 0.45) && maxConsecutiveSpeechFrames < 2) || (strictMode && maxConsecutiveSpeechFrames < Math.max(2, MIN_SUSTAINED_SPEECH_FRAMES - 1))){
      wakeLastDebug = {
        ok: false,
        reason: 'audio-gate',
        peak: Number(wakePeakVolume.toFixed(1)),
        frames: maxConsecutiveSpeechFrames,
        bytes: blob.size,
        threshold: volThreshold,
        at: new Date().toISOString(),
      };
      scheduleNextChunk();
      return;
    }
    
    // ECHO DETECTION: Skip if Horizon is speaking or just finished
    if(isSpeaking || (Date.now() - speakEndTime < ECHO_COOLDOWN)){
      scheduleNextChunk();
      return;
    }

    wakePhase='transcribing';
    setWakeBar('transcribing');

    const text = await transcribeWakeChunk(blob);

    if(!wakeActive) return;

    const wakeMatch = matchWakeWord(text);
    wakeLastDebug = { ...wakeMatch, peak: Number(wakePeakVolume.toFixed(1)), frames: maxConsecutiveSpeechFrames, bytes: blob.size, at: new Date().toISOString() };

    if(text && wakeMatch.ok){
      if(!wakeDebounce){
        wakeDebounce=true;
        setTimeout(()=>wakeDebounce=false, 2500);
        fireWake();
        return;
      }
    }
    scheduleNextChunk();
  };

  wakePhase='listening';
  setWakeBar('listening');
  wakeRec.start(100);
  wakeLoopTimer = setTimeout(()=>{ try{wakeRec?.stop();}catch(_){} }, 1600);
}

function scheduleNextChunk(){
  if(!wakeActive) return;
  wakePhase='idle';
  setWakeBar('idle');
  // Small gap between chunks for processing
  wakeLoopTimer = setTimeout(runWakeChunk, 80);
}

async function transcribeWakeChunk(blob){
  try {
    const reader = new FileReader();
    return await new Promise(resolve=>{
      reader.onloadend = async ()=>{
        const b64 = reader.result.split(',')[1];
        const mime = blob.type.split(';')[0];
        const res = await H.transcribeAudio(b64, mime);
        resolve(res?.text || '');
      };
      reader.readAsDataURL(blob);
    });
  } catch(e){ return ''; }
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
  setTimeout(()=>{
    if(!wakeActive){ wakePhase='idle'; setWakeBar('idle'); return; }
    setWakeBar('command');
    listenForCommand();
  }, 120);
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

  cmdRec.ondataavailable = e=>{ if(e.data?.size>0) cmdChunks.push(e.data); };
  cmdRec.onstop = async()=>{
    clearInterval(checkInterval);
    document.getElementById('wb-bar').style.width='0%';

    if(!wakeActive){ wakePhase='idle'; setWakeBar('idle'); return; }
    if(cmdChunks.length===0 || !hasAudio){
      wakePhase='idle';
      setWakeBar('idle');
      scheduleNextChunk();
      return;
    }

    setStatus(t('processing'), true);
    const blob = new Blob(cmdChunks, {type: cmdRec.mimeType||'audio/webm'});
    const text = await transcribeWakeChunk(blob);

    if(text && text.trim().length > 1){
      // Show text in input and send
      const inp=document.getElementById('inp');
      inp.value=text.trim();
      ar(inp);
      setTimeout(sendMsg, 100);
    } else {
      addMsg('bot', lang==='ru'
        ? '◈ Не расслышал команду. Попробуй ещё — скажи «Горизонт» снова.'
        : '◈ Didn\'t catch that. Say "Horizon" again.');
    }

    // Resume wake listening
    wakePhase='idle';
    setWakeBar('idle');
    wakeLoopTimer = setTimeout(runWakeChunk, 1000);
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


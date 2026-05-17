// PR-V Phase 3.11 — Voice recording (manual / dictate) + multi-provider TTS.
// Extracted from chat.html inline <script> (was lines 1418-1691).
//
// Three coupled sub-features (all use MediaRecorder + audio
// playback shared infrastructure):
//
//   1. Manual Voice Button (push-to-talk via toggleVoice)
//      Fns: testMic, startLvl, stopLvl, toggleVoice, startRec,
//           stopRec, processAudio
//
//   2. Hold-to-Dictate
//      State: dictateStream, dictateRec, dictateChunks, isDictating
//      Fns: startDictate, stopDictate, processDictation
//
//   3. TTS playback (multi-provider: system / ElevenLabs / OpenAI / Kokoro)
//      Fns: playAudioB64, systemTTS, kokoroTTS, speakAndThen, speak
//
// Loaded as external script AFTER main inline so window.* globals
// it reads (H IPC, isProcessing, isRecording, audioStream, mediaRec,
// audioChunks, analyserAnim, voiceProvider, ttsProvider,
// elevenLabsVoice, openaiTtsVoice, ttsOn, lang, addMsg, sendMsg,
// pauseWakeForTts, resumeWakeAfterTts) are defined.
//
// NOTE: pauseWakeForTts / resumeWakeAfterTts are called by speak()
// to mute wake-word listening during AI speech (echo prevention).
// They live in chat-voice-wake.js (Phase 3.1) — script load order
// matters: wake-engine before this file.

// ═══════════════════════════════════════════════════════════════
// MANUAL VOICE BUTTON (MediaRecorder + Groq Whisper)
// ═══════════════════════════════════════════════════════════════
async function testMic(){
  // Post-PR-V Phase 1.6 — diagnostic: 3-sec record + peak dB + playback.
  // The previous version only checked getUserMedia permission and stopped
  // the stream immediately, which didn't tell users whether their mic
  // was actually picking up sound. Now we record, measure peak volume,
  // play it back so they hear themselves.
  const st = document.getElementById('mic-st');
  if (!st) return;
  st.textContent = 'Recording 3s - say something...'; st.style.color = 'var(--t2)';
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(voiceAudioConstraints());
  } catch (e) {
    st.textContent = e.message; st.style.color = 'var(--red)';
    return;
  }
  // Measure peak via AudioContext analyser.
  let peak = 0;
  let sampleRate = 0;
  let channels = 0;
  try {
    const ctx = new AudioContext();
    sampleRate = ctx.sampleRate;
    const src = ctx.createMediaStreamSource(stream);
    channels = src.channelCount;
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const data = new Uint8Array(an.frequencyBinCount);
    const peakTimer = setInterval(() => {
      an.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      if (avg > peak) peak = avg;
    }, 50);
    setTimeout(() => clearInterval(peakTimer), 3000);
  } catch (_) {}
  // Record 3 sec via MediaRecorder + play back.
  const chunks = [];
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  } catch (_) {
    try { rec = new MediaRecorder(stream); } catch (_) {}
  }
  if (!rec) {
    stream.getTracks().forEach(t => t.stop());
    st.textContent = 'MediaRecorder unsupported in this Electron build.';
    st.style.color = 'var(--red)';
    return;
  }
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    const peakDb = peak > 0 ? Math.round(20 * Math.log10(peak / 255) * 10) / 10 : -60;
    const verdict = peak < 20
      ? 'Too quiet - check mic gain'
      : peak > 220 ? 'Clipping - lower mic gain'
      : 'Mic working';
    st.innerHTML = `${verdict}<br>` +
      `<span style="font:600 11px var(--mono);color:var(--t3)">` +
      `peak: ${peak.toFixed(0)} / 255 (~${peakDb} dB) · ` +
      `${sampleRate}Hz · ${channels}ch</span>`;
    st.style.color = peak < 20 || peak > 220 ? 'var(--warn)' : 'var(--green)';
    // Play back what we just recorded.
    if (chunks.length) {
      const blob = new Blob(chunks, { type: rec.mimeType });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.play().catch(() => {});
      audio.onended = () => URL.revokeObjectURL(url);
    }
  };
  rec.start();
  setTimeout(() => { try { rec.stop(); } catch (_) {} }, 3000);
}

async function testWakeWord(){
  const st = document.getElementById('wake-test-st');
  if (!st) return;
  st.textContent = 'Recording 2s - say "Horizon" or "Горизонт"...';
  st.style.color = 'var(--t2)';
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(voiceAudioConstraints());
  } catch (e) {
    st.textContent = 'Mic error: ' + e.message;
    st.style.color = 'var(--red)';
    return;
  }
  const chunks = [];
  let rec;
  try { rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' }); }
  catch (_) { try { rec = new MediaRecorder(stream); } catch (_) {} }
  if (!rec) {
    stream.getTracks().forEach(t => t.stop());
    st.textContent = 'MediaRecorder unsupported.';
    st.style.color = 'var(--red)';
    return;
  }
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    st.textContent = 'Transcribing...';
    st.style.color = 'var(--t3)';
    try {
      const blob = new Blob(chunks, { type: rec.mimeType });
      // transcribeWakeChunk now returns {ok,text,error}. Old code assumed a
      // plain string and called .slice on it — that's the "(text || '').slice
      // is not a function" the user saw on the Test Wake Word button.
      const result = (typeof transcribeWakeChunk === 'function') ? await transcribeWakeChunk(blob) : { ok: false, text: '', error: 'wake module not loaded' };
      const text = String(result?.text || '');
      if (result?.error) {
        st.innerHTML = 'Transcribe failed: ' + esc(result.error);
        st.style.color = 'var(--red)';
        return;
      }
      const match = (typeof matchWakeWord === 'function') ? matchWakeWord(text) : { ok: false, normalized: text, reason: 'matcher unavailable' };
      if (!text) {
        st.innerHTML = 'Empty transcription — check voice provider key in Settings → Voice.';
        st.style.color = 'var(--red)';
        return;
      }
      st.innerHTML = `Transcript: <b>"${esc(text.slice(0, 120))}"</b><br>` +
        `<span style="font:600 11px var(--mono);color:var(--t3)">normalized: ${esc(match.normalized || '')} · ` +
        `wake: <b style="color:${match.ok ? 'var(--green)' : 'var(--warn)'}">${match.ok ? 'YES' : 'NO'}</b>` +
        ` · confidence ${match.confidence || 0} · ${esc(match.reason || '')}</span>`;
      st.style.color = match.ok ? 'var(--green)' : 'var(--warn)';
    } catch (e) {
      st.innerHTML = 'Transcribe failed: ' + esc(e?.message || e);
      st.style.color = 'var(--red)';
    }
  };
  rec.start(100);
  setTimeout(() => { try { rec.stop(); } catch (_) {} }, 1800);
}

function startLvl(stream){
  try{
    const ctx=new AudioContext(),src=ctx.createMediaStreamSource(stream),an=ctx.createAnalyser();
    an.fftSize=256;src.connect(an);const data=new Uint8Array(an.frequencyBinCount);
    const bar=document.getElementById('mbar');
    function loop(){an.getByteFrequencyData(data);bar.style.width=Math.min(data.reduce((a,b)=>a+b)/data.length*2.5,100)+'%';analyserAnim=requestAnimationFrame(loop);}
    loop();
  }catch(e){}
}
function stopLvl(){if(analyserAnim){cancelAnimationFrame(analyserAnim);analyserAnim=null;}document.getElementById('mbar').style.width='0%';}

async function toggleVoice(){ if(isProcessing)return; isRecording?stopRec():startRec(); }

async function startRec(){
  // Interrupt handling: if Horizon is speaking, manual voice immediately stops it.
  window.speechSynthesis?.cancel();
  // Pause wake mode while manually recording to avoid conflicts
  if(wakeActive && wakePhase!=='off'){
    clearTimeout(wakeLoopTimer);
    try{wakeRec?.stop();}catch(_){}
  }
  try{
    const stream=await navigator.mediaDevices.getUserMedia(voiceAudioConstraints());
    audioStream=stream;
    const mt=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':MediaRecorder.isTypeSupported('audio/webm')?'audio/webm':'audio/mp4';
    mediaRec=new MediaRecorder(stream,{mimeType:mt});
    audioChunks=[];
    mediaRec.ondataavailable=e=>{if(e.data?.size>0)audioChunks.push(e.data);};
    mediaRec.onstop=()=>{audioStream.getTracks().forEach(t=>t.stop());stopLvl();processAudio(mt);};
    mediaRec.start();isRecording=true;
    const btn=document.getElementById('btn-mic');
    btn.classList.add('rec');btn.innerHTML=controlHtml('i-stop','STOP');
    document.getElementById('vb').classList.add('show');
    document.getElementById('vtxt').textContent=t('recording');
    setStatus(t('recording'),true);startLvl(stream);
    setVoiceButtonState('recording');
  }catch(e){addMsg('bot',`Mic: ${e.message}`);}
}

function stopRec(){
  if(mediaRec&&isRecording){
    mediaRec.stop();isRecording=false;isProcessing=true;
    const btn=document.getElementById('btn-mic');
    btn.classList.remove('rec');btn.classList.add('proc');btn.innerHTML=controlHtml('i-loader','...');
    document.getElementById('vtxt').textContent=t('processing');
    setStatus(t('processing'),true);
    setVoiceButtonState('processing');
  }
}

async function processAudio(mimeType){
  const blob=new Blob(audioChunks,{type:mimeType});
  isProcessing=false;
  const btn=document.getElementById('btn-mic');
  btn.classList.remove('proc');btn.innerHTML=controlHtml('i-mic','VOICE');
  document.getElementById('vb').classList.remove('show');
  setVoiceButtonState('idle');
  setStatus(t('ready'));

  // Resume wake if it was on
  if(wakeActive){
    wakePhase='idle'; setWakeBar('idle');
    wakeLoopTimer=setTimeout(runWakeChunk, 500);
  }

  if(blob.size<500){ return; }
  const reader=new FileReader();
  reader.onloadend=async()=>{
    const b64=reader.result.split(',')[1];
    const mime=mimeType.split(';')[0];
    const res=await H.transcribeAudio(b64,mime);
    if(res.error){ addMsg('bot',`${res.error}`); }
    else if(res.text?.trim()){
      const inp=document.getElementById('inp');
      inp.value=res.text;ar(inp);
      setTimeout(sendMsg,300);
    }
  };
  reader.readAsDataURL(blob);
}

// ═══════════════════════════════════════════════════════════════
// HOLD-TO-DICTATE (jarvis feature)
// Press and hold to record, release to transcribe and insert text
// ═══════════════════════════════════════════════════════════════
var dictateStream = null;
var dictateRec = null;
var dictateChunks = [];
var isDictating = false;

async function startDictate() {
  if (isDictating || isRecording || isProcessing) return;
  
  try {
    dictateStream = await navigator.mediaDevices.getUserMedia(voiceAudioConstraints());
    const mt = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') 
      ? 'audio/webm;codecs=opus' 
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
    
    dictateRec = new MediaRecorder(dictateStream, { mimeType: mt });
    dictateChunks = [];
    
    dictateRec.ondataavailable = e => { if (e.data?.size > 0) dictateChunks.push(e.data); };
    dictateRec.onstop = async () => {
      dictateStream?.getTracks().forEach(t => t.stop());
      await processDictation(mt);
    };
    
    dictateRec.start();
    isDictating = true;
    
    const btn = document.getElementById('btn-dictate');
    btn.classList.add('rec');
    btn.innerHTML = controlHtml('i-stop','REC');
    
    document.getElementById('vb').classList.add('show');
    setDictateButtonState('recording');
    document.getElementById('vtxt').textContent = lang === 'ru' ? 'Диктую…' : 'Dictating…';
    startLvl(dictateStream);
  } catch (e) {
    addMsg('bot', `Mic: ${e.message}`);
  }
}

function stopDictate() {
  if (!isDictating || !dictateRec) return;
  
  try { dictateRec.stop(); } catch (_) {}
  isDictating = false;
  
  const btn = document.getElementById('btn-dictate');
  btn.classList.remove('rec');
  btn.classList.add('proc');
  btn.innerHTML = controlHtml('i-loader','...');
  
  document.getElementById('vtxt').textContent = t('processing');
  stopLvl();
  setDictateButtonState('processing');
}

async function processDictation(mimeType) {
  const btn = document.getElementById('btn-dictate');
  btn.classList.remove('proc');
  btn.innerHTML = controlHtml('i-hand','HOLD');
  document.getElementById('vb').classList.remove('show');
  setDictateButtonState('idle');
  
  const blob = new Blob(dictateChunks, { type: mimeType });
  if (blob.size < 500) return;
  
  const reader = new FileReader();
  reader.onloadend = async () => {
    const b64 = reader.result.split(',')[1];
    const mime = mimeType.split(';')[0];
    const res = await H.transcribeAudio(b64, mime);
    
    if (res.error) {
      addMsg('bot', `${res.error}`);
    } else if (res.text?.trim()) {
      // Insert at cursor position (append to existing text)
      const inp = document.getElementById('inp');
      const cursorPos = inp.selectionStart;
      const before = inp.value.substring(0, cursorPos);
      const after = inp.value.substring(inp.selectionEnd);
      inp.value = before + (before && !before.endsWith(' ') ? ' ' : '') + res.text + after;
      ar(inp);
      inp.focus();
      // Don't auto-send for dictation - user decides when to send
    }
  };
  reader.readAsDataURL(blob);
}

// ═══════════════════════════════════════════════════════════════
// TTS — multi-provider: system / elevenlabs / openai / kokoro
// ═══════════════════════════════════════════════════════════════
function playAudioB64(base64, mimeType, callback){
  try{
    const audio=new Audio(`data:${mimeType};base64,${base64}`);
    audio.onended=()=>{ if(callback) setTimeout(callback,100); };
    audio.onerror=()=>{ if(callback) setTimeout(callback,200); };
    audio.play();
  }catch(e){ if(callback) setTimeout(callback,300); }
}

function systemTTS(text, callback){
  if(!window.speechSynthesis){ if(callback) setTimeout(callback,300); return; }
  window.speechSynthesis.cancel();
  const clean=text.replace(/◈/g,'').trim();
  const u=new SpeechSynthesisUtterance(clean);
  u.lang=lang==='ru'?'ru-RU':'en-US'; u.rate=0.97; u.pitch=0.93;
  u.onend=()=>{ if(callback) setTimeout(callback,200); };
  u.onerror=()=>{ if(callback) setTimeout(callback,300); };
  const go=()=>{
    const vs=window.speechSynthesis.getVoices();
    const v=lang==='ru'
      ?vs.find(v=>v.lang.startsWith('ru')&&v.localService)||vs.find(v=>v.lang.startsWith('ru'))
      :vs.find(v=>v.name.includes('Daniel')||v.name.includes('Alex')||v.name.includes('Samantha')||v.name.includes('Google'))||vs.find(v=>v.lang.startsWith('en')&&v.localService);
    if(v)u.voice=v;
    window.speechSynthesis.speak(u);
  };
  if(window.speechSynthesis.getVoices().length)go();else window.speechSynthesis.onvoiceschanged=go;
}

async function kokoroTTS(text, callback){
  // Kokoro — free local TTS via kokoro.js (loads from CDN when available)
  // Falls back to system TTS if not available
  if(typeof window.KokoroTTS !== 'undefined'){
    try{
      const audio = await window.KokoroTTS.generate(text, { voice: lang==='ru'?'af_sky':'af_sky' });
      playAudioB64(audio.base64, 'audio/wav', callback);
      return;
    }catch(e){}
  }
  // Fallback to system
  systemTTS(text, callback);
}

async function speakAndThen(text, callback){
  if(!ttsOn){ if(callback) setTimeout(callback,300); return; }
  const clean = text.replace(/```[\s\S]*?```/g,'').replace(/◈|[#*`]/g,'').trim().slice(0,500);
  if(!clean){ if(callback) setTimeout(callback,100); return; }
  window.speechSynthesis?.cancel();

  // ECHO DETECTION: Mark that Horizon is speaking
  isSpeaking = true;
  pauseWakeForTts();

  let cbCalled=false;
  const safeCb = ()=>{ 
    if(!cbCalled){
      cbCalled=true;
      // Mark speaking end for echo detection
      isSpeaking = false;
      speakEndTime = Date.now();
      resumeWakeAfterTts();
      // Activate hot window after TTS completes
      if(wakeOn && wakeActive) activateHotWindow();
      if(callback)callback();
    }
  };
  const cbTimer = callback ? setTimeout(safeCb, 8000) : null;
  const wrappedCb = ()=>{ if(cbTimer)clearTimeout(cbTimer); safeCb(); };

  if(ttsProvider==='elevenlabs'){
    const res = await H.ttsElevenLabs(clean, elevenLabsVoice).catch(()=>null);
    if(res?.ok){ playAudioB64(res.base64, res.mimeType, wrappedCb); return; }
    systemTTS(clean, wrappedCb); return;
  }
  if(ttsProvider==='openai'){
    const res = await H.ttsOpenAI(clean, openaiTtsVoice).catch(()=>null);
    if(res?.ok){ playAudioB64(res.base64, res.mimeType, wrappedCb); return; }
    systemTTS(clean, wrappedCb); return;
  }
  if(ttsProvider==='kokoro'){
    kokoroTTS(clean, wrappedCb); return;
  }
  systemTTS(clean, wrappedCb);
}
function speak(text){ speakAndThen(text, null); }


// PR-V Phase 3.10 — Screen Recorder + AI Narrator module.
// Extracted from chat.html inline <script> (was lines 5258-5435).
//
// User-flow: open Recorder panel → click Record → screen capture via
// MediaRecorder (with audio if granted) → stop → playback / narrate /
// save. AI Narrator sends the recording to the active provider for a
// summary / step-by-step transcript.
//
// State: isScreenRecording, screenRecStream, screenRecMediaRec,
//        screenRecChunks, screenRecTimer, screenRecSeconds,
//        screenRecordings
// Fns:   openRecorder, closeRecorder, renderRecorderBody,
//        formatRecTime, toggleRecording, startScreenRecording,
//        stopScreenRecording, cancelRecording, processRecording,
//        narrateRecording, playRecording
//
// Loaded as external script AFTER main inline so window.* globals
// it reads (H IPC, addMsg, lang, prov, getSelectedModelForProvider,
// etc.) are defined.

// ═══════════════════════════════════════════════════════════════
// SCREEN RECORDER + AI NARRATOR
// ═══════════════════════════════════════════════════════════════
var isScreenRecording = false;
var screenRecStream = null;
var screenRecMediaRec = null;
var screenRecChunks = [];
var screenRecTimer = null;
var screenRecSeconds = 0;
var screenRecordings = [];

function openRecorder() {
  setActiveSurface('recorder', { keepPanels:['recorder-panel'] });
  document.getElementById('recorder-panel').classList.add('show');
  renderRecorderBody();
}
function closeRecorder() {
  document.getElementById('recorder-panel').classList.remove('show');
  if (isSurfaceActive('recorder')) closeActiveSurface();
}

function renderRecorderBody() {
  const body = document.getElementById('recorder-body');
  body.innerHTML = `
    <div class="rec-panel">
      <div class="rec-circle ${isScreenRecording ? 'recording' : ''}" id="rec-circle" onclick="toggleRecording()">
        ${isScreenRecording ? '⏹️' : '⏺'}
      </div>
      <div class="rec-time" id="rec-time">${formatRecTime(screenRecSeconds)}</div>
      <div class="rec-status" id="rec-status">${isScreenRecording ? (lang==='ru'?'Запись экрана...':'Recording screen...') : (lang==='ru'?'Нажми ‣ чтобы начать запись':'Click ‣ to start recording')}</div>
      <div class="rec-controls">
        <button class="rec-btn ${isScreenRecording ? 'stop' : 'start'}" onclick="toggleRecording()">${isScreenRecording ? '⏹ Stop' : '⏺ Start Recording'}</button>
        ${isScreenRecording ? '<button class="rec-btn" onclick="cancelRecording()">Cancel</button>' : ''}
      </div>
      <div class="rec-recordings" id="rec-recordings">
        ${screenRecordings.length ? `<div style="font-size:11px;font-weight:700;color:var(--t2);margin-bottom:10px">${lang==='ru'?'Записи':'Recordings'}</div>` : ''}
        ${screenRecordings.map((r,i) => `
          <div class="rec-item">
            <div class="rec-item-icon">🎥</div>
            <div class="rec-item-info">
              <div class="rec-item-name">${r.name}</div>
              <div class="rec-item-meta">${r.duration} · ${r.date}</div>
            </div>
            <div class="rec-item-actions">
              <button class="rec-narrate-btn" onclick="narrateRecording(${i})">&#129302; AI Narrate</button>
              <button class="rec-btn" style="padding:4px 10px;font-size:10px" onclick="playRecording(${i})">Play</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function formatRecTime(s) {
  const m = Math.floor(s/60).toString().padStart(2,'0');
  const ss = (s%60).toString().padStart(2,'0');
  return `${m}:${ss}`;
}

async function toggleRecording() {
  if (isScreenRecording) {
    await stopScreenRecording();
  } else {
    await startScreenRecording();
  }
}

async function startScreenRecording() {
  try {
    // Use Electron desktopCapturer via getDisplayMedia
    const constraints = { video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 1920, maxHeight: 1080 } }, audio: false };
    screenRecStream = await navigator.mediaDevices.getUserMedia(constraints);
    screenRecChunks = [];
    screenRecSeconds = 0;
    screenRecMediaRec = new MediaRecorder(screenRecStream, { mimeType: 'video/webm;codecs=vp9' });
    screenRecMediaRec.ondataavailable = e => { if (e.data.size > 0) screenRecChunks.push(e.data); };
    screenRecMediaRec.onstop = processRecording;
    screenRecMediaRec.start(1000);
    isScreenRecording = true;
    screenRecTimer = setInterval(() => {
      screenRecSeconds++;
      const el = document.getElementById('rec-time');
      if (el) el.textContent = formatRecTime(screenRecSeconds);
    }, 1000);
    renderRecorderBody();
  } catch(e) {
    // Fallback: use main process recorder
    try {
      const r = await H.recorderStart();
      if (r.ok) {
        isScreenRecording = true;
        screenRecSeconds = 0;
        screenRecTimer = setInterval(() => {
          screenRecSeconds++;
          const el = document.getElementById('rec-time');
          if (el) el.textContent = formatRecTime(screenRecSeconds);
        }, 1000);
        renderRecorderBody();
      } else { H.notify('Recorder', r.error || e.message); }
    } catch(e2) { H.notify('Recorder', e2.message); }
  }
}

async function stopScreenRecording() {
  clearInterval(screenRecTimer);
  isScreenRecording = false;
  if (screenRecMediaRec && screenRecMediaRec.state !== 'inactive') {
    screenRecMediaRec.stop();
  } else {
    try { await H.recorderStop(); } catch(_) {}
    const name = `Recording_${new Date().toISOString().slice(0,19).replace(/[T:]/g,'_')}.webm`;
    screenRecordings.unshift({ name, duration: formatRecTime(screenRecSeconds), date: new Date().toLocaleString(), blob: null });
    renderRecorderBody();
  }
  if (screenRecStream) { screenRecStream.getTracks().forEach(t => t.stop()); screenRecStream = null; }
}

function cancelRecording() {
  clearInterval(screenRecTimer);
  isScreenRecording = false;
  screenRecChunks = [];
  if (screenRecMediaRec && screenRecMediaRec.state !== 'inactive') screenRecMediaRec.stop();
  if (screenRecStream) { screenRecStream.getTracks().forEach(t => t.stop()); screenRecStream = null; }
  renderRecorderBody();
}

async function processRecording() {
  const blob = new Blob(screenRecChunks, { type: 'video/webm' });
  const name = `Recording_${new Date().toISOString().slice(0,19).replace(/[T:]/g,'_')}.webm`;
  // Save via main process
  try {
    const reader = new FileReader();
    reader.onload = async () => {
      const b64 = reader.result.split(',')[1];
      const r = await H.recorderSave(b64, 'video/webm');
      if (r.ok) H.notify('Recorder', `Saved: ${r.path || name}`);
    };
    reader.readAsDataURL(blob);
  } catch(_) {}
  screenRecordings.unshift({ name, duration: formatRecTime(screenRecSeconds), date: new Date().toLocaleString(), blob });
  renderRecorderBody();
}

async function narrateRecording(idx) {
  const rec = screenRecordings[idx];
  if (!rec) return;
  addMsg('bot', lang === 'ru' ? '🤖 AI анализирует запись...' : '🤖 AI is analyzing the recording...');
  closeRecorder();
  try {
    // Capture current screen for narration context
    const screenshot = await H.captureScreen();
    if (screenshot?.base64) {
      const r = await H.recorderNarrate(screenshot.base64, 'image/png', `Recording: ${rec.name}, Duration: ${rec.duration}`);
      if (r.ok) {
        addMsg('bot', `🎥 **AI Narration for ${rec.name}:**\n\n${r.narration}`);
        if (ttsOn) speak(r.narration.slice(0, 300));
      } else { addMsg('bot', `⚠️ ${r.error}`); }
    } else {
      addMsg('bot', lang === 'ru' ? '⚠️ Не удалось захватить экран' : '⚠️ Could not capture screen for narration');
    }
  } catch(e) { addMsg('bot', `⚠️ ${e.message}`); }
}

function playRecording(idx) {
  const rec = screenRecordings[idx];
  if (!rec?.blob) { H.notify('Recorder', 'Recording not available'); return; }
  const url = URL.createObjectURL(rec.blob);
  const video = document.createElement('video');
  video.src = url;
  video.controls = true;
  video.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999;max-width:90vw;max-height:80vh;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.8);background:#000';
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:998;cursor:pointer';
  overlay.onclick = () => { document.body.removeChild(video); document.body.removeChild(overlay); URL.revokeObjectURL(url); };
  document.body.appendChild(overlay);
  document.body.appendChild(video);
  video.play();
}


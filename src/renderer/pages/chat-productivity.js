// PR-V Phase 3.5 — Productivity Features module.
// Extracted from chat.html inline <script> (was lines 5147-5350).
// Three independent productivity sub-features bundled because they
// share the same boot/lifecycle pattern (toggle-driven, persisted via
// H.set/H.get, intermixed AddMsg + speak calls):
//
//   1. Focus Timer (Pomodoro)
//      - startFocusTimer / toggleFocusTimer / stopFocusTimer / updateFocusDisplay
//      - state: focusInterval, focusRemaining, focusPaused
//
//   2. Ambient Mode (AI proactively analyzes screen, suggests help)
//      - toggleAmbient / startAmbientMode / stopAmbientMode / runAmbientCheck
//
//   3. Smart Notifications (daily briefing, weather/calendar/emails)
//      - toggleNotifications / startNotifications / stopNotifications
//      - checkNotifications / runDailyBriefing / requestBriefing
//
// Loaded as external script AFTER main inline so window.* globals it
// reads (H IPC, lang, addMsg, speak, prov, screenContextB64, etc.)
// are defined.

// ═══════════════════════════════════════════════════════════════
// FOCUS TIMER (Pomodoro)
// ═══════════════════════════════════════════════════════════════
var focusInterval = null;
var focusRemaining = 0;
var focusPaused = false;

function startFocusTimer(minutes = 25) {
  focusRemaining = minutes * 60;
  focusPaused = false;
  document.getElementById('focus-timer').classList.add('show');
  document.getElementById('focus-toggle').textContent = '||';
  updateFocusDisplay();
  
  clearInterval(focusInterval);
  focusInterval = setInterval(() => {
    if (!focusPaused) {
      focusRemaining--;
      updateFocusDisplay();
      if (focusRemaining <= 0) {
        stopFocusTimer();
        // Notify user
        H.notify('Focus Timer', lang === 'ru' ? 'Время фокуса завершено! Сделай перерыв.' : 'Focus time complete! Take a break.');
        addMsg('bot', lang === 'ru' 
          ? '⏱ **Время фокуса завершено!** Отличная работа. Рекомендую 5 минут перерыва.'
          : '⏱ **Focus time complete!** Great work. Take a 5 minute break.');
        speak(lang === 'ru' ? 'Время фокуса завершено. Отличная работа, Сэр.' : 'Focus time complete. Great work, Sir.');
      }
    }
  }, 1000);
  
  addMsg('bot', lang === 'ru' 
    ? `⏱ **Таймер фокуса запущен: ${minutes} минут.** Сосредоточься!`
    : `⏱ **Focus timer started: ${minutes} minutes.** Stay focused!`);
}

function toggleFocusTimer() {
  focusPaused = !focusPaused;
  document.getElementById('focus-toggle').textContent = focusPaused ? '▶' : '||';
}

function stopFocusTimer() {
  clearInterval(focusInterval);
  focusInterval = null;
  focusRemaining = 0;
  document.getElementById('focus-timer').classList.remove('show');
}

function updateFocusDisplay() {
  const m = Math.floor(focusRemaining / 60);
  const s = focusRemaining % 60;
  document.getElementById('focus-time').textContent = `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
}

// ═══════════════════════════════════════════════════════════════
// AMBIENT MODE — AI proactively analyzes screen and suggests help
// ═══════════════════════════════════════════════════════════════
async function toggleAmbient() {
  const next = !ambientOn;
  document.getElementById('sw-ambient').classList.toggle('on', next);
  if(!(await saveSetting('ambientOn', next, 'Ambient Mode'))){
    document.getElementById('sw-ambient').classList.toggle('on', ambientOn);
    return;
  }
  ambientOn = next;
  
  if (ambientOn) {
    startAmbientMode();
    addMsg('bot', lang === 'ru' 
      ? '🌐 **Ambient Mode включён.** Я буду наблюдать за экраном и предлагать помощь. Отключи в ⚙️ Настройках.'
      : '🌐 **Ambient Mode enabled.** I\'ll watch your screen and offer help. Disable in ⚙️ Settings.');
  } else {
    stopAmbientMode();
    addMsg('bot', lang === 'ru' ? '🌐 Ambient Mode выключен.' : '🌐 Ambient Mode disabled.');
  }
}

function startAmbientMode() {
  if (ambientInterval) clearInterval(ambientInterval);
  ambientInterval = setInterval(runAmbientCheck, AMBIENT_INTERVAL_MS);
}

function stopAmbientMode() {
  if (ambientInterval) { clearInterval(ambientInterval); ambientInterval = null; }
}

async function runAmbientCheck() {
  if (!ambientOn) return;
  try {
    const screenshot = await H.captureScreen();
    if (!screenshot?.base64) return;
    
    const prompt = lang === 'ru'
      ? `Ты Horizon AI ambient assistant. Посмотри на экран пользователя и определи:
1. Что пользователь делает сейчас?
2. Есть ли что-то, чем ты можешь помочь?
Если можешь помочь — предложи КРАТКО (1-2 предложения). Если всё ок — ответь ПУСТОЙ СТРОКОЙ.
НЕ предлагай помощь если пользователь просто смотрит видео, читает или ничего не делает.`
      : `You are Horizon AI ambient assistant. Look at the user's screen and determine:
1. What is the user doing?
2. Can you help with anything?
If you can help — suggest BRIEFLY (1-2 sentences). If everything is fine — respond with EMPTY STRING.
Do NOT suggest help if user is just watching video, reading, or idle.`;
    
    const res = await H.analyzeScreen(prompt);
    if (res?.reply && res.reply.trim().length > 10) {
      // Only show if it's a meaningful suggestion
      const suggestion = res.reply.trim();
      if (suggestion.length < 200 && !suggestion.includes('EMPTY') && !suggestion.includes('\u043F\u0443\u0441\u0442')) {
        addMsg('bot', `🌐 *Ambient:* ${suggestion}`);
      }
    }
  } catch(_) {}
}

// ═══════════════════════════════════════════════════════════════
// SMART NOTIFICATIONS — daily briefing
// ═══════════════════════════════════════════════════════════════
async function toggleNotifications() {
  const next = !notificationsOn;
  document.getElementById('sw-notifs').classList.toggle('on', next);
  if(!(await saveSetting('notificationsOn', next, 'Smart Notifications'))){
    document.getElementById('sw-notifs').classList.toggle('on', notificationsOn);
    return;
  }
  notificationsOn = next;
  
  if (notificationsOn) {
    startNotifications();
    addMsg('bot', lang === 'ru'
      ? '🔔 **Smart Notifications включены.** Утренний брифинг и важные уведомления. Отключи в ⚙️.'
      : '\u{1F4C4} **Smart Notifications enabled.** Morning briefing and important alerts. Disable in ⚙️.');
  } else {
    stopNotifications();
    addMsg('bot', lang === 'ru' ? '🔔 Уведомления выключены.' : '🔔 Notifications disabled.');
  }
}

function startNotifications() {
  if (notifCheckInterval) clearInterval(notifCheckInterval);
  // Check every 5 minutes
  notifCheckInterval = setInterval(checkNotifications, 300000);
  // Run immediately
  setTimeout(checkNotifications, 2000);
}

function stopNotifications() {
  if (notifCheckInterval) { clearInterval(notifCheckInterval); notifCheckInterval = null; }
}

async function checkNotifications() {
  if (!notificationsOn) return;
  
  const hour = new Date().getHours();
  
  // Daily briefing between 7-10 AM, only once per day
  if (hour >= 7 && hour <= 10 && !dailyBriefingDone) {
    dailyBriefingDone = true;
    await runDailyBriefing();
  }
  
  // Reset daily flag at midnight
  if (hour === 0) dailyBriefingDone = false;
}

async function runDailyBriefing() {
  let briefing = lang === 'ru' ? '## ☀️ Утренний брифинг\n\n' : '## ☀️ Morning Briefing\n\n';
  
  // Weather
  try {
    const weather = await H.mcpGetWeather();
    if (weather.ok) {
      briefing += lang === 'ru'
        ? `**Погода** (${weather.location}): ${weather.current.temp_c}°C, ${weather.current.description}\n\n`
        : `**Weather** (${weather.location}): ${weather.current.temp_c}°C, ${weather.current.description}\n\n`;
    }
  } catch(_) {}
  
  // Calendar
  try {
    const cal = await H.mcpCalToday();
    if (cal.ok && cal.events?.length) {
      briefing += lang === 'ru' ? `**Календарь:** ${cal.events.length} событий сегодня\n` : `**Calendar:** ${cal.events.length} events today\n`;
      for (const e of cal.events.slice(0, 3)) {
        briefing += `- ${e.summary || 'Event'}\n`;
      }
      briefing += '\n';
    }
  } catch(_) {}
  
  // Time
  const now = new Date();
  briefing += lang === 'ru'
    ? `**Время:** ${now.toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'})} · ${now.toLocaleDateString('ru-RU', {weekday:'long',day:'numeric',month:'long'})}\n`
    : `**Time:** ${now.toLocaleTimeString('en-US', {hour:'2-digit',minute:'2-digit'})} · ${now.toLocaleDateString('en-US', {weekday:'long',month:'long',day:'numeric'})}\n`;
  
  addMsg('bot', briefing);
  speak(lang === 'ru' ? 'Доброе утро, Сэр. Вот ваш утренний брифинг.' : 'Good morning, Sir. Here is your daily briefing.');
}

// Manual briefing trigger
async function requestBriefing() {
  await runDailyBriefing();
}



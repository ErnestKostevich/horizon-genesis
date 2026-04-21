'use strict';
/**
 * Horizon AI v2 — Workflow Engine
 * Поддержка:
 * - Ручного запуска workflows
 * - Scheduled workflows (cron-like: каждые N минут, в конкретное время)
 * - Wake-word триггеров
 * - Автоматического создания workflows через AI
 */

const { Notification } = require('electron');

class WorkflowEngine {
  constructor(store, pluginManager) {
    this.store = store;
    this.pluginManager = pluginManager;
    this.scheduledJobs = new Map(); // workflowId -> interval/timeout handle
    this.running = false;
  }

  // Загрузить все workflows из хранилища
  loadAll() {
    try {
      const raw = this.store.get('workflows');
      if (!raw) return [];
      const workflows = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(workflows) ? workflows : [];
    } catch {
      return [];
    }
  }

  // Сохранить workflows
  saveAll(workflows) {
    this.store.set('workflows', JSON.stringify(workflows));
  }

  // Создать новый workflow
  create(name, trigger, steps, description = '') {
    const workflows = this.loadAll();
    const id = 'wf_' + Date.now();
    const wf = {
      id,
      name,
      description,
      trigger, // 'manual' | 'schedule:HH:MM' | 'interval:N' | 'wake:keyword'
      steps,   // Array of { type, action, params }
      enabled: true,
      createdAt: new Date().toISOString(),
      lastRun: null,
      runCount: 0
    };
    workflows.push(wf);
    this.saveAll(workflows);
    this.scheduleWorkflow(wf);
    return wf;
  }

  // Обновить workflow
  update(id, updates) {
    const workflows = this.loadAll();
    const idx = workflows.findIndex(w => w.id === id);
    if (idx === -1) return { ok: false, error: 'Workflow not found' };
    workflows[idx] = { ...workflows[idx], ...updates };
    this.saveAll(workflows);
    this.unscheduleWorkflow(id);
    if (workflows[idx].enabled) this.scheduleWorkflow(workflows[idx]);
    return { ok: true, workflow: workflows[idx] };
  }

  // Удалить workflow
  delete(id) {
    const workflows = this.loadAll();
    const filtered = workflows.filter(w => w.id !== id);
    this.saveAll(filtered);
    this.unscheduleWorkflow(id);
    return { ok: true };
  }

  // Запустить все scheduled workflows при старте
  startAll() {
    if (this.running) return;
    this.running = true;
    const workflows = this.loadAll();
    for (const wf of workflows) {
      if (wf.enabled && wf.trigger !== 'manual') {
        this.scheduleWorkflow(wf);
      }
    }
    console.log(`✓ Workflow Engine: ${workflows.length} workflows loaded`);
  }

  // Остановить все scheduled workflows
  stopAll() {
    for (const [id, handle] of this.scheduledJobs) {
      clearInterval(handle);
      clearTimeout(handle);
    }
    this.scheduledJobs.clear();
    this.running = false;
  }

  // Запланировать workflow
  scheduleWorkflow(wf) {
    if (!wf.trigger || wf.trigger === 'manual') return;

    // interval:N — каждые N минут
    if (wf.trigger.startsWith('interval:')) {
      const mins = parseInt(wf.trigger.split(':')[1]) || 60;
      const handle = setInterval(() => this.run(wf.id), mins * 60 * 1000);
      this.scheduledJobs.set(wf.id, handle);
      console.log(`⏰ Workflow "${wf.name}" scheduled every ${mins} min`);
      return;
    }

    // schedule:HH:MM — каждый день в конкретное время
    if (wf.trigger.startsWith('schedule:')) {
      const timePart = wf.trigger.split(':').slice(1).join(':'); // HH:MM
      const [hh, mm] = timePart.split(':').map(Number);
      const scheduleNext = () => {
        const now = new Date();
        const next = new Date();
        next.setHours(hh, mm, 0, 0);
        if (next <= now) next.setDate(next.getDate() + 1);
        const delay = next - now;
        const handle = setTimeout(() => {
          this.run(wf.id);
          scheduleNext(); // reschedule for tomorrow
        }, delay);
        this.scheduledJobs.set(wf.id, handle);
        console.log(`⏰ Workflow "${wf.name}" scheduled at ${timePart} (in ${Math.round(delay/60000)} min)`);
      };
      scheduleNext();
      return;
    }
  }

  // Отменить расписание workflow
  unscheduleWorkflow(id) {
    const handle = this.scheduledJobs.get(id);
    if (handle) {
      clearInterval(handle);
      clearTimeout(handle);
      this.scheduledJobs.delete(id);
    }
  }

  // Выполнить workflow
  async run(id, onStep = null) {
    const workflows = this.loadAll();
    const wf = workflows.find(w => w.id === id);
    if (!wf) return { ok: false, error: 'Workflow not found' };
    if (!wf.enabled) return { ok: false, error: 'Workflow is disabled' };

    const results = [];
    let success = true;

    for (const step of (wf.steps || [])) {
      try {
        const result = await this.executeStep(step, onStep);
        results.push({ step: step.action || step.type, result, ok: result.ok !== false });
        if (onStep) onStep({ step: step.action || step.type, result });
        if (result.ok === false && step.stopOnError) {
          success = false;
          break;
        }
        // Small delay between steps
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        results.push({ step: step.action || step.type, error: e.message, ok: false });
        if (step.stopOnError) { success = false; break; }
      }
    }

    // Update last run
    const idx = workflows.findIndex(w => w.id === id);
    if (idx !== -1) {
      workflows[idx].lastRun = new Date().toISOString();
      workflows[idx].runCount = (workflows[idx].runCount || 0) + 1;
      this.saveAll(workflows);
    }

    // Notification
    try {
      new Notification({
        title: `◈ Horizon — Workflow`,
        body: `"${wf.name}" ${success ? 'выполнен ✅' : 'завершён с ошибкой ⚠️'}`
      }).show();
    } catch {}

    return { ok: success, workflowName: wf.name, results };
  }

  // Выполнить один шаг workflow
  async executeStep(step, onStep) {
    const { exec } = require('child_process');
    const IS_WIN = process.platform === 'win32';
    const IS_MAC = process.platform === 'darwin';

    function sh(cmd) {
      return new Promise(r => exec(cmd, { timeout: 15000 }, (e, o, er) => r({ ok: !e, out: (o || '').trim(), err: (er || '').trim() })));
    }

    // Support both {type, params} and {action, args} formats
    const type = step.type || step.action || 'shell';
    const action = step.action || step.type || '';
    const params = step.params || step.args || {};

    switch (type) {
      case 'open_url': {
        const url = params.url || action;
        if (IS_WIN) return sh(`start "" "${url}"`);
        if (IS_MAC) return sh(`open "${url}"`);
        return sh(`xdg-open "${url}"`);
      }

      case 'close_app': {
        const app = params.app || action;
        if (IS_WIN) return sh(`taskkill /F /IM "${app}.exe" 2>nul || echo done`);
        if (IS_MAC) return sh(`osascript -e 'tell application "${app}" to quit' 2>/dev/null; echo done`);
        return sh(`pkill -f "${app}" 2>/dev/null; echo done`);
      }

      case 'open_app': {
        const app = params.app || action;
        if (IS_WIN) return sh(`start "" "${app}"`);
        if (IS_MAC) return sh(`open -a "${app}"`);
        return sh(`${app} &`);
      }

      case 'shell': {
        const cmd = params.command || action;
        if (!cmd) return { ok: false, error: 'No command specified' };
        return sh(cmd);
      }

      case 'notify': {
        const title = params.title || 'Horizon Workflow';
        const body = params.body || action;
        try {
          new Notification({ title: `◈ ${title}`, body }).show();
          return { ok: true, out: 'Notification sent' };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }

      case 'wait': {
        const ms = params.ms || (params.seconds || 1) * 1000;
        await new Promise(r => setTimeout(r, ms));
        return { ok: true, out: `Waited ${ms}ms` };
      }

      case 'speak': {
        // TTS handled by renderer
        return { ok: true, out: 'speak:' + (params.text || '') };
      }

      case 'send_message': {
        return { ok: true, out: 'message:' + (params.text || '') };
      }

      case 'run_code': {
        const code = params.code || '';
        const lang = params.language || 'node';
        if (!code) return { ok: false, error: 'No code specified' };
        if (lang === 'node' || lang === 'javascript') {
          try { const r = eval(code); return { ok: true, out: String(r || 'done') }; }
          catch(e) { return { ok: false, error: e.message }; }
        }
        return sh(code);
      }

      case 'clipboard_read': {
        const { clipboard } = require('electron');
        return { ok: true, out: clipboard.readText() };
      }

      case 'clipboard_write': {
        const { clipboard } = require('electron');
        clipboard.writeText(params.text || '');
        return { ok: true, out: 'Clipboard updated' };
      }

      case 'plugin': {
        const pluginId = params.pluginId || '';
        const toolName = params.tool || '';
        const toolArgs = params.args || {};
        if (!this.pluginManager) return { ok: false, error: 'Plugin manager not available' };
        return this.pluginManager.executeTool(pluginId, toolName, toolArgs);
      }

      case 'type_text': {
        const text = params.text || action;
        if (IS_WIN) {
          const esc = text.replace(/'/g, "''");
          return sh(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 300; [System.Windows.Forms.SendKeys]::SendWait('${esc.replace(/[+^%~(){}[\]]/g, '{$&}')}')"`);
        }
        if (IS_MAC) return sh(`osascript -e 'tell application "System Events" to keystroke "${text.replace(/"/g, '\\"')}"'`);
        return sh(`xdotool type --clearmodifiers --delay 20 '${text}'`);
      }

      case 'screenshot': {
        // Handled by main process via IPC, return placeholder
        return { ok: true, out: 'Screenshot requested' };
      }

      default:
        return { ok: false, error: `Unknown step type: ${type}` };
    }
  }

  // Создать workflow из текстового описания (AI-generated)
  static parseAIWorkflow(aiJson) {
    try {
      const data = typeof aiJson === 'string' ? JSON.parse(aiJson) : aiJson;
      return {
        name: data.name || 'Новый Workflow',
        description: data.description || '',
        trigger: data.trigger || 'manual',
        steps: (data.steps || []).map(s => ({
          type: s.type || 'shell',
          action: s.action || '',
          params: s.params || {},
          stopOnError: s.stopOnError || false
        }))
      };
    } catch (e) {
      return null;
    }
  }

  // Получить примеры workflows для показа пользователю
  static getExampleWorkflows() {
    return [
      {
        name: '🌐 Открыть YouTube',
        description: 'Открывает YouTube в браузере',
        trigger: 'manual',
        steps: [
          { type: 'open_url', action: 'https://youtube.com', params: { url: 'https://youtube.com' } },
          { type: 'notify', action: 'YouTube открыт!', params: { title: 'Workflow', body: 'YouTube открыт!' } }
        ]
      },
      {
        name: '🌅 Утренний старт',
        description: 'Каждое утро в 9:00 открывает почту и новости',
        trigger: 'schedule:09:00',
        steps: [
          { type: 'open_url', params: { url: 'https://gmail.com' } },
          { type: 'wait', params: { seconds: 2 } },
          { type: 'open_url', params: { url: 'https://news.google.com' } },
          { type: 'notify', params: { title: 'Утренний старт', body: 'Почта и новости открыты!' } }
        ]
      },
      {
        name: '🔒 Вечерняя уборка',
        description: 'Каждый день в 22:00 закрывает браузер',
        trigger: 'schedule:22:00',
        steps: [
          { type: 'close_app', params: { app: 'chrome' } },
          { type: 'close_app', params: { app: 'msedge' } },
          { type: 'notify', params: { title: 'Вечерняя уборка', body: 'Браузер закрыт. Хорошего вечера!' } }
        ]
      },
      {
        name: '📊 Мониторинг каждые 30 мин',
        description: 'Каждые 30 минут проверяет статус системы',
        trigger: 'interval:30',
        steps: [
          { type: 'plugin', params: { pluginId: 'system-monitor', tool: 'status', args: {} } },
          { type: 'notify', params: { title: 'System Check', body: 'Проверка системы выполнена' } }
        ]
      },
      {
        name: '🎵 Включить музыку',
        description: 'Открывает Spotify и включает воспроизведение',
        trigger: 'manual',
        steps: [
          { type: 'open_app', params: { app: 'Spotify' } },
          { type: 'wait', params: { seconds: 3 } },
          { type: 'plugin', params: { pluginId: 'spotify-control', tool: 'play', args: {} } }
        ]
      }
    ];
  }
}

module.exports = { WorkflowEngine };

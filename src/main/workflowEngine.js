'use strict';
/**
 * Horizon AI v2 - Workflow Engine
 *
 * Supports manual workflows, scheduled workflows, wake-word triggers, and
 * AI-assisted workflow creation. Keep user-visible text here plain ASCII so
 * corrupted legacy encodings never leak into notifications or examples.
 */

const { Notification, app, desktopCapturer, shell } = require('electron');
const fs = require('fs');
const path = require('path');

class WorkflowEngine {
  constructor(store, pluginManager) {
    this.store = store;
    this.pluginManager = pluginManager;
    this.scheduledJobs = new Map(); // workflowId -> interval/timeout handle
    this.running = false;
    // Active-runs ledger so the renderer can render the Workflows graph view.
    // Each entry: { runId, workflowId, name, startedAt, currentStep, totalSteps,
    //               steps: [{action, status:'pending|running|done|failed', startedAt, endedAt, error}] }
    this.activeRuns = new Map();
    // Optional listeners — set by main.js via setEventBridge() so we can
    // forward workflow:running:start / step / end events to the renderer
    // without holding a hard dependency on Electron's webContents here.
    this.eventBridge = null;
    this.permissionHook = null;
  }

  // main.js calls this once after constructing the engine.
  setEventBridge(fn) {
    this.eventBridge = typeof fn === 'function' ? fn : null;
  }

  setPermissionHook(fn) {
    this.permissionHook = typeof fn === 'function' ? fn : null;
  }

  emit(event, payload) {
    if (this.eventBridge) {
      try { this.eventBridge(event, payload); } catch (_) {}
    }
  }

  // Snapshot of currently-running runs (for `workflowActiveRuns` IPC).
  getActiveRuns() {
    return Array.from(this.activeRuns.values()).map((r) => ({ ...r, steps: [...r.steps] }));
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
    if (wf.trigger === 'startup') {
      const handle = setTimeout(() => this.run(wf.id), 1500);
      this.scheduledJobs.set(wf.id, handle);
      console.log(`Workflow "${wf.name}" scheduled on startup`);
      return;
    }

    // interval:N — каждые N минут
    if (wf.trigger.startsWith('interval:')) {
      const mins = parseInt(wf.trigger.split(':')[1]) || 60;
      const handle = setInterval(() => this.run(wf.id), mins * 60 * 1000);
      this.scheduledJobs.set(wf.id, handle);
      console.log(`⏰ Workflow "${wf.name}" scheduled every ${mins} min`);
      return;
    }

    // schedule:HH:MM — каждый день в конкретное время
    if (wf.trigger.startsWith('cron:')) {
      const expr = wf.trigger.slice('cron:'.length).trim();
      const parts = expr.split(/\s+/);
      const mm = Number(parts[0]);
      const hh = Number(parts[1]);
      if (Number.isFinite(hh) && Number.isFinite(mm)) {
        wf = { ...wf, trigger: `schedule:${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` };
      } else {
        console.warn(`Workflow "${wf.name}" has unsupported cron expression: ${expr}`);
        return;
      }
    }

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
  async run(id, onStep = null, opts = {}) {
    const workflows = this.loadAll();
    const wf = workflows.find(w => w.id === id);
    if (!wf) return { ok: false, error: 'Workflow not found' };
    if (!wf.enabled) return { ok: false, error: 'Workflow is disabled' };

    const results = [];
    let success = true;

    // Live run-state object — pushed to renderer as the graph mutates.
    const runId = 'run_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const startedAt = Date.now();
    const stepsState = (wf.steps || []).map((s) => ({
      action: s.action || s.type || 'shell',
      status: 'pending',
      startedAt: null,
      endedAt: null,
      error: null
    }));
    const liveRun = {
      runId,
      workflowId: id,
      name: wf.name,
      startedAt,
      currentStep: -1,
      totalSteps: stepsState.length,
      steps: stepsState
    };
    this.activeRuns.set(runId, liveRun);
    this.emit('workflow:running:start', { ...liveRun });

    for (let i = 0; i < (wf.steps || []).length; i++) {
      const step = wf.steps[i];
      liveRun.currentStep = i;
      liveRun.steps[i].status = 'running';
      liveRun.steps[i].startedAt = Date.now();
      this.emit('workflow:running:step', { runId, stepIndex: i, status: 'running' });

      try {
        const permission = await this.requestStepPermission(wf, step, i, runId, opts);
        if (permission && permission.ok === false) {
          const deniedResult = { ok: false, error: permission.error || 'Denied by user', denied: true };
          results.push({ step: step.action || step.type, result: deniedResult, ok: false });
          liveRun.steps[i].status = 'failed';
          liveRun.steps[i].endedAt = Date.now();
          liveRun.steps[i].error = deniedResult.error;
          this.emit('workflow:running:step', { runId, stepIndex: i, status: 'failed', error: deniedResult.error });
          success = false;
          break;
        }

        const result = await this.executeStep(step, onStep);
        const stepOk = result.ok !== false;
        results.push({ step: step.action || step.type, result, ok: stepOk });
        liveRun.steps[i].status = stepOk ? 'done' : 'failed';
        liveRun.steps[i].endedAt = Date.now();
        if (!stepOk) liveRun.steps[i].error = result.error || 'failed';
        this.emit('workflow:running:step', { runId, stepIndex: i, status: liveRun.steps[i].status });

        if (onStep) onStep({ step: step.action || step.type, result });
        if (result.ok === false && step.stopOnError) {
          success = false;
          break;
        }
        // Small delay between steps
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        results.push({ step: step.action || step.type, error: e.message, ok: false });
        liveRun.steps[i].status = 'failed';
        liveRun.steps[i].endedAt = Date.now();
        liveRun.steps[i].error = e.message;
        this.emit('workflow:running:step', { runId, stepIndex: i, status: 'failed' });
        if (step.stopOnError) { success = false; break; }
      }
    }

    const endedAt = Date.now();
    const duration = endedAt - startedAt;

    // Update lastRun + runCount + success/fail counters + rolling avg duration.
    const idx = workflows.findIndex(w => w.id === id);
    if (idx !== -1) {
      const prevRun = workflows[idx].runCount || 0;
      const prevAvg = workflows[idx].avgDuration || 0;
      workflows[idx].lastRun = new Date(endedAt).toISOString();
      workflows[idx].lastRunDuration = duration;
      workflows[idx].lastRunOk = success;
      workflows[idx].runCount = prevRun + 1;
      workflows[idx].successCount = (workflows[idx].successCount || 0) + (success ? 1 : 0);
      workflows[idx].failCount = (workflows[idx].failCount || 0) + (success ? 0 : 1);
      // Cumulative-moving-average duration. Cheap, no per-run history bloat.
      workflows[idx].avgDuration = Math.round(((prevAvg * prevRun) + duration) / (prevRun + 1));
      this.saveAll(workflows);
    }

    this.activeRuns.delete(runId);
    this.emit('workflow:running:end', { runId, workflowId: id, ok: success, duration });

    // Notification
    try {
      new Notification({
        title: 'Horizon Workflow',
        body: `"${wf.name}" ${success ? 'completed' : 'finished with errors'}`
      }).show();
    } catch {}

    return { ok: success, workflowName: wf.name, results, duration };
  }

  workflowPermissionTool(step) {
    const type = step.type || step.action || 'shell';
    const params = step.params || step.args || {};
    if (type === 'shell' || type === 'run_code') return 'shell_command';
    if (type === 'plugin') {
      const pluginId = params.pluginId || 'plugin';
      const toolName = params.tool || 'run';
      try {
        const manifest = this.pluginManager?.plugins?.get?.(pluginId) || {};
        const spec = (manifest.tools || []).find(t => t && t.name === toolName);
        if (spec?.action) return `${pluginId}__${spec.action}`;
      } catch (_) {}
      return `${pluginId}__${toolName}`;
    }
    if (type === 'open_url' || type === 'open_site') return 'browser.open';
    if (type === 'open_app' || type === 'close_app') return `app.${type}`;
    if (type === 'type_text' || type === 'press_key') return `computer.${type}`;
    if (type === 'clipboard_write') return 'clipboard.write';
    if (type === 'notify' || type === 'wait' || type === 'speak' || type === 'send_message' || type === 'clipboard_read') return type;
    return `workflow.${type}`;
  }

  workflowPermissionArgs(step) {
    const type = step.type || step.action || 'shell';
    const params = step.params || step.args || {};
    if (type === 'shell') return { ...params, command: params.command || step.action || '' };
    if (type === 'run_code') return { ...params, command: params.code || step.action || '', language: params.language || 'node' };
    if (type === 'open_url' || type === 'open_site') return { ...params, url: params.url || step.action || '' };
    if (type === 'open_app' || type === 'close_app') return { ...params, target: params.app || step.action || '' };
    return params;
  }

  async requestStepPermission(workflow, step, stepIndex, runId, opts = {}) {
    if (!this.permissionHook) return { ok: true };
    const tool = this.workflowPermissionTool(step);
    const args = this.workflowPermissionArgs(step);
    return this.permissionHook({
      sender: opts.sender || null,
      tool,
      args,
      reason: `Workflow "${workflow.name}" step ${stepIndex + 1}/${(workflow.steps || []).length}`,
      workflowId: workflow.id,
      workflowName: workflow.name,
      runId,
      stepIndex,
      step,
    });
  }

  // Выполнить один шаг workflow
  async executeStep(step, onStep) {
    const { exec, execFile } = require('child_process');
    const IS_WIN = process.platform === 'win32';
    const IS_MAC = process.platform === 'darwin';

    function sh(cmd) {
      return new Promise(r => exec(cmd, { timeout: 15000 }, (e, o, er) => r({ ok: !e, out: (o || '').trim(), err: (er || '').trim() })));
    }

    function runNode(code) {
      return new Promise((resolve) => {
        execFile(
          process.env.HORIZON_NODE_PATH || 'node',
          ['-e', String(code)],
          { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 },
          (e, o, er) => resolve({
            ok: !e,
            out: (o || '').trim() || (!e ? 'done' : ''),
            err: (er || '').trim(),
            error: e ? (e.message || 'Node execution failed') : undefined
          })
        );
      });
    }

    // Support both {type, params} and {action, args} formats
    const type = step.type || step.action || 'shell';
    const action = step.action || step.type || '';
    const params = step.params || step.args || {};

    switch (type) {
      case 'open_url': {
        const url = params.url || action;
        if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'open_url requires http(s) URL' };
        try {
          await shell.openExternal(String(url));
          return { ok: true, out: `Opened ${url}` };
        } catch (e) {
          return { ok: false, error: e.message };
        }
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
        const body = params.body || params.message || action;
        try {
          new Notification({ title: String(title), body: String(body || '') }).show();
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
          return runNode(code);
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

      case 'press_key': {
        const key = params.key || params.keys || action;
        if (!key) return { ok: false, error: 'No key specified' };
        if (IS_WIN) {
          const esc = String(key).replace(/'/g, "''");
          return sh(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 150; [System.Windows.Forms.SendKeys]::SendWait('${esc}')"`);
        }
        if (IS_MAC) return sh(`osascript -e 'tell application "System Events" to keystroke "${String(key).replace(/"/g, '\\"')}"'`);
        return sh(`xdotool key ${String(key).replace(/[^a-zA-Z0-9_+.-]/g, '')}`);
      }

      case 'screenshot': {
        try {
          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 1920, height: 1080 }
          });
          if (!sources.length) return { ok: false, error: 'No screen source available' };
          const dir = path.join(app.getPath('userData'), 'workflow-screenshots');
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `workflow-${Date.now()}.png`);
          const buf = sources[0].thumbnail.toPNG();
          fs.writeFileSync(file, buf);
          return { ok: true, out: `Screenshot saved: ${file}`, path: file, base64: buf.toString('base64') };
        } catch (e) {
          return { ok: false, error: e.message };
        }
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
        name: data.name || 'New Workflow',
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
        name: 'Open YouTube',
        description: 'Opens YouTube in the browser and confirms when it is ready.',
        trigger: 'manual',
        steps: [
          { type: 'open_url', action: 'https://youtube.com', params: { url: 'https://youtube.com' } },
          { type: 'notify', action: 'YouTube opened', params: { title: 'Workflow', body: 'YouTube opened.' } }
        ]
      },
      {
        name: 'Morning start',
        description: 'Opens mail and news every morning at 09:00.',
        trigger: 'schedule:09:00',
        steps: [
          { type: 'open_url', params: { url: 'https://gmail.com' } },
          { type: 'wait', params: { seconds: 2 } },
          { type: 'open_url', params: { url: 'https://news.google.com' } },
          { type: 'notify', params: { title: 'Morning start', body: 'Mail and news are open.' } }
        ]
      },
      {
        name: 'Evening cleanup',
        description: 'Closes common browsers every day at 22:00.',
        trigger: 'schedule:22:00',
        steps: [
          { type: 'close_app', params: { app: 'chrome' } },
          { type: 'close_app', params: { app: 'msedge' } },
          { type: 'notify', params: { title: 'Evening cleanup', body: 'Browsers were closed.' } }
        ]
      },
      {
        name: 'System check every 30 minutes',
        description: 'Runs the built-in system monitor every 30 minutes.',
        trigger: 'interval:30',
        steps: [
          { type: 'plugin', params: { pluginId: 'system-monitor', tool: 'status', args: {} } },
          { type: 'notify', params: { title: 'System Check', body: 'System check completed.' } }
        ]
      },
      {
        name: 'Start music',
        description: 'Opens Spotify and starts playback when the Spotify plugin is configured.',
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

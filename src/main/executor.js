'use strict';
/**
 * Horizon Code Executor — host or Docker sandbox.
 *
 * Routes the existing `run_code` / `run_shell` / `run_powershell` tool
 * calls through a swappable backend so the user can opt into Docker
 * isolation for shell.exec without giving up the speed of host execution
 * for trusted code.
 *
 * Three modes (settingsStore key `executionMode`):
 *   - `host`   : current behaviour, spawn directly on the user's machine.
 *   - `docker` : pipe code into a fresh container per call. Image picked
 *                per language; workspace mount controlled by
 *                `dockerWorkspaceMount` ('none'|'read-only'|'read-write').
 *   - `ask`    : reserved for v2 (UI confirmation per call). For now we
 *                treat 'ask' as 'host' to keep things simple — the agent
 *                already routes shell calls through withPermission().
 *
 * Docker availability is probed once on Executor construction; if the
 * docker CLI is absent we silently fall back to host even when mode is
 * 'docker'. UI surfaces this via Executor.status() so the user sees why.
 */

const { execFile, spawn } = require('child_process');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

const DOCKER_IMAGES = {
  python:     'python:3.12-slim',
  python3:    'python:3.12-slim',
  py:         'python:3.12-slim',
  javascript: 'node:20-alpine',
  js:         'node:20-alpine',
  node:       'node:20-alpine',
  shell:      'alpine:latest',
  sh:         'alpine:latest',
  bash:       'alpine:latest',
  cmd:        null,  // cmd doesn't make sense in linux containers
  powershell: 'mcr.microsoft.com/powershell:latest', // 150MB — only pull on demand
};

const DOCKER_CMDS = {
  python:     ['python3', '-'],
  python3:    ['python3', '-'],
  py:         ['python3', '-'],
  javascript: ['node', '-'],
  js:         ['node', '-'],
  node:       ['node', '-'],
  shell:      ['sh', '-'],
  sh:         ['sh', '-'],
  bash:       ['sh', '-'],
  powershell: ['pwsh', '-c', '-'],
};

const MAX_OUTPUT_BYTES = 1024 * 1024;   // 1 MB cap on stdout/stderr
const DEFAULT_TIMEOUT_MS = 30_000;
const DOCKER_RUN_LIMITS = ['--rm', '-i',
  '--memory=512m', '--cpus=1', '--network=none', '--read-only',
  '--tmpfs', '/tmp:rw,exec,size=64m',
];

function describeDockerProbeError(err, cli) {
  if (!err) return '';
  if (err.code === 'ENOENT') return `${cli} not found on PATH`;
  if (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') return `${cli} --version timed out`;
  if (typeof err.code === 'number') return `${cli} --version failed with exit code ${err.code}`;
  if (err.code) return `${cli} --version failed (${err.code})`;
  return `${cli} --version failed`;
}

class Executor {
  constructor(opts = {}) {
    this.settingsStore = opts.settingsStore || null;
    this.workspaceProvider = typeof opts.workspaceProvider === 'function' ? opts.workspaceProvider : () => '';
    this.dockerCli = '';
    this.dockerCheckedAt = 0;
    this.dockerLastError = '';
    this._probeDocker();
  }

  _probeDocker() {
    return new Promise(resolve => {
      const cli = IS_WIN ? 'docker.exe' : 'docker';
      execFile(cli, ['--version'], { timeout: 4000, windowsHide: true }, (err) => {
        if (err) {
          this.dockerCli = '';
          this.dockerLastError = describeDockerProbeError(err, cli);
        } else {
          this.dockerCli = cli;
          this.dockerLastError = '';
        }
        this.dockerCheckedAt = Date.now();
        resolve(Boolean(this.dockerCli));
      });
    });
  }

  dockerAvailable() {
    return Boolean(this.dockerCli);
  }

  _settingMode() {
    const v = this.settingsStore?.get?.('executionMode');
    return v === 'docker' || v === 'ask' ? v : 'host';
  }

  _settingMount() {
    const v = this.settingsStore?.get?.('dockerWorkspaceMount');
    return v === 'read-write' || v === 'read-only' ? v : 'none';
  }

  status() {
    return {
      mode: this._settingMode(),
      mount: this._settingMount(),
      dockerAvailable: this.dockerAvailable(),
      dockerLastError: this.dockerLastError,
      dockerCheckedAt: this.dockerCheckedAt ? new Date(this.dockerCheckedAt).toISOString() : null,
      supportedLanguages: Object.keys(DOCKER_IMAGES).filter(k => DOCKER_IMAGES[k]),
    };
  }

  /**
   * Run `code` in the chosen language. Returns {ok, out, err, ...meta}.
   * `opts.timeout` ms, `opts.executionMode` to override the global
   * setting (e.g. for tests).
   */
  async run(code, language, opts = {}) {
    const lang = String(language || 'shell').toLowerCase();
    const requestedMode = opts.executionMode || this._settingMode();
    const wantDocker = requestedMode === 'docker' && this.dockerAvailable() && DOCKER_IMAGES[lang];
    if (wantDocker) {
      return this._runDocker(code, lang, opts);
    }
    if (requestedMode === 'docker' && !this.dockerAvailable()) {
      // Fall through to host but flag in the response so the agent + UI
      // can tell the user docker isn't installed.
      const r = await this._runHost(code, lang, opts);
      return { ...r, fallback: 'host', reason: 'docker not available — install Docker to enable sandboxed execution' };
    }
    return this._runHost(code, lang, opts);
  }

  _runHost(code, language, opts) {
    // Delegate to the existing host executor in agent.js to keep its
    // platform-specific quirks (Windows powershell.exe path, etc.) in
    // one place. The agent module exports executeCode; we require it
    // lazily to avoid a circular import at module-load time.
    const agent = require('./agent');
    return Promise.resolve(agent.executeCode(code, language, opts?.timeout));
  }

  _runDocker(code, language, opts) {
    const image = DOCKER_IMAGES[language];
    const cmd = DOCKER_CMDS[language];
    if (!image || !cmd) {
      return Promise.resolve({ ok: false, err: `docker: unsupported language "${language}"` });
    }
    const timeoutMs = Math.max(2000, Math.min(120_000, Number(opts?.timeout) || DEFAULT_TIMEOUT_MS));

    const args = [...DOCKER_RUN_LIMITS];
    // Optional workspace mount — disabled by default. Read-only is the
    // safe choice; users who want the agent to write must opt in.
    const mount = this._settingMount();
    if (mount !== 'none') {
      const ws = this.workspaceProvider();
      if (ws) {
        const flag = mount === 'read-write' ? ':rw' : ':ro';
        // Override --read-only when we want to allow writes.
        if (mount === 'read-write') {
          const idx = args.indexOf('--read-only');
          if (idx >= 0) args.splice(idx, 1);
        }
        args.push('-v', `${ws}:/workspace${flag}`, '-w', '/workspace');
      }
    }
    args.push(image, ...cmd);

    return new Promise(resolve => {
      const child = spawn(this.dockerCli, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      let killed = false;
      const killTimer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGKILL'); } catch (_) {}
      }, timeoutMs);
      child.stdout.on('data', d => {
        stdout += d.toString();
        if (stdout.length > MAX_OUTPUT_BYTES) {
          stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + '\n[stdout truncated]';
          try { child.kill('SIGKILL'); } catch (_) {}
        }
      });
      child.stderr.on('data', d => {
        stderr += d.toString();
        if (stderr.length > MAX_OUTPUT_BYTES) {
          stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + '\n[stderr truncated]';
        }
      });
      child.on('error', e => {
        clearTimeout(killTimer);
        resolve({ ok: false, err: 'docker spawn failed: ' + e.message, mode: 'docker' });
      });
      child.on('exit', (code, sig) => {
        clearTimeout(killTimer);
        if (killed) return resolve({ ok: false, err: `docker exec timed out after ${timeoutMs}ms`, out: stdout.trim(), stderr: stderr.trim(), mode: 'docker' });
        const ok = code === 0;
        resolve({
          ok,
          out: stdout.trim(),
          err: ok ? '' : (stderr.trim() || `docker exit ${code}`),
          stderr: stderr.trim(),
          exitCode: code,
          mode: 'docker',
          image,
        });
      });
      // Pipe the code through stdin — image base commands all read from `-`.
      try { child.stdin.write(String(code || '')); child.stdin.end(); }
      catch (e) {
        clearTimeout(killTimer);
        resolve({ ok: false, err: 'failed to write stdin to docker: ' + e.message, mode: 'docker' });
      }
    });
  }
}

module.exports = { Executor, DOCKER_IMAGES, DOCKER_RUN_LIMITS };

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
    return ['docker','ssh','modal','daytona','ask'].includes(v) ? v : 'host';
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
      sshHost: this.settingsStore?.get?.('ssh.host') || null,
      sshConfigured: !!this.settingsStore?.get?.('ssh.host'),
      modalConfigured: !!(this.settingsStore?.get?.('modal.tokenId') && this.settingsStore?.get?.('modal.tokenSecret')),
      daytonaConfigured: !!(this.settingsStore?.get?.('daytona.serverUrl') && this.settingsStore?.get?.('daytona.apiKey') && this.settingsStore?.get?.('daytona.workspaceId')),
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

    if (requestedMode === 'ssh')         return this._runSsh(code, lang, opts);
    if (requestedMode === 'modal')       return this._runModal(code, lang, opts);
    if (requestedMode === 'daytona')     return this._runDaytona(code, lang, opts);
    if (requestedMode === 'singularity') return this._runSingularity(code, lang, opts);

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

  /**
   * Modal (modal.com) — BYOK serverless executor.
   *
   * User provides:
   *   - modal.tokenId       (from `modal token new`)
   *   - modal.tokenSecret
   *   - modal.endpoint      (optional, defaults to https://api.modal.com)
   *   - modal.appName       (optional; we use a default `horizon-exec`)
   *
   * Modal's REST API runs a pre-deployed function. Horizon ships a tiny
   * Python function template the user deploys once with `modal deploy`
   * (template printed by `horizon connect modal --help`). The function
   * accepts {language, code} and returns {stdout, stderr, exitCode}.
   *
   * Falls back gracefully when not configured: a clear error instead
   * of host-mode silent fallback so the user notices and configures.
   */
  async _runModal(code, language, opts) {
    const tokenId     = this.settingsStore?.get?.('modal.tokenId');
    const tokenSecret = this.settingsStore?.get?.('modal.tokenSecret');
    const endpoint    = this.settingsStore?.get?.('modal.endpoint') || 'https://api.modal.com';
    const appName     = this.settingsStore?.get?.('modal.appName') || 'horizon-exec';
    if (!tokenId || !tokenSecret) {
      return {
        ok: false, mode: 'modal',
        err: 'Modal not configured. Run `horizon connect modal --token-id X --token-secret Y` (signup: modal.com).',
      };
    }
    const timeoutMs = Math.max(2000, Math.min(120_000, Number(opts?.timeout) || DEFAULT_TIMEOUT_MS));
    const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');
    try {
      const r = await Promise.race([
        fetch(`${endpoint}/api/v1/apps/${encodeURIComponent(appName)}/run`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Modal-Token-Id': tokenId,
            'Modal-Token-Secret': tokenSecret,
          },
          body: JSON.stringify({ language, code, timeout: Math.floor(timeoutMs / 1000) }),
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('modal request timeout')), timeoutMs + 5000)),
      ]);
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        return { ok: false, mode: 'modal', err: `modal HTTP ${r.status}: ${txt.slice(0, 200)}` };
      }
      const d = await r.json();
      return {
        ok: d.exitCode === 0 || d.exit_code === 0,
        out: String(d.stdout || d.out || '').trim(),
        err: String(d.stderr || d.err || '').trim(),
        exitCode: d.exitCode ?? d.exit_code ?? null,
        mode: 'modal',
        appName,
      };
    } catch (e) {
      return { ok: false, mode: 'modal', err: 'modal call failed: ' + (e.message || String(e)) };
    }
  }

  /**
   * Daytona (daytona.io) — BYOK workspace executor.
   *
   * User provides:
   *   - daytona.serverUrl   (their self-hosted or managed URL)
   *   - daytona.apiKey
   *   - daytona.workspaceId (created beforehand)
   *
   * Hits Daytona's `/workspaces/<id>/exec` endpoint. Same {language,
   * code} shape; Daytona returns {output, exitCode}.
   */
  async _runDaytona(code, language, opts) {
    const serverUrl   = this.settingsStore?.get?.('daytona.serverUrl');
    const apiKey      = this.settingsStore?.get?.('daytona.apiKey');
    const workspaceId = this.settingsStore?.get?.('daytona.workspaceId');
    if (!serverUrl || !apiKey || !workspaceId) {
      return {
        ok: false, mode: 'daytona',
        err: 'Daytona not configured. Run `horizon connect daytona --server X --key Y --workspace Z` (docs: daytona.io).',
      };
    }
    const timeoutMs = Math.max(2000, Math.min(120_000, Number(opts?.timeout) || DEFAULT_TIMEOUT_MS));
    const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');
    // Pick a shell command for the language; Daytona runs whatever shell
    // string we pass in the target workspace.
    const wrappers = {
      python: `python3 -c ${JSON.stringify(code)}`,
      python3: `python3 -c ${JSON.stringify(code)}`,
      js: `node -e ${JSON.stringify(code)}`,
      javascript: `node -e ${JSON.stringify(code)}`,
      node: `node -e ${JSON.stringify(code)}`,
      shell: code,
      sh: code,
      bash: code,
    };
    const command = wrappers[language];
    if (!command) {
      return { ok: false, mode: 'daytona', err: `daytona: unsupported language "${language}"` };
    }
    try {
      const r = await Promise.race([
        fetch(`${serverUrl.replace(/\/$/, '')}/workspaces/${encodeURIComponent(workspaceId)}/exec`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ command, timeout: Math.floor(timeoutMs / 1000) }),
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('daytona request timeout')), timeoutMs + 5000)),
      ]);
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        return { ok: false, mode: 'daytona', err: `daytona HTTP ${r.status}: ${txt.slice(0, 200)}` };
      }
      const d = await r.json();
      return {
        ok: (d.exitCode ?? d.exit_code ?? 0) === 0,
        out: String(d.output || d.stdout || '').trim(),
        err: String(d.stderr || '').trim(),
        exitCode: d.exitCode ?? d.exit_code ?? null,
        mode: 'daytona',
        workspaceId,
      };
    } catch (e) {
      return { ok: false, mode: 'daytona', err: 'daytona call failed: ' + (e.message || String(e)) };
    }
  }

  /**
   * Singularity / Apptainer — HPC container runtime, common on clusters
   * where Docker is blocked. Same idea as Docker mode but spawns
   * `singularity exec <image> sh -c "<runner>"`. Falls back to
   * `apptainer` if `singularity` isn't on PATH (Apptainer is the
   * post-fork name; many distros ship both).
   *
   * Settings (all optional, but at least one is required):
   *   singularity.image   — image URI ("docker://python:3.12-slim",
   *                          "library://sylabs/python", or local .sif)
   *   singularity.bind    — comma-separated host:container bind mounts
   *   singularity.binary  — override binary name (default: auto-detect)
   *
   * Use case: research clusters, HPC grids, anywhere rootless containers
   * are required but Docker isn't allowed.
   */
  async _runSingularity(code, language, opts) {
    const { spawn } = require('child_process');
    const image = this.settingsStore?.get?.('singularity.image');
    if (!image) {
      return {
        ok: false, mode: 'singularity',
        err: 'Singularity image not configured. Set settings: singularity.image = "docker://python:3.12-slim" (or a local .sif path).',
        hint: 'Singularity / Apptainer must be installed. On a cluster: `module load singularity` or `apptainer` is usually pre-loaded.',
      };
    }
    const binary = this.settingsStore?.get?.('singularity.binary')
      || (this._cmdAvailable('singularity') ? 'singularity' : 'apptainer');
    if (!this._cmdAvailable(binary)) {
      return {
        ok: false, mode: 'singularity',
        err: `${binary} not found on PATH. Install Singularity or Apptainer first.`,
      };
    }
    const cmd = DOCKER_CMDS[language] || DOCKER_CMDS.shell;
    const lang = String(language || 'shell').toLowerCase();
    const inlineFlag = (lang === 'python' || lang === 'py') ? '-c'
                    : (lang === 'node' || lang === 'javascript' || lang === 'js') ? '-e'
                    : (lang === 'shell' || lang === 'bash' || lang === 'sh') ? '-c'
                    : '-c';
    const args = ['exec'];
    const bindList = String(this.settingsStore?.get?.('singularity.bind') || '').trim();
    if (bindList) { for (const m of bindList.split(',').map(s => s.trim()).filter(Boolean)) args.push('--bind', m); }
    args.push(image, cmd, inlineFlag, code);
    const timeoutMs = Math.max(1000, opts.timeout || 60000);
    return new Promise((resolve) => {
      let out = '', err = '';
      let killed = false;
      const child = spawn(binary, args, { windowsHide: true });
      const t = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { err += d.toString(); });
      child.on('error', (e) => {
        clearTimeout(t);
        resolve({ ok: false, mode: 'singularity', err: `${binary} spawn failed: ${e.message}` });
      });
      child.on('close', (exitCode) => {
        clearTimeout(t);
        resolve({
          ok: !killed && exitCode === 0,
          mode: 'singularity',
          image,
          out: out.slice(0, 50_000),
          err: err.slice(0, 50_000),
          exitCode,
          timedOut: killed,
        });
      });
    });
  }

  _cmdAvailable(cmd) {
    try {
      const { execSync } = require('child_process');
      const which = process.platform === 'win32' ? 'where' : 'which';
      execSync(`${which} ${cmd}`, { stdio: 'ignore' });
      return true;
    } catch (_) { return false; }
  }

  /**
   * Execute on a remote machine over SSH. Reuses ssh + scp from PATH so
   * we don't need any new native deps. The user's existing ssh-agent or
   * key file handles auth. Use cases:
   *   - run heavy GPU/Docker workloads on a beefy box from your laptop
   *   - put the executor "outside" your laptop's blast radius
   *   - run on a remote VPS while keeping memory/state local
   *
   * Settings reads (all optional, but ssh.host is required):
   *   ssh.host         — user@host or just host
   *   ssh.port         — default 22
   *   ssh.keyPath      — path to private key (else relies on ssh-agent)
   *   ssh.workdir      — remote dir to cd into before running (default $HOME)
   *
   * The remote host needs python3 / node / sh / pwsh available for the
   * matching language. No image pulling, no sandbox — trust your SSH
   * target the same way you'd trust the host shell.
   */
  _runSsh(code, language, opts) {
    const sshHost = this.settingsStore?.get?.('ssh.host') || '';
    if (!sshHost) {
      return Promise.resolve({
        ok: false, mode: 'ssh',
        err: 'SSH host not configured (settings: ssh.host = "user@example.com")',
      });
    }
    const sshPort = this.settingsStore?.get?.('ssh.port');
    const keyPath = this.settingsStore?.get?.('ssh.keyPath');
    const workdir = this.settingsStore?.get?.('ssh.workdir') || '';
    const timeoutMs = Math.max(2000, Math.min(180_000, Number(opts?.timeout) || DEFAULT_TIMEOUT_MS));

    // Map language to remote runner invocation read-from-stdin.
    const runners = {
      python: 'python3 -',
      python3: 'python3 -',
      py: 'python3 -',
      javascript: 'node -',
      js: 'node -',
      node: 'node -',
      shell: 'sh -',
      sh: 'sh -',
      bash: 'bash -',
      powershell: 'pwsh -c -',
    };
    const remoteCmd = runners[language];
    if (!remoteCmd) {
      return Promise.resolve({ ok: false, mode: 'ssh', err: `ssh: unsupported language "${language}"` });
    }

    // Build the ssh command: ssh [-p PORT] [-i KEY] -o BatchMode=yes -o ConnectTimeout=8 USER@HOST 'cd $workdir && <runner>'
    const args = [];
    if (sshPort) args.push('-p', String(sshPort));
    if (keyPath) args.push('-i', keyPath);
    args.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new');
    args.push(sshHost);
    const remoteWrapped = workdir
      ? `cd ${JSON.stringify(workdir)} && ${remoteCmd}`
      : remoteCmd;
    args.push(remoteWrapped);

    return new Promise(resolve => {
      const child = spawn('ssh', args, { windowsHide: true });
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
        const msg = e.code === 'ENOENT'
          ? 'ssh not found on PATH — install OpenSSH client or set up Git Bash'
          : 'ssh spawn failed: ' + e.message;
        resolve({ ok: false, err: msg, mode: 'ssh' });
      });
      child.on('exit', (code) => {
        clearTimeout(killTimer);
        if (killed) {
          return resolve({
            ok: false, mode: 'ssh',
            err: `ssh exec timed out after ${timeoutMs}ms`,
            out: stdout.trim(), stderr: stderr.trim(),
          });
        }
        const ok = code === 0;
        resolve({
          ok,
          out: stdout.trim(),
          err: ok ? '' : (stderr.trim() || `ssh exit ${code}`),
          stderr: stderr.trim(),
          exitCode: code,
          mode: 'ssh',
          host: sshHost,
        });
      });
      try { child.stdin.write(String(code || '')); child.stdin.end(); }
      catch (e) {
        clearTimeout(killTimer);
        resolve({ ok: false, mode: 'ssh', err: 'failed to write to ssh stdin: ' + e.message });
      }
    });
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

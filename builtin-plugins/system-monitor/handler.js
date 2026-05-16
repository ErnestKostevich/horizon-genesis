'use strict';
/**
 * System Monitor — built-in Horizon plugin.
 * Works on every platform without credentials. Uses Node `os` for the
 * always-cheap snapshots and `child_process.exec` for the per-OS shell
 * commands (top procs / disks). No external dependencies.
 */
const os = require('os');
const { exec } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function sh(cmd, timeout = 8000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        out: (stdout || '').trim(),
        err: (stderr || '').trim(),
        error: err ? err.message : null,
      });
    });
  });
}

function fmtBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

function fmtUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h ${m}m`;
  }
  return `${h}h ${m}m`;
}

module.exports = {
  async execute(tool /* , args, ctx */) {
    if (tool === 'status') {
      const cpus = os.cpus();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memPct = Math.round((usedMem / totalMem) * 100);
      const load = os.loadavg();
      return {
        ok: true,
        out: [
          `CPU: ${cpus[0]?.model.trim() || 'unknown'}`,
          `Cores: ${cpus.length}`,
          `RAM: ${fmtBytes(usedMem)} / ${fmtBytes(totalMem)} (${memPct}%)`,
          `Free: ${fmtBytes(freeMem)}`,
          `Platform: ${os.platform()} ${os.release()} (${os.arch()})`,
          `Hostname: ${os.hostname()}`,
          `Uptime: ${fmtUptime(os.uptime())}`,
          IS_WIN ? '' : `Load avg: ${load.map(n => n.toFixed(2)).join(' / ')}`,
        ].filter(Boolean).join('\n'),
      };
    }

    if (tool === 'top_procs') {
      // Top 10 processes by CPU. Different invocations per OS so the user
      // gets readable output regardless of shell flavour.
      if (IS_WIN) {
        // PowerShell sort by CPU works without admin.
        return sh(
          'powershell -NoProfile -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 ProcessName, Id, CPU, WS | Format-Table -AutoSize | Out-String"',
        );
      }
      if (IS_MAC) {
        return sh('ps -A -o pid,%cpu,%mem,comm | sort -k2 -nr | head -11');
      }
      // Linux
      return sh('ps -eo pid,%cpu,%mem,comm --sort=-%cpu | head -11');
    }

    if (tool === 'disk_info') {
      if (IS_WIN) {
        // Phase 2 fix — previous PowerShell pipeline used Get-PSDrive
        // which returns NaN for $_.Used on network/mapped drives and
        // breaks the Format-Table output. Switched to Get-CimInstance
        // Win32_LogicalDisk which is more reliable + faster + works
        // without elevation. Filter out non-fixed/removable drives.
        return sh(
          'powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk -Filter \'DriveType=3 OR DriveType=2\' | Select-Object DeviceID, @{N=\'UsedGB\';E={[math]::Round(($_.Size - $_.FreeSpace)/1GB,2)}}, @{N=\'FreeGB\';E={[math]::Round($_.FreeSpace/1GB,2)}}, @{N=\'TotalGB\';E={[math]::Round($_.Size/1GB,2)}}, @{N=\'UsedPct\';E={if($_.Size -gt 0){[math]::Round((($_.Size - $_.FreeSpace)/$_.Size)*100,1)}else{0}}} | Format-Table -AutoSize | Out-String"',
        );
      }
      return sh('df -h 2>/dev/null');
    }

    if (tool === 'network') {
      const ifaces = os.networkInterfaces();
      const lines = [];
      for (const [name, addrs] of Object.entries(ifaces)) {
        for (const a of addrs || []) {
          if (a.internal) continue;
          lines.push(`${name}: ${a.family} ${a.address} ${a.mac || ''}`);
        }
      }
      return { ok: true, out: lines.length ? lines.join('\n') : 'No external network interfaces' };
    }

    return { ok: false, error: `Unknown tool: ${tool}` };
  },
};

---
name: server-health
description: |
  Diagnose a server — check CPU, memory, disk, network, key processes,
  and recent logs — then report what's healthy, what's degraded, and
  what to look at next. Activate when the user says "is the server ok",
  "check server health", "the server feels slow", "diagnose this box",
  or shares a server hostname for inspection.
license: BUSL-1.1
metadata:
  category: ops
  version: 1.0.0
  author: Horizon AI
---

# Server health

"The server is slow" is the user's report. "CPU steal time spiking from
a noisy neighbor since 14:02" is the actual finding. This skill runs a
disciplined sweep across the standard health surfaces and reports
what's degraded with enough context to act. Use `run_shell` for
diagnostics commands.

## Procedure

1. **Confirm access and identity.** What server? SSH-reachable?
   What OS (Linux, BSD, Windows)? Many of the commands below are
   Linux-specific — check `uname -a` first. If not reachable, ask
   for log access instead.
2. **Quick triage — 5 commands.** Run these first to get the shape
   of the problem in under a minute:
   - `uptime` — load average vs CPU count
   - `free -h` — memory used/available, swap
   - `df -h` — disk space per mount
   - `ps aux --sort=-%cpu | head` — top CPU consumers
   - `ss -tnp | head` or `netstat -tnp` — open ports and connections
3. **CPU deep-check (if load avg > CPU count or top process > 50%):**
   - `top -bn1` for a snapshot
   - `mpstat 1 5` for per-core usage
   - Check steal time (`%st`) — if non-zero on a VM, the hypervisor is
     contended (not your problem to solve, but worth knowing)
   - `iotop` if I/O-bound suspected
4. **Memory deep-check (if free memory < 10% or swap actively used):**
   - `free -h` again to confirm
   - `ps aux --sort=-%mem | head` for top memory consumers
   - Check OOM killer history: `dmesg | grep -i kill` or
     `journalctl -k | grep -i oom`
5. **Disk deep-check (if any mount > 85% full):**
   - `du -h --max-depth=1 /<mount> | sort -hr | head` to find the
     biggest directories
   - Don't auto-delete anything. Report findings only.
   - Watch for `/var/log` growth — old logs are a common cause
6. **Network deep-check (if connections look wrong or services
   report timeouts):**
   - `ss -s` for socket summary
   - `ping <known-host>` for basic reachability
   - Check `iptables -L` or `nft list ruleset` if firewall recently
     changed
7. **Service status.** For named services (nginx, postgres, redis,
   etc.): `systemctl status <service>`, then tail `journalctl -u
   <service> --since "1 hour ago"`.
8. **Recent logs.** Use the `log-analyzer` skill's approach on
   `/var/log/syslog`, `/var/log/messages`, or `journalctl --since
   "1 hour ago"`. Cluster errors, surface top patterns.
9. **Report.** Group findings by severity:
   ```
   ## <hostname> — health check at <time>

   ### Critical
   - <finding>: <command output snippet>

   ### Degraded
   - ...

   ### Healthy
   - CPU 18% / load 0.6 — fine
   - Memory 4.2G/16G — fine
   - Disks all <70% — fine

   ### Next steps
   1. <specific action>
   2. ...
   ```

## Anti-patterns to avoid

- Don't kill processes without asking.
- Don't delete log files to free disk space without confirming with
  the user — those logs may be evidence of the current incident.
- Don't restart services without permission. "Have you tried turning
  it off and on" loses data if a queue is mid-flight.
- Don't report "all healthy" if you didn't actually run the checks.

## Example invocations

> User: "api-prod-3 feels slow, take a look"

Response: ssh in, run triage 5; load avg 12 on 4-CPU box, memory
ok, disk ok; deep-check CPU shows %st at 38% — hypervisor steal.
Report: "Critical: CPU steal 38% — noisy neighbor on the hypervisor.
Not fixable from inside the VM. Suggest: page the cloud team or
migrate the workload to a less contended host. Confirm by checking
cloud provider's status."

> User: "Is db-replica-2 ok? It's been throwing connection errors"

Response: ssh in, triage shows CPU and memory fine, but `/var` is
at 94% — disk full. Deep-check `/var/log/postgresql/` has 38GB of
log files, oldest 6 months. Recent journalctl shows postgres
refusing connections starting 14:18. Report: "Critical: /var at
94% — postgres is rejecting new connections because it can't write
WAL temp files. Healthy: CPU 12%, memory 6G/16G, network normal.
Next steps: 1) rotate postgres logs (suggested command shown but
not executed), 2) confirm log retention policy with the user before
deleting, 3) restart postgres once disk is clear. Do NOT auto-delete
the logs — they may be needed for the current incident's RCA."

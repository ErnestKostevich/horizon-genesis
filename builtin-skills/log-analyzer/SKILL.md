---
name: log-analyzer
description: |
  Tail, grep, and diagnose error patterns in application or server logs.
  Activate when the user says "look at the logs", "what's wrong in
  production", "tail this log", "grep for errors", "summarize this
  logfile", "find the pattern", or shares a logfile path or excerpt.
license: BUSL-1.1
metadata:
  category: code
  version: 1.0.0
  author: Horizon AI
---

# Log analyzer

Logs are noisy. The signal is in the pattern, not the individual line.
This skill clusters errors by signature and surfaces the top few. Use
`run_shell` for tail/grep/awk, `read_file` for static log dumps.

## Procedure

1. **Locate the log.** Ask which file or service. Common spots:
   `/var/log/`, `journalctl -u <unit>`, `docker logs <container>`,
   `pm2 logs`, `kubectl logs <pod>`, app-specific `logs/*.log`.
2. **Scope the window.** Default to the last hour. For incident
   investigation, ask for the start-of-impact timestamp and pull
   ±15 minutes around it.
3. **Detect the format.** JSON-lines, plaintext with timestamp prefix,
   syslog, Apache/nginx combined. Format determines the right parser.
   For JSON-lines, prefer `jq` for filtering.
4. **Cluster by signature.** Group similar messages — replace numbers,
   UUIDs, and IPs with placeholders so `Error processing order 1234`
   and `Error processing order 9876` collapse into one cluster.
   Report top 10 clusters by count.
5. **Surface anomalies.** Flag any of:
   - First-occurrence-ever errors (compare against the previous day)
   - Sudden frequency spikes (>10x baseline)
   - Cascading failures (one service errors, others error 100ms later)
   - 5xx rate >1% for a route
   - Repeated stack traces from the same module
6. **Correlate.** If error timestamps cluster around a deploy or config
   change, mention it. Use `git log` to check for recent deploys.
7. **Report.** Short summary first: "237 errors in the last hour,
   80% from one cluster: `UpstreamTimeoutError` on the payments service
   between 14:32–14:47. Started 4 minutes after deploy abc123."

## Useful one-liners

- Top error messages: `grep -i error logfile | awk '{$1=""; $2=""; print}' | sort | uniq -c | sort -rn | head -20`
- JSON-lines filter: `jq 'select(.level=="error") | .message' app.log.jsonl | sort | uniq -c | sort -rn`
- Time-windowed: `awk '/2026-05-20 14:3[0-9]/' app.log`

## Anti-patterns to avoid

- Don't tail without `--lines` cap — huge logs will overwhelm output.
- Don't report individual error lines when a cluster summary is enough.
- Don't speculate on a root cause without correlating timestamps.

## Example invocation

> User: "Something is wrong with the api server, look at the logs"

Response: ask the user which logfile or service, tail last hour,
cluster errors, report "92% of errors are `ECONNREFUSED` to redis:6379
starting 14:02 — Redis appears down or unreachable from the api host."

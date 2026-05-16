'use strict';
/**
 * Web Fetch — built-in Horizon plugin.
 * Two tools: raw fetch + clean-text extract. Uses node-fetch which is
 * already a dependency of the host app (no new install).
 */
const fetch = require('node-fetch');

const MAX_BYTES = 1024 * 1024; // 1 MB cap so a runaway page can't OOM the agent
const TIMEOUT_MS = 15000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out after ' + ms + 'ms')), ms)),
  ]);
}

// Phase 2 fix — block fetches to private/loopback addresses (basic SSRF
// protection). Without this, an agent prompt-injected by a hostile web
// page could be steered to read http://127.0.0.1:<port> or internal
// network IPs (10.x / 172.16-31.x / 192.168.x) to exfiltrate data.
// Allows public DNS hostnames; rejects literal private IPs.
function isPrivateOrLoopback(hostname) {
  const h = String(hostname || '').toLowerCase().trim();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (h.startsWith('fe80:')) return true; // IPv6 link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // IPv6 ULA
  // IPv4 literal checks
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false; // hostname (DNS) — allow; resolution is the OS's call
  const [, a, b] = m.map(Number);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

async function safeFetch(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    throw new Error('URL must start with http:// or https://');
  }
  let parsed;
  try { parsed = new URL(url); }
  catch (_) { throw new Error('Invalid URL'); }
  if (isPrivateOrLoopback(parsed.hostname)) {
    throw new Error(`Blocked: ${parsed.hostname} is a private/loopback address (SSRF protection)`);
  }
  const res = await withTimeout(fetch(url, {
    redirect: 'follow',
    headers: {
      // Cheap UA so sites don't 403 a Node default agent.
      'User-Agent': 'Mozilla/5.0 (Horizon AI / web-fetch plugin)',
      'Accept': 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
    },
  }), TIMEOUT_MS);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  // Truncate at MAX_BYTES.
  const buf = await res.buffer();
  const truncated = buf.length > MAX_BYTES;
  const slice = truncated ? buf.slice(0, MAX_BYTES) : buf;
  return {
    text: slice.toString('utf8'),
    contentType: res.headers.get('content-type') || '',
    bytes: buf.length,
    truncated,
  };
}

function htmlToText(html) {
  // Lightweight stripper — keep it dependency-free. Good enough for
  // article / README / docs extraction; not a substitute for Readability.
  return String(html || '')
    // Drop scripts + styles entirely (content + tags).
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    // Block elements → newlines so structure survives.
    .replace(/<\/?(div|p|h[1-6]|li|tr|br|hr|article|section|header|footer|nav|main|aside|blockquote)[^>]*>/gi, '\n')
    // Remove remaining tags.
    .replace(/<[^>]+>/g, '')
    // Decode the most common HTML entities.
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    // Collapse whitespace.
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = {
  async execute(tool, args = {}) {
    const url = String(args.url || '').trim();
    if (!url) return { ok: false, error: 'url is required' };

    if (tool === 'fetch_url') {
      try {
        const r = await safeFetch(url);
        return {
          ok: true,
          out: r.text,
          contentType: r.contentType,
          bytes: r.bytes,
          truncated: r.truncated,
        };
      } catch (e) { return { ok: false, error: e.message }; }
    }

    if (tool === 'extract_text') {
      try {
        const r = await safeFetch(url);
        const isHtml = /text\/html|xhtml|application\/xml/i.test(r.contentType) || /<html[\s>]/i.test(r.text.slice(0, 200));
        const text = isHtml ? htmlToText(r.text) : r.text;
        return {
          ok: true,
          out: text,
          contentType: r.contentType,
          bytes: r.bytes,
          truncated: r.truncated,
          inputType: isHtml ? 'html' : 'plain',
        };
      } catch (e) { return { ok: false, error: e.message }; }
    }

    return { ok: false, error: `Unknown tool: ${tool}` };
  },
};

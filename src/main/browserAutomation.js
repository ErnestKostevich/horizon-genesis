'use strict';
/**
 * Horizon AI — Playwright Browser Automation
 * 
 * Provides browser automation capabilities using Playwright-like commands.
 * Works through system browsers on Windows/macOS/Linux.
 */

const { exec, spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Execute shell command
function sh(cmd, timeout = 30000) {
  return new Promise(resolve => {
    exec(cmd, { timeout, encoding: 'utf8', shell: IS_WIN ? 'cmd.exe' : '/bin/bash', maxBuffer: 10*1024*1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || err?.message || '').trim() });
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BROWSER AUTOMATION CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class BrowserAutomation {
  constructor() {
    this.currentUrl = '';
    this.pythonPath = IS_WIN ? 'python' : 'python3';
  }

  /**
   * Check if Playwright is available
   */
  async checkPlaywright() {
    const check = await sh(`${this.pythonPath} -c "import playwright; print('ok')"`, 5000);
    return check.ok && check.out.includes('ok');
  }

  /**
   * Install Playwright if needed
   */
  async installPlaywright() {
    // Check if pip is available
    const pipCheck = await sh(`${this.pythonPath} -m pip --version`, 5000);
    if (!pipCheck.ok) {
      return { ok: false, error: 'Python pip not available. Install Python first.' };
    }

    // Install playwright
    const install = await sh(`${this.pythonPath} -m pip install playwright`, 60000);
    if (!install.ok) {
      return { ok: false, error: `Failed to install playwright: ${install.err}` };
    }

    // Install browsers
    const browsers = await sh(`${this.pythonPath} -m playwright install chromium`, 120000);
    return { ok: browsers.ok, message: browsers.ok ? 'Playwright installed' : browsers.err };
  }

  /**
   * Run a Playwright script
   */
  async runScript(script) {
    // Create temp script file
    const scriptPath = path.join(os.tmpdir(), `hz_playwright_${Date.now()}.py`);
    
    const fullScript = `
import asyncio
from playwright.async_api import async_playwright
import json
import sys

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        context = await browser.new_context()
        page = await context.new_page()
        
        try:
${script.split('\n').map(line => '            ' + line).join('\n')}
            result = {"ok": True}
        except Exception as e:
            result = {"ok": False, "error": str(e)}
        finally:
            await browser.close()
        
        print(json.dumps(result))

asyncio.run(main())
`;
    
    try {
      fs.writeFileSync(scriptPath, fullScript);
      const result = await sh(`${this.pythonPath} "${scriptPath}"`, 60000);
      fs.unlinkSync(scriptPath);
      
      if (result.ok && result.out) {
        try {
          return JSON.parse(result.out.split('\n').pop());
        } catch {
          return { ok: true, output: result.out };
        }
      }
      return { ok: false, error: result.err || 'Script failed' };
    } catch (e) {
      try { fs.unlinkSync(scriptPath); } catch {}
      return { ok: false, error: e.message };
    }
  }

  /**
   * Navigate to URL
   */
  async navigate(url) {
    this.currentUrl = url;
    return this.runScript(`
await page.goto("${url}")
await page.wait_for_load_state("networkidle")
result = {"ok": True, "url": page.url, "title": await page.title()}
`);
  }

  /**
   * Click element by selector
   */
  async click(selector) {
    return this.runScript(`
await page.goto("${this.currentUrl}")
await page.click("${selector}")
await page.wait_for_load_state("networkidle")
result = {"ok": True, "clicked": "${selector}"}
`);
  }

  /**
   * Fill input field
   */
  async fill(selector, text) {
    return this.runScript(`
await page.goto("${this.currentUrl}")
await page.fill("${selector}", "${text.replace(/"/g, '\\"')}")
result = {"ok": True, "filled": "${selector}"}
`);
  }

  /**
   * Type text (with keyboard simulation)
   */
  async type(selector, text, delay = 50) {
    return this.runScript(`
await page.goto("${this.currentUrl}")
await page.type("${selector}", "${text.replace(/"/g, '\\"')}", delay=${delay})
result = {"ok": True, "typed": "${selector}"}
`);
  }

  /**
   * Get page content
   */
  async getContent() {
    return this.runScript(`
await page.goto("${this.currentUrl}")
content = await page.content()
result = {"ok": True, "content": content[:10000]}
`);
  }

  /**
   * Get page text
   */
  async getText(selector = 'body') {
    return this.runScript(`
await page.goto("${this.currentUrl}")
text = await page.inner_text("${selector}")
result = {"ok": True, "text": text[:5000]}
`);
  }

  /**
   * Screenshot page
   */
  async screenshot(savePath = null) {
    const screenshotPath = savePath || path.join(os.tmpdir(), `hz_screenshot_${Date.now()}.png`);
    return this.runScript(`
await page.goto("${this.currentUrl}")
await page.screenshot(path="${screenshotPath.replace(/\\/g, '/')}")
result = {"ok": True, "path": "${screenshotPath.replace(/\\/g, '/')}"}
`);
  }

  /**
   * Wait for selector
   */
  async waitFor(selector, timeout = 30000) {
    return this.runScript(`
await page.goto("${this.currentUrl}")
await page.wait_for_selector("${selector}", timeout=${timeout})
result = {"ok": True, "found": "${selector}"}
`);
  }

  /**
   * Execute JavaScript in page
   */
  async evaluate(jsCode) {
    return this.runScript(`
await page.goto("${this.currentUrl}")
eval_result = await page.evaluate("${jsCode.replace(/"/g, '\\"')}")
result = {"ok": True, "result": str(eval_result)[:5000]}
`);
  }

  /**
   * Get all links on page
   */
  async getLinks() {
    return this.runScript(`
await page.goto("${this.currentUrl}")
links = await page.eval_on_selector_all("a[href]", "elements => elements.map(e => ({text: e.innerText.trim(), href: e.href}))")
result = {"ok": True, "links": links[:50]}
`);
  }

  /**
   * Fill form and submit
   */
  async submitForm(formData, submitSelector = 'button[type="submit"]') {
    const fillCommands = Object.entries(formData)
      .map(([selector, value]) => `await page.fill("${selector}", "${value.replace(/"/g, '\\"')}")`)
      .join('\n');
    
    return this.runScript(`
await page.goto("${this.currentUrl}")
${fillCommands}
await page.click("${submitSelector}")
await page.wait_for_load_state("networkidle")
result = {"ok": True, "submitted": True, "url": page.url}
`);
  }

  /**
   * Google search
   */
  async googleSearch(query) {
    return this.runScript(`
await page.goto("https://www.google.com")
await page.fill('textarea[name="q"]', "${query.replace(/"/g, '\\"')}")
await page.press('textarea[name="q"]', "Enter")
await page.wait_for_load_state("networkidle")
# Get search results
results = await page.eval_on_selector_all("div.g", """elements => elements.slice(0, 10).map(e => {
    const title = e.querySelector('h3')?.innerText || '';
    const link = e.querySelector('a')?.href || '';
    const snippet = e.querySelector('.VwiC3b')?.innerText || '';
    return {title, link, snippet};
})""")
result = {"ok": True, "query": "${query.replace(/"/g, '\\"')}", "results": results}
`);
  }

  /**
   * YouTube search
   */
  async youtubeSearch(query) {
    return this.runScript(`
await page.goto("https://www.youtube.com/results?search_query=${encodeURIComponent(query).replace(/"/g, '\\"')}")
await page.wait_for_load_state("networkidle")
await asyncio.sleep(2)
# Get video results
videos = await page.eval_on_selector_all("ytd-video-renderer", """elements => elements.slice(0, 10).map(e => {
    const title = e.querySelector('#video-title')?.innerText || '';
    const link = e.querySelector('#video-title')?.href || '';
    const channel = e.querySelector('#channel-name')?.innerText || '';
    const views = e.querySelector('#metadata-line span')?.innerText || '';
    return {title, link, channel, views};
})""")
result = {"ok": True, "query": "${query.replace(/"/g, '\\"')}", "videos": videos}
`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIMPLE BROWSER CONTROL (without Playwright)
// Uses system commands to control browser - works everywhere
// ═══════════════════════════════════════════════════════════════════════════════

class SimpleBrowserControl {
  /**
   * Open URL in default browser
   */
  static async openUrl(url) {
    const cmd = IS_WIN
      ? `start "" "${url}"`
      : IS_MAC
        ? `open "${url}"`
        : `xdg-open "${url}"`;
    return sh(cmd, 10000);
  }

  /**
   * Open Google search
   */
  static async googleSearch(query) {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    return this.openUrl(url);
  }

  /**
   * Open YouTube search
   */
  static async youtubeSearch(query) {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    return this.openUrl(url);
  }

  /**
   * Open YouTube video
   */
  static async youtubePlay(videoIdOrUrl) {
    const videoId = videoIdOrUrl.includes('youtube.com') 
      ? new URL(videoIdOrUrl).searchParams.get('v') 
      : videoIdOrUrl;
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    return this.openUrl(url);
  }

  /**
   * Open Google Maps
   */
  static async openMaps(query) {
    const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    return this.openUrl(url);
  }

  /**
   * Open Gmail compose
   */
  static async composeEmail(to = '', subject = '', body = '') {
    const params = new URLSearchParams();
    if (to) params.set('to', to);
    if (subject) params.set('su', subject);
    if (body) params.set('body', body);
    const url = `https://mail.google.com/mail/?view=cm&${params.toString()}`;
    return this.openUrl(url);
  }

  /**
   * Open Google Calendar with new event
   */
  static async createCalendarEvent(title, startDate = null, endDate = null) {
    let url = 'https://calendar.google.com/calendar/r/eventedit';
    const params = [];
    if (title) params.push(`text=${encodeURIComponent(title)}`);
    if (startDate) params.push(`dates=${startDate}/${endDate || startDate}`);
    if (params.length) url += '?' + params.join('&');
    return this.openUrl(url);
  }

  /**
   * Open specific website
   */
  static async openSite(siteName) {
    const sites = {
      'google': 'https://www.google.com',
      'youtube': 'https://www.youtube.com',
      'gmail': 'https://mail.google.com',
      'calendar': 'https://calendar.google.com',
      'drive': 'https://drive.google.com',
      'docs': 'https://docs.google.com',
      'sheets': 'https://sheets.google.com',
      'maps': 'https://maps.google.com',
      'translate': 'https://translate.google.com',
      'github': 'https://github.com',
      'stackoverflow': 'https://stackoverflow.com',
      'twitter': 'https://twitter.com',
      'x': 'https://x.com',
      'facebook': 'https://facebook.com',
      'instagram': 'https://instagram.com',
      'linkedin': 'https://linkedin.com',
      'reddit': 'https://reddit.com',
      'netflix': 'https://netflix.com',
      'spotify': 'https://open.spotify.com',
      'amazon': 'https://amazon.com',
      'ebay': 'https://ebay.com',
      'chatgpt': 'https://chat.openai.com',
      'claude': 'https://claude.ai',
      'perplexity': 'https://perplexity.ai',
      'notion': 'https://notion.so',
      'figma': 'https://figma.com',
      'canva': 'https://canva.com',
      'trello': 'https://trello.com',
      'slack': 'https://slack.com',
      'discord': 'https://discord.com',
      'telegram': 'https://web.telegram.org',
      'whatsapp': 'https://web.whatsapp.com'
    };

    const url = sites[siteName.toLowerCase()] || `https://${siteName}.com`;
    return this.openUrl(url);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BROWSER MANAGER - Unified interface
// ═══════════════════════════════════════════════════════════════════════════════

class BrowserManager {
  constructor() {
    this.playwright = new BrowserAutomation();
    this.simple = SimpleBrowserControl;
    this.usePlaywright = false; // Default to simple commands
  }

  async init() {
    // Check if Playwright is available
    this.usePlaywright = await this.playwright.checkPlaywright();
    return { ok: true, playwrightAvailable: this.usePlaywright };
  }

  async installPlaywright() {
    const result = await this.playwright.installPlaywright();
    if (result.ok) {
      this.usePlaywright = true;
    }
    return result;
  }

  // Unified methods - use Playwright if available, otherwise simple commands
  async openUrl(url) {
    return this.simple.openUrl(url);
  }

  async search(query, engine = 'google') {
    if (engine === 'youtube') return this.simple.youtubeSearch(query);
    return this.simple.googleSearch(query);
  }

  async openSite(name) {
    return this.simple.openSite(name);
  }

  async composeEmail(to, subject, body) {
    return this.simple.composeEmail(to, subject, body);
  }

  async createEvent(title) {
    return this.simple.createCalendarEvent(title);
  }

  // Advanced methods (require Playwright)
  async navigateAndClick(url, selector) {
    if (!this.usePlaywright) {
      await this.simple.openUrl(url);
      return { ok: true, note: 'Opened URL. Click requires Playwright for automation.' };
    }
    await this.playwright.navigate(url);
    return this.playwright.click(selector);
  }

  async fillForm(url, formData, submitSelector) {
    if (!this.usePlaywright) {
      await this.simple.openUrl(url);
      return { ok: true, note: 'Opened URL. Form fill requires Playwright.' };
    }
    await this.playwright.navigate(url);
    return this.playwright.submitForm(formData, submitSelector);
  }

  async scrapeText(url, selector = 'body') {
    if (!this.usePlaywright) {
      return { ok: false, error: 'Text scraping requires Playwright. Run installPlaywright() first.' };
    }
    await this.playwright.navigate(url);
    return this.playwright.getText(selector);
  }

  async getSearchResults(query) {
    if (!this.usePlaywright) {
      await this.simple.googleSearch(query);
      return { ok: true, note: 'Opened Google search. Result scraping requires Playwright.' };
    }
    return this.playwright.googleSearch(query);
  }
}

module.exports = {
  BrowserAutomation,
  SimpleBrowserControl,
  BrowserManager
};

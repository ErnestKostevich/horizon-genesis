'use strict';

// IPC handlers — MCP built-in tools (location/weather/web search/wikipedia/
// gmail/calendar) + browser automation.
// Channels: mcpGetLocation, mcpGetWeather, mcpGetTimezone, mcpWebSearch,
// mcpWikipedia, mcpWikipediaSummary, mcpGmailSetToken, mcpGmailList,
// mcpGmailRead, mcpGmailSend, mcpCalendarSetToken, mcpCalendarList,
// mcpCalendarToday, mcpCalendarCreate, mcpCalendarQuickAdd, browserOpenUrl,
// browserSearch, browserOpenSite.

function register(deps) {
  const {
    ipcMain,
    loadAgentModules,
    getMcpManager, getBrowserManager,
    withPermission,
  } = deps;

  ipcMain.handle('mcpGetLocation', async () => {
    loadAgentModules();
    const mcpManager = getMcpManager();
    if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
    return mcpManager.getLocation();
  });

  ipcMain.handle('mcpGetWeather', async () => {
    loadAgentModules();
    const mcpManager = getMcpManager();
    if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
    return mcpManager.getWeather();
  });

  ipcMain.handle('mcpGetTimezone', async () => {
    loadAgentModules();
    const mcpManager = getMcpManager();
    if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
    return mcpManager.getTimezone();
  });

  ipcMain.handle('mcpWebSearch', async (_, query) => {
    loadAgentModules();
    const mcpManager = getMcpManager();
    if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
    return mcpManager.search(query);
  });

  ipcMain.handle('mcpWikipedia', async (_, query, limit) => {
    loadAgentModules();
    const mcpManager = getMcpManager();
    if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
    return mcpManager.searchWikipedia(query, limit);
  });

  ipcMain.handle('mcpWikipediaSummary', async (_, title) => {
    loadAgentModules();
    const mcpManager = getMcpManager();
    if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
    return mcpManager.getWikipediaSummary(title);
  });

  ipcMain.handle('mcpGmailSetToken', (_, token) => {
    loadAgentModules();
    const mcpManager = getMcpManager();
    if (!mcpManager) return false;
    mcpManager.setGmailToken(token);
    return true;
  });

  ipcMain.handle('mcpGmailList', async (_, query, max) => {
    loadAgentModules();
    const mcpManager = getMcpManager();
    if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
    return mcpManager.listEmails(query, max);
  });

  ipcMain.handle('mcpGmailRead', async (_, id) => {
    loadAgentModules();
    const mcpManager = getMcpManager();
    if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
    return mcpManager.readEmail(id);
  });

  ipcMain.handle('mcpGmailSend', async (_, to, subject, body, cc, bcc) => {
    loadAgentModules();
    const mcpManager = getMcpManager();
    if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
    return mcpManager.sendEmail(to, subject, body, cc, bcc);
  });

  ipcMain.handle('mcpCalendarSetToken', (_, token) => {
    loadAgentModules();
    const mcpManager = getMcpManager();
    if (!mcpManager) return false;
    mcpManager.setCalendarToken(token);
    return true;
  });

  ipcMain.handle('mcpCalendarList', async (_, cal, max) => {
    loadAgentModules();
    const mcpManager = getMcpManager();
    if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
    return mcpManager.listEvents(cal, max);
  });

  ipcMain.handle('mcpCalendarToday', async () => {
    loadAgentModules();
    const mcpManager = getMcpManager();
    if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
    return mcpManager.getTodayEvents();
  });

  ipcMain.handle('mcpCalendarCreate', async (_, cal, summary, start, end, desc, loc, attendees) => {
    loadAgentModules();
    const mcpManager = getMcpManager();
    if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
    return mcpManager.createEvent(cal, summary, start, end, desc, loc, attendees);
  });

  ipcMain.handle('mcpCalendarQuickAdd', async (_, text) => {
    loadAgentModules();
    const mcpManager = getMcpManager();
    if (!mcpManager) return { ok: false, error: 'MCP not loaded' };
    return mcpManager.quickAddEvent('primary', text);
  });

  // ── BROWSER AUTOMATION ───────────────────────────────────────────────────────
  ipcMain.handle('browserOpenUrl', async (event, url) => withPermission(
    event.sender,
    'browser.open',
    { url: String(url || '') },
    'Open browser URL',
    async () => {
    loadAgentModules();
    const browserManager = getBrowserManager();
    if (!browserManager) return { ok: false, error: 'Browser not loaded' };
    return browserManager.openUrl(url);
    }
  ));

  ipcMain.handle('browserSearch', async (event, query, engine) => withPermission(
    event.sender,
    'browser.search',
    { query: String(query || ''), engine: engine || 'google' },
    'Search in browser',
    async () => {
    loadAgentModules();
    const browserManager = getBrowserManager();
    if (!browserManager) return { ok: false, error: 'Browser not loaded' };
    return browserManager.search(query, engine);
    }
  ));

  ipcMain.handle('browserOpenSite', async (event, name) => withPermission(
    event.sender,
    'browser.open_site',
    { site: String(name || '') },
    'Open browser site',
    async () => {
    loadAgentModules();
    const browserManager = getBrowserManager();
    if (!browserManager) return { ok: false, error: 'Browser not loaded' };
    return browserManager.openSite(name);
    }
  ));
}

module.exports = { register };

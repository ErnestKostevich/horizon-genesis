'use strict';

// IPC handlers — personas + plugins + skills.
// Channels: getPersonas, getPersona, getPersonaPrompt, getPersonaFull,
// personaUpsert, personaDelete, getWakeResponse, pluginList, pluginInstall,
// pluginUninstall, pluginInstallTemplate, pluginToggle, skillsList,
// skillsRead, skillsWrite, skillsToggle, skillsUninstall,
// skillsInstallBundle, skillsInstallFromUrl, skillsShareUrl,
// skillsPreviewMatch, skillsPreviewSource, skillsRunHelper, pluginExecTool,
// pluginSetConfig, pluginShareUrl, pluginInstallFromUrl, pluginTemplates.

function register(deps) {
  const {
    ipcMain,
    loadAgentModules,
    getPersonas, getPluginManager, getSkillsManager, getAgentTools,
    withPermission,
  } = deps;

  // Personas
  ipcMain.handle('getPersonas', () => {
    loadAgentModules();
    const personas = getPersonas();
    if (!personas) return [];
    return personas.getAllPersonas();
  });

  ipcMain.handle('getPersona', (_, id) => {
    loadAgentModules();
    const personas = getPersonas();
    if (!personas) return null;
    return personas.getPersona(id);
  });

  ipcMain.handle('getPersonaPrompt', (_, id, lang) => {
    loadAgentModules();
    const personas = getPersonas();
    if (!personas) return '';
    return personas.getPersonaPrompt(id, lang);
  });

  ipcMain.handle('getPersonaFull', (_, id) => {
    loadAgentModules();
    const personas = getPersonas();
    if (!personas || typeof personas.getPersonaFull !== 'function') return null;
    return personas.getPersonaFull(id);
  });

  ipcMain.handle('personaUpsert', (_, id, patch) => {
    loadAgentModules();
    const personas = getPersonas();
    if (!personas || typeof personas.upsertPersona !== 'function') {
      return { ok: false, error: 'Personas module unavailable' };
    }
    return personas.upsertPersona(id, patch || {});
  });

  ipcMain.handle('personaDelete', (_, id) => {
    loadAgentModules();
    const personas = getPersonas();
    if (!personas || typeof personas.deletePersona !== 'function') {
      return { ok: false, error: 'Personas module unavailable' };
    }
    return personas.deletePersona(id);
  });

  ipcMain.handle('getWakeResponse', (_, id, lang) => {
    loadAgentModules();
    const personas = getPersonas();
    if (!personas) return 'Ready.';
    return personas.getWakeResponse(id, lang);
  });

  // Plugins
  ipcMain.handle('pluginList', () => {
    loadAgentModules();
    const pluginManager = getPluginManager();
    if (!pluginManager) return [];
    return pluginManager.list();
  });

  ipcMain.handle('pluginInstall', (_, pluginJson) => {
    loadAgentModules();
    const pluginManager = getPluginManager();
    if (!pluginManager) return { ok: false, error: 'Plugin manager not loaded' };
    return pluginManager.install(pluginJson);
  });

  ipcMain.handle('pluginUninstall', (_, id) => {
    loadAgentModules();
    const pluginManager = getPluginManager();
    if (!pluginManager) return { ok: false, error: 'Plugin manager not loaded' };
    return pluginManager.uninstall(id);
  });

  ipcMain.handle('pluginInstallTemplate', (_, templateId) => {
    loadAgentModules();
    const pluginManager = getPluginManager();
    if (!pluginManager) return { ok: false, error: 'Plugin manager not loaded' };
    const { PluginManager } = require('../pluginManager');
    const templates = PluginManager.getBuiltinTemplates();
    const tpl = templates.find(t => t.id === templateId);
    if (!tpl) return { ok: false, error: 'Template not found' };
    return pluginManager.install(tpl);
  });

  ipcMain.handle('pluginToggle', (_, id) => {
    loadAgentModules();
    const pluginManager = getPluginManager();
    if (!pluginManager) return { ok: false, error: 'Plugin manager not loaded' };
    return pluginManager.toggleEnable(id);
  });

  // Skills
  ipcMain.handle('skillsList', () => {
    loadAgentModules();
    const skillsManager = getSkillsManager();
    if (!skillsManager) return [];
    skillsManager.refreshIfStale();
    return skillsManager.list();
  });

  ipcMain.handle('skillsRead', (_, id, scope) => {
    loadAgentModules();
    const skillsManager = getSkillsManager();
    if (!skillsManager) return '';
    return skillsManager.readSource(id, scope);
  });

  ipcMain.handle('skillsWrite', (_, id, content, scope) => {
    loadAgentModules();
    const skillsManager = getSkillsManager();
    if (!skillsManager) return { ok: false, error: 'Skills manager not loaded' };
    return skillsManager.writeSource(id, content, scope);
  });

  ipcMain.handle('skillsToggle', (_, id, scope) => {
    loadAgentModules();
    const skillsManager = getSkillsManager();
    if (!skillsManager) return { ok: false, error: 'Skills manager not loaded' };
    return skillsManager.toggleEnable(id, scope);
  });

  ipcMain.handle('skillsUninstall', (_, id, scope) => {
    loadAgentModules();
    const skillsManager = getSkillsManager();
    if (!skillsManager) return { ok: false, error: 'Skills manager not loaded' };
    return skillsManager.uninstall(id, scope);
  });

  ipcMain.handle('skillsInstallBundle', (_, bundle, opts) => {
    loadAgentModules();
    const skillsManager = getSkillsManager();
    if (!skillsManager) return { ok: false, error: 'Skills manager not loaded' };
    return skillsManager.installFromBundle(bundle, opts || {});
  });

  ipcMain.handle('skillsInstallFromUrl', (_, url) => {
    loadAgentModules();
    const skillsManager = getSkillsManager();
    if (!skillsManager) return { ok: false, error: 'Skills manager not loaded' };
    return skillsManager.installFromShareUrl(url);
  });

  ipcMain.handle('skillsShareUrl', (_, id) => {
    loadAgentModules();
    const skillsManager = getSkillsManager();
    if (!skillsManager) return null;
    return skillsManager.generateShareUrl(id);
  });

  ipcMain.handle('skillsPreviewMatch', (_, query, opts) => {
    loadAgentModules();
    const skillsManager = getSkillsManager();
    if (!skillsManager) return { block: '', selected: [], scored: [] };
    skillsManager.refreshIfStale();
    return skillsManager.getSkillsBlock(query || '', opts || {});
  });

  ipcMain.handle('skillsPreviewSource', (_, query, content, opts) => {
    loadAgentModules();
    const skillsManager = getSkillsManager();
    if (!skillsManager) return { ok: false, error: 'Skills manager not loaded', selected: [], scored: [] };
    skillsManager.refreshIfStale();
    return skillsManager.previewSource(query || '', content || '', opts || {});
  });

  ipcMain.handle('skillsRunHelper', async (event, skillId, helperRel, helperArgs, timeoutMs) => {
    loadAgentModules();
    const agentTools = getAgentTools();
    const skillsManager = getSkillsManager();
    if (!agentTools || !skillsManager) return { ok: false, error: 'Skills manager not loaded' };
    return withPermission(
      event.sender,
      `skill_run_helper:${skillId || '?'}/${helperRel || '?'}`,
      { skill: skillId, helper: helperRel, args: helperArgs },
      `Run helper from skill "${skillId}"`,
      () => agentTools.runSkillHelper(skillId, helperRel, helperArgs, timeoutMs)
    );
  });

  ipcMain.handle('pluginExecTool', async (event, pluginId, toolName, args) => {
    loadAgentModules();
    const pluginManager = getPluginManager();
    if (!pluginManager) return { ok: false, error: 'Plugin manager not loaded' };
    let permissionTool = `${pluginId || 'plugin'}__${toolName || 'run'}`;
    try {
      const manifest = pluginManager.plugins?.get?.(pluginId) || {};
      const spec = (manifest.tools || []).find(t => t && t.name === toolName);
      if (spec?.action) permissionTool = `${pluginId || 'plugin'}__${spec.action}`;
    } catch (_) {}
    return withPermission(
      event.sender,
      permissionTool,
      args || {},
      'Run plugin tool',
      () => pluginManager.executeTool(pluginId, toolName, args)
    );
  });

  ipcMain.handle('pluginSetConfig', (_, pluginId, config) => {
    loadAgentModules();
    const pluginManager = getPluginManager();
    if (!pluginManager) return { ok: false, error: 'Plugin manager not loaded' };
    return pluginManager.setConfig(pluginId, config);
  });

  ipcMain.handle('pluginShareUrl', (_, id) => {
    loadAgentModules();
    const pluginManager = getPluginManager();
    if (!pluginManager) return null;
    return pluginManager.generateShareUrl(id);
  });

  ipcMain.handle('pluginInstallFromUrl', (_, url) => {
    loadAgentModules();
    const pluginManager = getPluginManager();
    if (!pluginManager) return { ok: false, error: 'Plugin manager not loaded' };
    return pluginManager.installFromShareUrl(url);
  });

  ipcMain.handle('pluginTemplates', () => {
    loadAgentModules();
    const { PluginManager } = require('../pluginManager');
    return PluginManager.getBuiltinTemplates();
  });
}

module.exports = { register };

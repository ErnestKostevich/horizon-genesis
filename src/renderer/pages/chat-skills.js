// Phase 2 — Skill Hub module.
//
// Browse / toggle / edit / import Claude Code-style skill bundles.
// Mirrors chat-plugin-hub.js but talks to H.skills* IPC instead of plugin IPC,
// and adds a markdown editor with live "preview injection" against the
// keyword-based relevance scorer in src/main/skillsRelevance.js.
//
// State: skillsCurrentTab, skillsCache, skillsEditing
// Fns:
//   openSkillHub, closeSkillHub, skillsTab, renderSkillsBody
//   toggleSkillEnabled, editSkill, saveSkillSource, previewSkillMatch
//   shareSkill, removeSkill, installSkillFromUrl, createSkillFromForm
//   runSkillHelperInteractive
//
// `window.forceSkillsNextTurn` is read by chat.html's send path and forwarded
// to H.agentRun as `forcedSkillIds`. It is cleared automatically after each
// send so /skill X stays one-shot (Claude Code semantics).
//
// Loaded after main inline so window globals (H, addMsg, lang, customConfirm,
// customPrompt, esc, setActiveSurface, isSurfaceActive, closeActiveSurface)
// already exist.

var skillsCurrentTab = 'installed';
var skillsCache = [];
var skillsEditing = null; // { id, scope, content, isNew }

function _scopeBadge(scope) {
  const label = scope === 'workspace' ? 'workspace' : scope === 'user' ? 'user' : 'built-in';
  const tone = scope === 'workspace' ? 'acc' : scope === 'user' ? 'amb' : 't3';
  return `<span class="sk-badge sk-badge-${tone}">${label}</span>`;
}

function _svgSkillIcon(path, extraAttrs) {
  return `<svg class="sk-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extraAttrs || ''}>${path}</svg>`;
}

function _skillIcon(scope, hasHelpers) {
  if (scope === 'workspace') return _svgSkillIcon('<path d="M3 7.5h6l2 2h10v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 7.5V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1.5"/>');
  if (scope === 'user') return _svgSkillIcon('<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/>');
  if (hasHelpers) return _svgSkillIcon('<path d="m14.7 6.3 3 3"/><path d="M3 21l6.8-6.8"/><path d="m12 4 8 8-2.5 2.5a2.1 2.1 0 0 1-3 0L9.5 9.5a2.1 2.1 0 0 1 0-3z"/>');
  return _svgSkillIcon('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/>');
}

function normalizeSkillUiIcons() {
  const root = document.getElementById('skills-body');
  if (!root) return;
  root.querySelectorAll('button').forEach(btn => {
    btn.textContent = btn.textContent
      .replace(/.*Edit$/u, 'Edit')
      .replace(/.*Preview match$/u, 'Preview match')
      .replace(/.*Create skill$/u, 'Create skill')
      .replace(/^.*\s(helpers\/.+)$/u, 'Run $1')
      .trim();
  });
}

function openSkillHub() {
  setActiveSurface('skills', { keepPanels: ['skills-panel'] });
  document.getElementById('skills-panel').classList.add('show');
  skillsTab('installed');
}

function closeSkillHub() {
  document.getElementById('skills-panel').classList.remove('show');
  skillsEditing = null;
  if (isSurfaceActive('skills')) closeActiveSurface();
}

function skillsTab(tab) {
  skillsCurrentTab = tab;
  ['installed', 'edit', 'import'].forEach(t => {
    document.getElementById(`skills-tab-${t}`)?.classList.toggle('on', t === tab);
  });
  renderSkillsBody();
}

async function renderSkillsBody() {
  const body = document.getElementById('skills-body');
  if (!body) return;

  if (skillsCurrentTab === 'installed') {
    body.innerHTML = '<div style="color:var(--t3);font-size:11px;margin-bottom:12px">Loading skills...</div>';
    try {
      const skills = await H.skillsList();
      skillsCache = skills || [];
      if (!skills || !skills.length) {
        body.innerHTML = `
          <div class="empty-state">
            <div class="es-icon">${_svgSkillIcon('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/>')}</div>
            <h3>No skills installed</h3>
            <p>Skills are Claude Code-style markdown bundles. Horizon auto-loads them into the agent's system prompt when their description matches your request.</p>
            <p style="font-size:11px;color:var(--t3);margin-top:8px">Try writing your own with <strong>+ Create skill</strong> below, or drop a <code>SKILL.md</code> into <code>.horizon/skills/&lt;name&gt;/</code> in any workspace.</p>
            <button class="sc-btn primary" onclick="skillsTab('edit')">+ Create skill</button>
          </div>`;
        return;
      }

      // Group by base id so workspace/user/builtin variants of the same id
      // collapse into one card (with the active variant highlighted).
      const byId = new Map();
      for (const s of skills) {
        if (!byId.has(s.id)) byId.set(s.id, []);
        byId.get(s.id).push(s);
      }

      const rows = [];
      for (const [id, variants] of byId) {
        const active = variants.find(v => v.active) || variants[0];
        const otherScopes = variants.filter(v => v !== active);
        const desc = active.description || '';
        const helpers = active.helpers || [];
        const tags = (active.tags || []).map(t => `<span class="sk-tag">${esc(t)}</span>`).join('');
        const parseErr = !active.parseOk
          ? `<div class="sk-err">Warning: ${esc((active.parseErrors || []).join('; '))}</div>`
          : '';
        const shadowed = otherScopes.length
          ? `<div class="sk-shadow">also installed at: ${otherScopes.map(o => _scopeBadge(o.scope)).join(' ')}</div>`
          : '';
        rows.push(`
          <div class="sk-card" data-skill-id="${esc(id)}">
            <div class="sk-card-head">
              <div class="sk-card-icon">${_skillIcon(active.scope, helpers.length > 0)}</div>
              <div class="sk-card-info">
                <div class="sk-card-name">${esc(active.name)} ${_scopeBadge(active.scope)} <span style="font-size:9px;color:var(--t3);font-weight:400">v${esc(active.version || '0.1.0')}</span></div>
                <div class="sk-card-desc">${esc(desc)}</div>
                <div style="font-size:10px;color:var(--t3);margin-top:4px">Used ${active.usage?.count || 0} turns${active.usage?.lastUsedAt ? ` · last ${esc(active.usage.lastUsedAt.slice(0, 10))}` : ''}</div>
                ${tags ? `<div class="sk-tags">${tags}</div>` : ''}
                ${shadowed}
                ${parseErr}
              </div>
              <div class="sw ${active.enabled ? 'on' : ''}" onclick="toggleSkillEnabled('${esc(id)}','${esc(active.scope)}',this)" title="Enable / disable for relevance matching"></div>
            </div>
            ${helpers.length ? `
              <div class="sk-helpers">
                ${helpers.map(h => `<button class="sk-helper" onclick="runSkillHelperInteractive('${esc(id)}','${esc(h)}')" title="Run helper script">▶ ${esc(h)}</button>`).join('')}
              </div>
            ` : ''}
            <div class="sk-actions">
              <button class="hub-btn primary" onclick="useSkillNextTurn('${esc(id)}')">Use next turn</button>
              <button class="hub-btn" onclick="editSkill('${esc(id)}','${esc(active.scope)}')">Edit</button>
              <button class="hub-btn" onclick="previewSkillMatchFromCard('${esc(id)}')">Preview match</button>
              <button class="hub-btn share" onclick="shareSkill('${esc(id)}')">Share URL</button>
              ${active.scope === 'builtin' ? '' : `<button class="hub-btn remove" onclick="removeSkill('${esc(id)}','${esc(active.scope)}')">Remove</button>`}
            </div>
          </div>
        `);
      }
      body.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-size:11px;color:var(--t3)">${skills.length} skill${skills.length === 1 ? '' : 's'} discovered across workspace, user, and built-in scopes.</div>
          <button class="hub-btn" onclick="skillsTab('edit')">+ Create skill</button>
        </div>
        ${rows.join('')}
      `;
      normalizeSkillUiIcons();
    } catch (e) {
      body.innerHTML = `<div style="color:var(--red);font-size:11px">${esc(e.message)}</div>`;
    }
  } else if (skillsCurrentTab === 'edit') {
    const editing = skillsEditing || { id: '', scope: 'user', content: _newSkillStarter(), isNew: true };
    body.innerHTML = `
      <div class="sk-editor">
        <div class="sk-editor-head">
          <div>
            <div class="sk-editor-title">${editing.isNew ? 'New skill' : `Editing <strong>${esc(editing.id)}</strong>`}</div>
            <div style="font-size:10px;color:var(--t3);margin-top:2px">Save target:
              <select id="sk-edit-scope" style="font-size:10px;background:var(--b1);color:var(--tx);border:1px solid var(--b2);border-radius:4px;padding:2px 4px">
                <option value="user"${editing.scope === 'user' ? ' selected' : ''}>user (~/.horizon/skills)</option>
                <option value="workspace"${editing.scope === 'workspace' ? ' selected' : ''}>workspace (.horizon/skills)</option>
              </select>
            </div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="hub-btn" onclick="skillsTab('installed')">Cancel</button>
            <button class="hub-btn primary" onclick="saveSkillSource()">Save</button>
          </div>
        </div>
        <div class="sk-editor-split">
          <div class="sk-editor-pane">
            <label style="font-size:10px;color:var(--t3)">SKILL.md (frontmatter + body)</label>
            <textarea id="sk-edit-source" class="sk-source">${esc(editing.content)}</textarea>
          </div>
          <div class="sk-editor-pane">
            <label style="font-size:10px;color:var(--t3)">Preview match</label>
            <input id="sk-preview-query" class="wf-input" placeholder="Test query — does this skill get loaded?" style="margin-bottom:6px"/>
            <button class="hub-btn" onclick="previewSkillMatch()" style="margin-bottom:8px">Score against query</button>
            <div id="sk-preview-result" class="sk-preview"></div>
          </div>
        </div>
        <div style="font-size:10px;color:var(--t3);margin-top:6px">Frontmatter keys: <code>name</code> (kebab-case, required), <code>description</code> (10-500 chars, required), <code>version</code>, <code>tags: [a,b]</code>, <code>permissions: [filesystem.read]</code>, <code>helpers: [helpers/x.js]</code>.</div>
      </div>
    `;
  } else if (skillsCurrentTab === 'import') {
    body.innerHTML = `
      <div class="url-install">
        <label>Install skill from share URL</label>
        <div class="url-install-row">
          <input class="url-install-input" id="sk-url-input" placeholder="horizon://skill/install?data=..."/>
          <button class="url-install-btn" onclick="installSkillFromUrl()">Install</button>
        </div>
      </div>
      <div style="font-size:11px;color:var(--t3);margin-top:8px">Share URLs look like <code style="color:var(--acc);font-size:10px">horizon://skill/install?data=…</code> and bundle the SKILL.md + helpers + reference docs.</div>
    `;
  }
}

function _newSkillStarter() {
  return [
    '---',
    'name: my-skill',
    'description: "When to use this skill — one or two sentences. The relevance scorer matches keywords from here against your prompts."',
    'version: "0.1.0"',
    'tags: []',
    '---',
    '# My skill',
    '',
    'Procedure the agent should follow when this skill loads.',
    '',
    '1. Step one.',
    '2. Step two.',
    '',
  ].join('\n');
}

async function toggleSkillEnabled(id, scope, sw) {
  try {
    const r = await H.skillsToggle(id, scope);
    if (r && r.ok) sw.classList.toggle('on', r.enabled);
  } catch (e) { H.notify?.('Skills', e.message); }
}

async function editSkill(id, scope) {
  try {
    const content = await H.skillsRead(id, scope);
    skillsEditing = { id, scope: scope === 'builtin' ? 'user' : scope, content, isNew: false };
    if (scope === 'builtin') {
      addMsg?.('bot', `Built-in skill **${id}** is read-only. Opened a copy you can save to your user or workspace scope.`);
    }
    skillsTab('edit');
  } catch (e) { H.notify?.('Skills', e.message); }
}

async function saveSkillSource() {
  if (!skillsEditing) return;
  const content = document.getElementById('sk-edit-source')?.value || '';
  const scope = document.getElementById('sk-edit-scope')?.value || skillsEditing.scope || 'user';
  try {
    const idForWrite = skillsEditing.isNew ? '' : skillsEditing.id;
    const r = await H.skillsWrite(idForWrite, content, scope);
    if (r && r.ok) {
      addMsg?.('bot', `Skill **${esc(r.id)}** saved to ${scope} scope.`);
      skillsEditing = null;
      skillsTab('installed');
    } else {
      H.notify?.('Skills', (r && r.error) || 'Save failed');
    }
  } catch (e) { H.notify?.('Skills', e.message); }
}

async function previewSkillMatch() {
  const query = document.getElementById('sk-preview-query')?.value?.trim() || '';
  const content = document.getElementById('sk-edit-source')?.value || '';
  const host = document.getElementById('sk-preview-result');
  if (!host) return;
  if (!query) {
    host.innerHTML = '<div style="color:var(--t3);font-size:11px">Enter a test query above to see whether this skill would load.</div>';
    return;
  }
  try {
    const res = await H.skillsPreviewSource(query, content, { scope: document.getElementById('sk-edit-scope')?.value || 'user' });
    if (!res?.ok) {
      host.innerHTML = `<div style="color:var(--red);font-size:11px">${esc(res?.error || 'Preview failed')}</div>`;
      return;
    }
    const scored = (res.scored || []).find(s => s.id === res.id);
    const selected = (res.selected || []).find(s => s.id === res.id);
    if (!scored) {
      host.innerHTML = '<div style="color:var(--red);font-size:11px">Skill not found in preview result.</div>';
      return;
    }
    const badge = selected
      ? '<span style="color:var(--green);font-weight:700">would load</span>'
      : '<span style="color:var(--t3)">below threshold</span>';
    const b = scored.breakdown || {};
    host.innerHTML = `
      <div class="sk-score">${badge} (score <strong>${scored.score}</strong>, threshold 0.15)</div>
      <table style="font-size:10px;color:var(--tx);margin-top:8px">
        <tr><td style="padding:2px 8px 2px 0">description</td><td>${b.description || 0}</td></tr>
        <tr><td style="padding:2px 8px 2px 0">name</td><td>${b.name || 0}</td></tr>
        <tr><td style="padding:2px 8px 2px 0">tags</td><td>${b.tags || 0}</td></tr>
        <tr><td style="padding:2px 8px 2px 0">aliases</td><td>${b.aliases || 0}</td></tr>
        <tr><td style="padding:2px 8px 2px 0">triggers</td><td>${b.triggers || 0}</td></tr>
        <tr><td style="padding:2px 8px 2px 0">examples</td><td>${b.examples || 0}</td></tr>
        <tr><td style="padding:2px 8px 2px 0">recent usage</td><td>${b.recentUsage || 0}</td></tr>
      </table>
      <div style="font-size:10px;color:var(--t3);margin-top:8px">Preview did not save this draft.</div>
    `;
  } catch (e) {
    host.innerHTML = `<div style="color:var(--red);font-size:11px">${esc(e.message)}</div>`;
  }
}

function useSkillNextTurn(id) {
  forceSkillForNextTurn(id);
  H.notify?.('Skills', `${id} will be used on the next message`);
}

async function previewSkillMatchFromCard(id) {
  const q = await customPrompt?.(`Preview match for "${id}" — test query:`, '');
  if (!q) return;
  try {
    const res = await H.skillsPreviewMatch(q, {});
    const scored = (res?.scored || []).find(s => s.id === id);
    const selected = (res?.selected || []).some(s => s.id === id);
    if (!scored) { addMsg?.('bot', `Skill ${id} not found.`); return; }
    const verdict = selected ? '**would load**' : 'below threshold (not loaded)';
    addMsg?.('bot', `**${id}** vs "${q}":\n${verdict} — score ${scored.score} (description ${scored.breakdown.description}, name ${scored.breakdown.name}, tags ${scored.breakdown.tags}).`);
  } catch (e) { H.notify?.('Skills', e.message); }
}

async function shareSkill(id) {
  try {
    const url = await H.skillsShareUrl(id);
    if (!url) { H.notify?.('Skills', 'No skill to share'); return; }
    await H.copy(url);
    H.notify?.('Skills', 'Share URL copied to clipboard');
    addMsg?.('bot', `Share URL for **${id}** copied to clipboard.`);
  } catch (e) { H.notify?.('Skills', e.message); }
}

async function removeSkill(id, scope) {
  if (scope === 'builtin') { H.notify?.('Skills', 'Built-in skills cannot be removed.'); return; }
  const ok = await customConfirm?.(`Remove skill "${id}" (${scope})?`, 'Remove');
  if (!ok) return;
  try {
    const r = await H.skillsUninstall(id, scope);
    if (r && r.ok) {
      addMsg?.('bot', `Skill **${id}** removed.`);
      renderSkillsBody();
    } else {
      H.notify?.('Skills', (r && r.error) || 'Remove failed');
    }
  } catch (e) { H.notify?.('Skills', e.message); }
}

async function installSkillFromUrl() {
  const url = document.getElementById('sk-url-input')?.value?.trim();
  if (!url) return;
  try {
    const r = await H.skillsInstallFromUrl(url);
    if (r && r.ok) {
      addMsg?.('bot', `Skill **${esc(r.id)}** installed.`);
      skillsTab('installed');
    } else { H.notify?.('Skills', (r && r.error) || 'Install failed'); }
  } catch (e) { H.notify?.('Skills', e.message); }
}

async function runSkillHelperInteractive(skillId, helperRel) {
  const argRaw = await customPrompt?.(`${skillId} → ${helperRel}\nJSON args (optional, e.g. {"root":"D:/myproj"})`, '{}');
  if (argRaw == null) return;
  let helperArgs = {};
  try { helperArgs = argRaw.trim() ? JSON.parse(argRaw) : {}; }
  catch (e) { H.notify?.('Skills', 'Invalid JSON: ' + e.message); return; }
  try {
    const r = await H.skillsRunHelper(skillId, helperRel, helperArgs, 30000);
    if (r && r.ok) {
      const out = (r.out || '').slice(0, 1500);
      addMsg?.('bot', `**${skillId}/${helperRel}** ok\n\`\`\`\n${out}\n\`\`\``);
    } else {
      addMsg?.('bot', `**${skillId}/${helperRel}** failed: ${esc(r?.err || r?.error || 'unknown')}`);
    }
  } catch (e) { H.notify?.('Skills', e.message); }
}

// Slash-command companion — append a one-shot forcedSkillId so the next
// agentRun loads the requested skill regardless of relevance score.
function forceSkillForNextTurn(id) {
  if (!Array.isArray(window.forceSkillsNextTurn)) window.forceSkillsNextTurn = [];
  if (id && !window.forceSkillsNextTurn.includes(id)) window.forceSkillsNextTurn.push(id);
}

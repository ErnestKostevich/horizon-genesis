// PR-V Phase 3.12 — External Integrations (GitHub repos + MCP servers).
// Extracted from chat.html inline <script> (was lines 3631-3784).
//
// Two adjacent connector surfaces:
//
//   1. GitHub: attach a repo by URL / owner-repo, list attached repos,
//      remove a repo. Used inside Settings → Connections.
//
//   2. MCP servers: form-driven config (command + args + env + cwd +
//      timeout), curated presets (filesystem / github / postgres /
//      puppeteer / slack), test connection, save server, refresh tool
//      catalog, toggle enabled, remove server. Used inside Settings →
//      Connections.
//
// State: MCP_PRESETS (curated public MCP servers from
//         @modelcontextprotocol on npm)
// GitHub: attachGithubRepo, loadGithubRepos, removeGithubRepo
// MCP form: mcpFormConfig, setMcpStatus
// MCP CRUD: loadMcpServers, testMcpServer, saveMcpServer,
//           refreshMcpTools, toggleMcpServer, removeMcpServer
//
// Loaded as external script AFTER main inline so window.* globals
// it reads (H IPC, esc, H.mcpServers*, H.githubAttachRepo, etc.)
// are defined.

async function attachGithubRepo(){
  const input=document.getElementById('pi-github-repo');
  const status=document.getElementById('github-status');
  const repo=(input?.value||'').trim();
  if(!repo){status.textContent='Enter owner/repo or a GitHub URL.';return;}
  status.textContent='Connecting to GitHub...';
  const r=await H.githubAttachRepo(repo).catch(e=>({ok:false,error:e.message}));
  if(!r.ok){status.textContent=r.error||'Could not attach repo.';return;}
  input.value='';
  status.textContent=`Attached ${r.repo.fullName}.`;
  await loadGithubRepos();
}
async function loadGithubRepos(){
  const box=document.getElementById('github-repos');
  if(!box) return;
  const repos=await H.githubListRepos().catch(()=>[]);
  if(!repos.length){box.textContent='No repos attached yet.';return;}
  box.innerHTML=repos.map(r=>`<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;margin:5px 0"><span><b>${esc(r.fullName)}</b><br><small>${esc(r.description||r.url||'')}</small></span><button class="psv" onclick="removeGithubRepo('${esc(r.fullName)}')">Remove</button></div>`).join('');
}
async function removeGithubRepo(fullName){
  await H.githubRemoveRepo(fullName).catch(()=>false);
  await loadGithubRepos();
}
function mcpFormConfig(existingId=''){
  const envText=(document.getElementById('mcp-env')?.value||'').trim();
  const env={};
  envText.split(/\r?\n/).forEach(line=>{const idx=line.indexOf('=');if(idx>0)env[line.slice(0,idx).trim()]=line.slice(idx+1).trim();});
  return {
    id: existingId || undefined,
    name:(document.getElementById('mcp-name')?.value||'').trim(),
    command:(document.getElementById('mcp-command')?.value||'').trim(),
    args:(document.getElementById('mcp-args')?.value||'').trim().split(/\s+/).filter(Boolean),
    env,
    cwd:(document.getElementById('mcp-cwd')?.value||'').trim(),
    timeoutMs:Number((document.getElementById('mcp-timeout')?.value||'').trim())||20000,
    enabled:true
  };
}
function setMcpStatus(text,bad=false){
  const el=document.getElementById('mcp-status');
  if(el){el.textContent=text;el.classList.toggle('bad',!!bad);el.classList.toggle('ok',!bad);}
}
async function loadMcpServers(){
  const box=document.getElementById('mcp-servers');
  if(!box || !H.mcpServersList) return;
  const r=await H.mcpServersList().catch(e=>({ok:false,error:e.message,servers:[]}));
  if(!r.ok){box.textContent=r.error||'Could not load MCP servers.';return;}
  const servers=r.servers||[];
  if(!servers.length){box.textContent='No MCP servers yet. Example: npx -y @modelcontextprotocol/server-filesystem D:\\Genesis';return;}
  box.innerHTML=servers.map(s=>`
    <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;margin:7px 0">
      <span><b>${esc(s.name)}</b> <small>${s.enabled?'enabled':'disabled'} - ${s.toolCount||0} tools</small><br><small>${esc(s.command)} ${esc((s.args||[]).join(' '))}${s.lastError?` - ${esc(s.lastError).slice(0,140)}`:''}</small></span>
      <span style="display:flex;gap:6px">
        <button class="psv" onclick="toggleMcpServer('${esc(s.id)}',${!s.enabled})">${s.enabled?'Disable':'Enable'}</button>
        <button class="psv" onclick="removeMcpServer('${esc(s.id)}')">Remove</button>
      </span>
    </div>`).join('');
}
// Curated public MCP servers — pre-fills the form so the user only has to
// fill in their own values (folder path / token / URL) and hit Test. All
// of these come from @modelcontextprotocol on npm; running them via npx
// is the canonical install path. Hint string is shown in mcp-status to
// tell the user what's still required.
var MCP_PRESETS = {
  filesystem: {
    name:    'filesystem',
    command: 'npx',
    args:    '-y @modelcontextprotocol/server-filesystem D:\\Genesis',
    hint:    'Filesystem: replace D:\\Genesis with the folder you want the agent to read/write.',
  },
  github: {
    name:    'github',
    command: 'npx',
    args:    '-y @modelcontextprotocol/server-github',
    env:     'GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx',
    hint:    'GitHub: paste your PAT into the env field above (replace ghp_xxx).',
  },
  postgres: {
    name:    'postgres',
    command: 'npx',
    args:    '-y @modelcontextprotocol/server-postgres postgres://user:pass@host:5432/db',
    hint:    'Postgres: replace the URL with your live connection string.',
  },
  puppeteer: {
    name:    'puppeteer',
    command: 'npx',
    args:    '-y @modelcontextprotocol/server-puppeteer',
    hint:    'Puppeteer: no env needed. First run downloads Chromium (~170MB).',
  },
  'brave-search': {
    name:    'brave-search',
    command: 'npx',
    args:    '-y @modelcontextprotocol/server-brave-search',
    env:     'BRAVE_API_KEY=BSAxxxxxxxx',
    hint:    'Brave Search: create an API key at brave.com/search/api and paste it in env.',
  },
  memory: {
    name:    'memory',
    command: 'npx',
    args:    '-y @modelcontextprotocol/server-memory',
    hint:    'Memory: persists across sessions in a JSON file under userData.',
  },
  time: {
    name:    'time',
    command: 'npx',
    args:    '-y @modelcontextprotocol/server-time',
    hint:    'Time: clocks / timezone math. No env needed.',
  },
  fetch: {
    name:    'fetch',
    command: 'npx',
    args:    '-y @modelcontextprotocol/server-fetch',
    hint:    'Fetch: HTTP GET/POST tools. No env needed.',
  },
};
function applyMcpPreset(presetKey){
  if (!presetKey) return;
  const p = MCP_PRESETS[presetKey];
  if (!p) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
  set('mcp-name', p.name);
  set('mcp-command', p.command);
  set('mcp-args', p.args);
  set('mcp-cwd', '');
  set('mcp-timeout', '20000');
  set('mcp-env', p.env || '');
  setMcpStatus(p.hint || 'Preset applied. Edit values, then Test.');
  // Reset the dropdown so the next selection re-applies.
  const sel = document.getElementById('mcp-preset');
  if (sel) sel.value = '';
}

async function testMcpServer(){
  const cfg=mcpFormConfig();
  if(!cfg.name || !cfg.command){setMcpStatus('Name and command are required.',true);return;}
  setMcpStatus('Testing MCP server...');
  const r=await H.mcpServerTest(cfg).catch(e=>({ok:false,error:e.message}));
  setMcpStatus(r.ok?`Connected. ${r.count||0} tools: ${(r.tools||[]).slice(0,5).map(t=>t.name).join(', ')}`:(r.error||'MCP test failed'),!r.ok);
}
async function saveMcpServer(){
  const cfg=mcpFormConfig();
  if(!cfg.name || !cfg.command){setMcpStatus('Name and command are required.',true);return;}
  const r=await H.mcpServerUpsert(cfg).catch(e=>({ok:false,error:e.message}));
  setMcpStatus(r.ok?'MCP server saved. Refreshing tools...':(r.error||'Save failed'),!r.ok);
  if(r.ok){await refreshMcpTools();await loadMcpServers();}
}
async function refreshMcpTools(){
  setMcpStatus('Refreshing MCP tools...');
  const r=await H.mcpToolsRefresh().catch(e=>({ok:false,error:e.message}));
  setMcpStatus(r.ok?`Loaded ${(r.tools||[]).length} MCP tools.`:(r.error||'Refresh failed'),!r.ok);
  await loadMcpServers();
}
async function toggleMcpServer(id,on){await H.mcpServerEnable(id,on).catch(()=>null);await refreshMcpTools();}
async function removeMcpServer(id){await H.mcpServerRemove(id).catch(()=>null);await loadMcpServers();}


'use strict';

const fs = require('fs');

function normalizeRepo(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('GitHub repository URL is required');
  let owner = '';
  let repo = '';
  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw);
    if (!/github\.com$/i.test(u.hostname)) throw new Error('Only github.com repositories are supported');
    const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
    owner = parts[0];
    repo = parts[1];
  } else {
    const parts = raw.replace(/^\/+|\/+$/g, '').split('/');
    owner = parts[0];
    repo = parts[1];
  }
  if (!owner || !repo) throw new Error('Use owner/repo or a GitHub repository URL');
  repo = repo.replace(/\.git$/i, '');
  return { owner, repo, fullName: `${owner}/${repo}`, url: `https://github.com/${owner}/${repo}` };
}

class GitHubConnector {
  constructor(filePath, keysStore) {
    this.filePath = filePath;
    this.keysStore = keysStore;
    this._data = { repos: [] };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) this._data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this._data.repos = Array.isArray(this._data.repos) ? this._data.repos : [];
    } catch {
      this._data = { repos: [] };
    }
  }

  _save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this._data, null, 2), 'utf8');
  }

  _headers() {
    const token = this.keysStore?.get('k_github');
    return {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Horizon-AI-Desktop',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async _github(path, opts = {}) {
    const fetch = (await import('node-fetch').then(m => m.default).catch(() => require('node-fetch')));
    const headers = { ...this._headers(), ...(opts.headers || {}) };
    const init = {
      method: opts.method || 'GET',
      headers,
    };
    if (opts.body !== undefined) {
      init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
    }
    const r = await fetch(`https://api.github.com${path}`, init);
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!r.ok) throw new Error(data.message || data.raw || `GitHub HTTP ${r.status}`);
    return data;
  }

  _resolveRepo(fullName) {
    const input = String(fullName || '').trim();
    if (input) return normalizeRepo(input);
    const attached = this._data.repos[0];
    if (!attached) throw new Error('No GitHub repository attached. Attach one in Settings → Connections first.');
    return normalizeRepo(attached.fullName);
  }

  _attachedMeta(fullName) {
    const parsed = this._resolveRepo(fullName);
    const attached = this._data.repos.find(r => r.fullName.toLowerCase() === parsed.fullName.toLowerCase());
    return { ...parsed, defaultBranch: attached?.defaultBranch || 'main' };
  }

  async attachRepo(input) {
    const parsed = normalizeRepo(input);
    const meta = await this._github(`/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`);
    const record = {
      id: meta.id || parsed.fullName,
      owner: parsed.owner,
      repo: parsed.repo,
      fullName: parsed.fullName,
      url: meta.html_url || parsed.url,
      defaultBranch: meta.default_branch || 'main',
      description: meta.description || '',
      private: Boolean(meta.private),
      stars: meta.stargazers_count || 0,
      updatedAt: meta.updated_at || null,
      attachedAt: new Date().toISOString(),
    };
    this._data.repos = this._data.repos.filter(r => r.fullName.toLowerCase() !== record.fullName.toLowerCase());
    this._data.repos.unshift(record);
    this._save();
    return record;
  }

  listRepos() {
    return [...this._data.repos];
  }

  removeRepo(fullName) {
    const before = this._data.repos.length;
    this._data.repos = this._data.repos.filter(r => r.fullName.toLowerCase() !== String(fullName || '').toLowerCase());
    this._save();
    return before !== this._data.repos.length;
  }

  async repoContext(fullName) {
    const parsed = this._attachedMeta(fullName);
    const repo = this._data.repos.find(r => r.fullName.toLowerCase() === parsed.fullName.toLowerCase()) || parsed;
    let readme = '';
    try {
      const data = await this._github(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/readme`);
      if (data?.content) readme = Buffer.from(data.content, data.encoding || 'base64').toString('utf8').slice(0, 20000);
    } catch (e) {
      readme = `README unavailable: ${e.message}`;
    }
    return { repo, readme };
  }

  async readFile(fullName, filePath, ref = '') {
    const repo = this._attachedMeta(fullName);
    const cleanPath = String(filePath || '').replace(/^\/+/, '');
    if (!cleanPath) throw new Error('GitHub file path is required');
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const data = await this._github(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/${cleanPath.split('/').map(encodeURIComponent).join('/')}${query}`);
    if (Array.isArray(data)) {
      return { repo: repo.fullName, path: cleanPath, type: 'dir', entries: data.map(item => ({ name: item.name, path: item.path, type: item.type, size: item.size || 0 })) };
    }
    if (!data?.content) return { repo: repo.fullName, path: cleanPath, type: data?.type || 'unknown', content: '' };
    const content = Buffer.from(String(data.content).replace(/\s/g, ''), data.encoding || 'base64').toString('utf8');
    return { repo: repo.fullName, path: cleanPath, type: data.type || 'file', sha: data.sha, size: data.size || Buffer.byteLength(content), content: content.slice(0, 30000) };
  }

  async searchCode(fullName, query, limit = 10) {
    const repo = this._attachedMeta(fullName);
    const q = String(query || '').trim();
    if (!q) throw new Error('GitHub search query is required');
    const perPage = Math.min(Math.max(Number(limit) || 10, 1), 30);
    const data = await this._github(`/search/code?q=${encodeURIComponent(`${q} repo:${repo.fullName}`)}&per_page=${perPage}`);
    return {
      repo: repo.fullName,
      total: data.total_count || 0,
      results: (data.items || []).map(item => ({
        name: item.name,
        path: item.path,
        url: item.html_url,
        sha: item.sha,
      })),
    };
  }

  async listIssues(fullName, state = 'open', limit = 20) {
    const repo = this._attachedMeta(fullName);
    const safeState = ['open', 'closed', 'all'].includes(String(state || '').toLowerCase()) ? String(state).toLowerCase() : 'open';
    const perPage = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const data = await this._github(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues?state=${safeState}&per_page=${perPage}`);
    return {
      repo: repo.fullName,
      issues: (data || []).filter(item => !item.pull_request).map(item => ({
        number: item.number,
        title: item.title,
        state: item.state,
        url: item.html_url,
        author: item.user?.login || '',
        labels: (item.labels || []).map(l => l.name),
        updatedAt: item.updated_at,
      })),
    };
  }

  async createIssue(fullName, title, body = '') {
    const repo = this._attachedMeta(fullName);
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) throw new Error('GitHub issue title is required');
    const data = await this._github(
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues`,
      { method: 'POST', body: { title: cleanTitle, body: String(body || '') } }
    );
    return {
      repo: repo.fullName,
      issue: {
        number: data.number,
        title: data.title,
        state: data.state,
        url: data.html_url,
      },
    };
  }
}

module.exports = { GitHubConnector, normalizeRepo };

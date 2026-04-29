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

  async _github(path) {
    const fetch = (await import('node-fetch').then(m => m.default).catch(() => require('node-fetch')));
    const r = await fetch(`https://api.github.com${path}`, { headers: this._headers() });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!r.ok) throw new Error(data.message || data.raw || `GitHub HTTP ${r.status}`);
    return data;
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
    const repo = this._data.repos.find(r => r.fullName.toLowerCase() === String(fullName || '').toLowerCase());
    if (!repo) throw new Error('Repository is not attached');
    let readme = '';
    try {
      const data = await this._github(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/readme`);
      if (data?.content) readme = Buffer.from(data.content, data.encoding || 'base64').toString('utf8').slice(0, 20000);
    } catch (e) {
      readme = `README unavailable: ${e.message}`;
    }
    return { repo, readme };
  }
}

module.exports = { GitHubConnector, normalizeRepo };

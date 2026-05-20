'use strict';
/**
 * Skill-runtime tools — invoke helper scripts bundled with a loaded skill,
 * or rewrite a skill's SKILL.md (self-improvement, user/workspace scope
 * only).
 *
 * The heavy lifting (helper resolution, child_process exec, writeSource
 * validation, append-only edit log) lives in agent.js + skillsManager.js;
 * these wrappers just forward arguments.
 */

const { register } = require('./registry');

function _agent() { return require('../agent'); }

register({
  name: 'skill_run_helper',
  description: 'Run a helper script bundled with a loaded skill. Use when a SKILL.md tells you to invoke one of its helpers.',
  parameters: {
    skill: 'string skill id',
    helper: 'string helper path (e.g. helpers/find-stale.js)',
    args: 'object passed as JSON on stdin',
    timeoutMs: 'number (default 30000)',
  },
  async execute(args = {}) {
    return _agent().runSkillHelper(args.skill, args.helper, args.args, args.timeoutMs);
  },
});

register({
  name: 'self_improve_skill',
  description: '[Self] Refine a user-scope or workspace-scope skill\'s SKILL.md based on what you just learned. Built-in skills are read-only. Each edit is logged.',
  parameters: {
    skill: 'string skill id',
    updatedContent: 'string — full new SKILL.md text (YAML frontmatter + body)',
    rationale: 'string — one-line note on why this improves the skill',
  },
  async execute(args = {}) {
    try {
      const mainMod = require.cache[require.resolve('../main')];
      const skillsMgr = mainMod?.exports?.skillsManager || null;
      if (!skillsMgr) return { ok: false, err: 'skills manager not loaded' };
      const id = String(args.skill || '').trim();
      const updated = String(args.updatedContent || '');
      const rationale = String(args.rationale || '').slice(0, 400);
      if (!id || !updated) {
        return { ok: false, err: 'self_improve_skill needs { skill, updatedContent, rationale }' };
      }
      // Find the skill so we can pick the right scope. Built-ins bounce
      // here — writeSource also blocks them, but we want a clear error
      // first.
      const skill = (skillsMgr.list() || []).find(s => s.id === id || s.name === id);
      if (!skill) return { ok: false, err: `unknown skill: ${id}` };
      if (skill.scope === 'builtin') {
        return { ok: false, err: 'built-in skills are read-only. Copy it to user scope first via Settings → Personas / Skills.' };
      }
      // Read the old content so we can log a diff record.
      let oldContent = '';
      try { oldContent = skillsMgr.readSource ? skillsMgr.readSource(id) : ''; } catch (_) {}
      const r = skillsMgr.writeSource(id, updated, skill.scope);
      if (!r.ok) return { ok: false, err: r.error || 'writeSource failed' };
      // Append-only edit log so the user can audit + roll back.
      try {
        const fs = require('fs');
        const path = require('path');
        const app = mainMod?.exports?.app || null;
        const userDataDir = app?.getPath?.('userData')
          || (mainMod?.exports?.userDataDir)
          || process.env.HORIZON_USER_DATA
          || path.join(require('os').homedir(), '.horizon-ai');
        const logPath = path.join(userDataDir, 'skill-edits.log');
        const entry = {
          ts: new Date().toISOString(),
          skill: id,
          scope: skill.scope,
          rationale,
          oldChars: oldContent.length,
          newChars: updated.length,
          delta: updated.length - oldContent.length,
        };
        fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
      } catch (e) {
        console.warn('[self_improve_skill] log write failed:', e.message);
      }
      return {
        ok: true,
        id: r.id,
        scope: r.scope,
        dir: r.dir,
        rationale,
        delta: updated.length - oldContent.length,
      };
    } catch (e) {
      return { ok: false, err: 'self_improve_skill failed: ' + e.message };
    }
  },
});

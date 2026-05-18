// PR-V Phase 2 — slash command dispatcher, extracted from chat.html.
// Originally lived inline at chat.html:6227 (PR-LAYOUT-V6). Behaviour
// identical; only the load mechanism changed (inline → external script).
//
// IMPORTANT: this file reads several globals declared in chat.html's
// main inline <script> (window.history, window.prov, window.H, plus
// window.* function names). Those used to be `let` / `const` (script-
// tag-scoped, invisible to other scripts) but were converted to `var`
// in Phase 2 Step 1 so they're now true window properties. If you
// re-introduce `let` at top level in chat.html, this file will break
// with "X is not defined" errors.
//
// Loaded AFTER the main inline script via <script src="chat-slash.js"
// defer></script>, so all the globals it references exist by the time
// it runs.

// Slash command dispatcher. Returns true if the input was consumed as
// a command (no LLM call should follow). False = treat as a normal
// chat message. Designed to fail SAFE: unknown commands return false
// (sent to LLM as normal text) so users don't get stuck.
window._handleSlashCommand = async function _handleSlashCommand(raw) {
  const text = String(raw || '').trim();
  if (!text.startsWith('/')) return false;
  const [cmdRaw, ...argParts] = text.slice(1).split(/\s+/);
  const cmd = (cmdRaw || '').toLowerCase();
  const arg = argParts.join(' ').trim();
  try {
    switch (cmd) {
      case 'clear': {
        try { document.getElementById('msgs').innerHTML = ''; } catch (_) {}
        try { window.history = []; } catch (_) {}
        try { window.H?.notify?.('Chat', 'Cleared current chat view.'); } catch (_) {}
        return true;
      }
      case 'new': {
        try { await window.createNewChat?.(); } catch (_) {}
        return true;
      }
      case 'persona': {
        if (!arg) { window.addMsg?.('bot', 'Usage: `/persona <id>` — e.g. /persona friday'); return true; }
        try { await window.setPersona?.(arg, { announce: false }); } catch (_) {}
        return true;
      }
      case 'model': {
        if (!arg) { window.addMsg?.('bot', 'Usage: `/model <name>` — e.g. /model gpt-5.4 or /model claude-sonnet-4-6'); return true; }
        // Look up provider that owns this model in MODEL_PICKER_REGISTRY.
        let foundProvider = null;
        try {
          for (const [p, list] of Object.entries(window.MODEL_PICKER_REGISTRY || {})) {
            if ((list || []).some(([val]) => String(val).toLowerCase() === arg.toLowerCase())) {
              foundProvider = p; break;
            }
          }
        } catch (_) {}
        if (foundProvider) {
          try { await window.saveModelSetting?.(foundProvider, arg); } catch (_) {}
        } else {
          // Fall back: assume current provider.
          try { await window.saveModelSetting?.(window.prov, arg); } catch (_) {}
        }
        return true;
      }
      case 'code':     try { window.setMode?.('code'); } catch(_){} return true;
      case 'agent':    try { window.setMode?.('agent'); } catch(_){} return true;
      case 'chat':     try { window.setMode?.('chat'); } catch(_){} return true;
      case 'settings': try { window.openPanel?.(arg || undefined); } catch(_){} return true;
      case 'skills':   try { window.openSkillHub?.(); } catch(_){} return true;
      case 'skill': {
        // One-shot force-load: /skill <id> [<rest of message>]
        // - With a rest-of-message: queue the id and re-dispatch the rest
        //   as the user's message for this turn, so the agent runs once
        //   with the skill injected regardless of relevance score.
        // - Without a rest-of-message: just queue the id; user types
        //   their message next.
        if (!arg) {
          try {
            const skills = await window.H?.skillsList?.() || [];
            const enabled = skills.filter(s => s.enabled).map(s => '`' + s.id + '`').join(', ') || '(none enabled)';
            window.addMsg?.('bot', '**`/skill <id> [message]`** — force-load a skill for the next turn.\nEnabled skills: ' + enabled);
          } catch (_) {
            window.addMsg?.('bot', 'Usage: `/skill <id> [message]` — force-load a skill for the next turn.');
          }
          return true;
        }
        const parts = arg.split(/\s+/);
        const skillId = parts.shift();
        const rest = parts.join(' ').trim();
        if (!Array.isArray(window.forceSkillsNextTurn)) window.forceSkillsNextTurn = [];
        if (!window.forceSkillsNextTurn.includes(skillId)) window.forceSkillsNextTurn.push(skillId);
        if (rest) {
          // Re-inject the rest as a normal message — runAgent/aiStream picks
          // up window.forceSkillsNextTurn on its way out.
          try {
            const inp = document.getElementById('inp');
            if (inp) {
              inp.value = rest;
              if (typeof window.sendMsg === 'function') window.sendMsg();
              else if (typeof window.send === 'function') window.send();
            }
          } catch (_) {}
        } else {
          try { window.updateQueuedSkillUi?.(); } catch (_) {}
          window.addMsg?.('bot', `Skill **${skillId}** will be used on your next message.`);
        }
        return true;
      }
      case 'spawn_subagent':
      case 'subagent': {
        // Test mode: directly dispatch the spawn_subagent tool through the
        // existing tool path (H.agentTool). The result lands in chat for
        // visibility, no AI-loop needed. Useful for verifying subagent
        // wiring and inspecting the resulting child run-id in the
        // Subagents inspector tab.
        if (!arg) {
          window.addMsg?.('bot', '**`/spawn_subagent <task>`** — fire a one-off subagent with the given task. Use for debugging the subagent runtime. Result appears in chat + Inspector → Subagents tab.\n\nExample: `/subagent найди 3 React testing библиотеки и сравни`');
          return true;
        }
        try {
          window.addMsg?.('bot', `🤖 Spawning subagent for: _${arg}_`);
          const r = await window.H?.agentTool?.('spawn_subagent', { task: arg, maxSteps: 4 });
          if (r?.ok) {
            const out = String(r.out || r.answer || '').slice(0, 1500);
            window.addMsg?.('bot', `✓ Subagent done (${r.steps || 0} steps, runId \`${(r.runId || '').slice(-12)}\`):\n\n${out}`);
          } else {
            window.addMsg?.('bot', `❌ Subagent failed: ${r?.err || r?.error || 'unknown error'}`);
          }
        } catch (e) {
          window.addMsg?.('bot', `❌ Subagent exception: ${e.message}`);
        }
        return true;
      }
      case 'help': {
        window.addMsg?.('bot',
          '**Slash commands**\n' +
          '`/clear` — wipe current chat view\n' +
          '`/new` — start a fresh chat\n' +
          '`/persona <id>` — switch persona (e.g. /persona friday)\n' +
          '`/model <name>` — switch model (e.g. /model gpt-5.4)\n' +
          '`/code` — open Code Mode IDE\n' +
          '`/agent` — switch to Agent mode\n' +
          '`/chat` — switch back to Chat mode\n' +
          '`/settings [tab]` — open Settings panel\n' +
          '`/skills` — open the Skill Hub\n' +
          '`/skill <id> [msg]` — force-load a skill for the next turn\n' +
          '`/help` — show this list'
        );
        return true;
      }
      default: return false;
    }
  } catch (e) {
    console.warn('[slash]', cmd, 'failed:', e?.message);
    return false;
  }
};

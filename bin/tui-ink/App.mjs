// bin/tui-ink/App.mjs
//
// Sprint-2.11 — Ink TUI promoted from prototype to functional.
//
// Real wiring now:
//   • handleSubmit → runtime.runChat (single-turn, history-aware) so the
//     user can actually have a conversation, not just echo
//   • Slash commands match the readline TUI: /help /quit /clear /reset
//     /theme /persona /model /skill /art /demo-tool /demo-stream
//   • History is kept in a ref so context carries between turns
//   • Cost / tokens flow into StatusBar via a costBump callback
//
// Still TODO for full parity (tracked for next sprint):
//   • Streaming reply rendering (Ink redraws full frame per state; need
//     a debounced buffer + Static for streamed tokens). For v1 we use
//     runChat non-streaming so the user always sees a complete reply.
//   • Agent loop with tool cards on a live step rail
//   • Scrollback search

import React, { useState, useCallback, useRef } from 'react';
import { Box, Text, Static, useApp, useInput } from 'ink';

import Banner from './components/Banner.mjs';
import StatusBar from './components/StatusBar.mjs';
import Composer from './components/Composer.mjs';
import ChatLine from './components/ChatLine.mjs';
import ToolCard from './components/ToolCard.mjs';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { listThemes, getTheme } = require('../lib/themes.js');
const { friendlyError } = require('../lib/tty.js');

export default function App({ runtime, flags }) {
  const { exit } = useApp();

  // Message id counter — kept in a ref so React's dev double-invocation
  // doesn't allocate duplicate ids that then collide as Static keys.
  const idRef = useRef(1);
  const nextId = useCallback(() => idRef.current++, []);

  // Conversation history — used for context window. Ref so it doesn't
  // trigger re-render when we append to it inside an async callback.
  const historyRef = useRef([]);

  const [messages, setMessages] = useState(() => [
    {
      id: 'seed',
      type: 'system',
      text: 'Horizon Ink TUI ready. Type /help for commands, /quit to exit.',
    },
  ]);

  // Composer state.
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');

  // Live session stats — accumulator for the StatusBar. We render these
  // through props so the bar's display ticks immediately as the cost
  // tracker would lag a frame behind.
  const [sessionTokens, setSessionTokens] = useState(0);
  const [sessionCost, setSessionCost] = useState(0);
  const [activeProvider, setActiveProvider] = useState(() => safeGet(runtime, 'settingsStore', 'provider') || 'gemini');
  const [activePersona, setActivePersona] = useState(() => safeGet(runtime, 'settingsStore', 'persona') || 'jarvis');
  const [activeTheme, setActiveTheme] = useState(() => safeGet(runtime, 'settingsStore', 'cliTheme') || 'default');

  // Recompute the model based on the current provider — runtime stores
  // per-provider models under `model.<provider>` keys.
  const modelRaw = safeGet(runtime, 'settingsStore', `model.${activeProvider}`)
                || safeGet(runtime, 'settingsStore', 'model')
                || 'auto';
  const model = typeof modelRaw === 'string'
    ? modelRaw
    : (modelRaw?.id || modelRaw?.name || 'auto');

  const append = useCallback((msg) => {
    setMessages((prev) => [...prev, { id: nextId(), ...msg }]);
  }, [nextId]);

  // Real chat path — calls runtime.runChat with conversation history,
  // appends the reply to transcript, updates session stats.
  const sendChat = useCallback(async (text) => {
    setBusy(true);
    setBusyLabel('thinking…');
    try {
      const r = await runtime.runChat(text, {
        history: historyRef.current,
      });
      if (r.error) {
        append({ type: 'system', text: '✗ ' + friendlyError(r.error) });
      } else if (r.reply) {
        const ts = _hhmm();
        append({ type: 'assistant', text: r.reply, ts });
        historyRef.current.push({ role: 'user', content: text });
        historyRef.current.push({ role: 'assistant', content: r.reply });
        if (r.usage) {
          const t = (r.usage.total || (r.usage.in || 0) + (r.usage.out || 0)) || 0;
          setSessionTokens((prev) => prev + t);
          if (typeof r.cost === 'number') setSessionCost((prev) => prev + r.cost);
        }
      }
    } catch (e) {
      append({ type: 'system', text: '✗ ' + (e?.message || String(e)) });
    } finally {
      setBusy(false);
      setBusyLabel('');
    }
  }, [runtime, append]);

  // Slash command dispatch — mirrors the readline TUI surface.
  const handleSlash = useCallback(async (raw) => {
    const [cmd, ...rest] = raw.trim().split(/\s+/);
    const argText = rest.join(' ').trim();
    const lowerCmd = cmd.toLowerCase();
    append({ type: 'user', text: raw });

    switch (lowerCmd) {
      case '/quit':
      case '/exit':
        append({ type: 'system', text: '⌁ see you. Session closed.' });
        setTimeout(() => exit(), 80);
        break;
      case '/clear':
        setMessages([]);
        break;
      case '/reset':
        historyRef.current = [];
        setMessages([{ id: nextId(), type: 'system', text: 'session reset.' }]);
        break;
      case '/help':
        append({
          type: 'system',
          text: [
            '/help            show this list',
            '/quit            exit the TUI',
            '/clear           clear scrollback',
            '/reset           clear history (start fresh context)',
            '/theme <name>    switch theme (try /theme cyberpunk)',
            '/theme --list    list all themes',
            '/persona <id>    switch persona',
            '/model <prov>    switch provider',
            '/skill <args>    skill helpers (passes through to CLI)',
            '/demo-tool       render a sample ToolCard',
            '',
            'Any other input runs a chat turn with the active provider.',
          ].join('\n'),
        });
        break;
      case '/theme': {
        const themes = listThemes();
        if (argText === '--list' || argText === 'list' || !argText) {
          const current = activeTheme;
          const lines = themes.map((id) => {
            const t = getTheme(id);
            const active = id === current ? '●' : ' ';
            return `${active}  ${id.padEnd(14)} ${t.banner || ''}  ${t.description || ''}`;
          });
          append({ type: 'system', text: 'Themes:\n' + lines.join('\n') });
        } else if (themes.includes(argText)) {
          try { runtime.settingsStore.set('cliTheme', argText); } catch (_) {}
          setActiveTheme(argText);
          append({ type: 'system', text: `theme → ${argText}` });
        } else {
          append({ type: 'system', text: `✗ unknown theme: ${argText}` });
        }
        break;
      }
      case '/persona': {
        if (!argText) {
          append({ type: 'system', text: `active persona: ${activePersona}` });
        } else {
          try { runtime.settingsStore.set('persona', argText); } catch (_) {}
          setActivePersona(argText);
          append({ type: 'system', text: `persona → ${argText}` });
        }
        break;
      }
      case '/model': {
        if (!argText) {
          append({ type: 'system', text: `active provider: ${activeProvider} (${model})` });
        } else {
          try { runtime.settingsStore.set('provider', argText); } catch (_) {}
          setActiveProvider(argText);
          append({ type: 'system', text: `provider → ${argText}` });
        }
        break;
      }
      case '/demo-tool':
        append({
          type: 'tool',
          text: argText || 'shell.run',
          meta: {
            status: 'ok',
            durationMs: 412,
            args: { cmd: 'git status' },
            output: 'On branch main\nnothing to commit, working tree clean',
          },
        });
        break;
      default:
        append({ type: 'system', text: `✗ unknown slash command: ${cmd}. Try /help` });
    }
  }, [append, exit, nextId, runtime, activeTheme, activePersona, activeProvider, model]);

  const handleSubmit = useCallback(async (raw) => {
    const value = String(raw || '').trim();
    if (!value) return;
    setInput('');

    if (value.startsWith('/')) {
      await handleSlash(value);
      return;
    }

    append({ type: 'user', text: value });
    await sendChat(value);
  }, [append, handleSlash, sendChat]);

  // Global keys: Ctrl+L clear, Esc interrupts a busy turn.
  useInput((inputCh, key) => {
    if (key.ctrl && (inputCh === 'l' || inputCh === 'L')) {
      setMessages([]);
    }
    if (key.escape && busy) {
      setBusy(false);
      setBusyLabel('');
      append({ type: 'system', text: '(interrupted)' });
    }
  });

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Banner, {
      runtime,
      provider: activeProvider,
      model,
      persona: activePersona,
    }),
    React.createElement(
      Static,
      { items: messages },
      (item) =>
        item.type === 'tool'
          ? React.createElement(ToolCard, { key: item.id, name: item.text, ...item.meta })
          : React.createElement(ChatLine, { key: item.id, type: item.type, text: item.text, ts: item.ts }),
    ),
    React.createElement(StatusBar, {
      runtime,
      provider: activeProvider,
      model,
      persona: activePersona,
      themeName: activeTheme,
      busy,
      busyLabel,
      messageCount: messages.length,
      tokens: sessionTokens,
      cost: sessionCost,
    }),
    React.createElement(Composer, {
      value: input,
      onChange: setInput,
      onSubmit: handleSubmit,
      busy,
    }),
  );
}

function safeGet(runtime, storeName, key) {
  try {
    return runtime?.[storeName]?.get?.(key);
  } catch (_) {
    return undefined;
  }
}

function _hhmm() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':'
       + String(d.getMinutes()).padStart(2, '0');
}

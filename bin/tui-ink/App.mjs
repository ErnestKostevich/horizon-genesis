// bin/tui-ink/App.mjs
//
// Top-level Ink component for the prototype TUI.
//
// Layout (top → bottom):
//   ┌── Banner ──────────────────────────────────────────────────┐
//   │ wordmark + 4 collapsible sections + persona greeting       │
//   └────────────────────────────────────────────────────────────┘
//   <Static> scrollback — finished transcript lines             │
//   <StatusBar />                                                │
//   <Composer />                                                 │
//
// Static is critical for performance: Ink re-renders the entire frame on
// every state change, so we keep finished transcript lines in <Static>
// which only mounts once per appended message. The live composer +
// status bar live above/below Static and redraw freely.

import React, { useState, useCallback, useRef } from 'react';
import { Box, Text, Static, useApp, useInput } from 'ink';

import Banner from './components/Banner.mjs';
import StatusBar from './components/StatusBar.mjs';
import Composer from './components/Composer.mjs';
import ChatLine from './components/ChatLine.mjs';
import ToolCard from './components/ToolCard.mjs';

export default function App({ runtime, flags }) {
  const { exit } = useApp();

  // Message id counter — kept in a ref (not module scope) so React's dev
  // double-invocation of state initializers doesn't allocate duplicate
  // ids that then collide as Static keys.
  const idRef = useRef(1);
  const nextId = useCallback(() => idRef.current++, []);

  // Transcript: append-only list of finished message records. Each entry
  // has { id, type: 'user' | 'assistant' | 'system' | 'tool', text, meta }.
  // We seed with a system welcome line so first paint isn't empty.
  const [messages, setMessages] = useState(() => [
    {
      id: 'seed',  // stable id for the seeded entry (idRef counter starts at 1)
      type: 'system',
      text: 'Ink TUI prototype ready. Type /help for commands, /quit to exit.',
    },
  ]);

  // Composer state lifted here so /reset can clear it externally.
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');

  // Pull live status values from the runtime each frame. Stores are
  // synchronous so this is cheap; in a production port we'd memoise on
  // a known set of keys.
  const provider = String(safeGet(runtime, 'settingsStore', 'provider') || 'gemini');
  const modelRaw = safeGet(runtime, 'settingsStore', `model_${provider}`)
                || safeGet(runtime, 'settingsStore', 'model')
                || 'auto';
  // settingsStore values can occasionally be objects (legacy provider-keyed
  // model maps); coerce defensively so the status bar never prints
  // [object Object].
  const model = typeof modelRaw === 'string'
    ? modelRaw
    : (modelRaw?.id || modelRaw?.name || 'auto');
  const persona = String(safeGet(runtime, 'settingsStore', 'persona') || 'jarvis');
  const themeName = String(safeGet(runtime, 'settingsStore', 'cliTheme') || 'default');

  const append = useCallback((msg) => {
    setMessages((prev) => [...prev, { id: nextId(), ...msg }]);
  }, [nextId]);

  const handleSubmit = useCallback((raw) => {
    const value = String(raw || '').trim();
    if (!value) return;

    // Slash commands — stubbed for the prototype. The production port
    // would dispatch to the same handlers bin/horizon-tui.js uses.
    if (value.startsWith('/')) {
      const [cmd, ...rest] = value.split(/\s+/);
      const argText = rest.join(' ');
      append({ type: 'user', text: value });
      switch (cmd) {
        case '/quit':
        case '/exit':
          append({ type: 'system', text: 'goodbye.' });
          setTimeout(() => exit(), 30);
          break;
        case '/clear':
          setMessages([]);
          break;
        case '/reset':
          setMessages([{ id: nextId(), type: 'system', text: 'session reset.' }]);
          break;
        case '/help':
          append({
            type: 'system',
            text: [
              '/help            show this list',
              '/quit            exit Ink TUI',
              '/clear           clear scrollback',
              '/reset           reset session',
              '/demo-tool       render a demo ToolCard',
              '/demo-stream     simulate a streaming response',
              '',
              'This is a SKELETON. The agent loop is not wired yet —',
              'any non-slash input prints back to prove the round-trip.',
            ].join('\n'),
          });
          break;
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
        case '/demo-stream':
          // Fake a streaming response so the busy spinner is visible.
          setBusy(true);
          setBusyLabel('streaming reply…');
          setTimeout(() => {
            append({
              type: 'assistant',
              text: 'This is a fake streamed reply. In the real port this would be **markdown** with `inline code` and even ```fenced blocks```.',
            });
            setBusy(false);
            setBusyLabel('');
          }, 900);
          break;
        default:
          append({ type: 'system', text: `unknown command: ${cmd}` });
      }
      setInput('');
      return;
    }

    // Non-slash input: echo back for now. The real port replaces this
    // with runtime.runChatStream / runtime.runAgent.
    append({ type: 'user', text: value });
    setBusy(true);
    setBusyLabel('echoing…');
    setTimeout(() => {
      append({
        type: 'assistant',
        text: `(prototype) you said: ${value}`,
      });
      setBusy(false);
      setBusyLabel('');
    }, 250);
    setInput('');
  }, [append, exit]);

  // Global key handlers — Ctrl+C exits, Ctrl+L clears, Esc cancels busy.
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

  // Render. Static gets the finished transcript; everything below it is
  // the live region (composer + status bar) that redraws per tick.
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Banner, {
      runtime,
      provider,
      model,
      persona,
    }),
    React.createElement(
      Static,
      { items: messages },
      (item) =>
        item.type === 'tool'
          ? React.createElement(ToolCard, { key: item.id, name: item.text, ...item.meta })
          : React.createElement(ChatLine, { key: item.id, type: item.type, text: item.text }),
    ),
    React.createElement(StatusBar, {
      runtime,
      provider,
      model,
      persona,
      themeName,
      busy,
      busyLabel,
      messageCount: messages.length,
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

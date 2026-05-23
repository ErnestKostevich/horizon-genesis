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

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, Static, useApp, useInput } from 'ink';

import Banner from './components/Banner.mjs';
import StatusBar from './components/StatusBar.mjs';
import Composer from './components/Composer.mjs';
import ChatLine from './components/ChatLine.mjs';
import ToolCard from './components/ToolCard.mjs';
import StepRail from './components/StepRail.mjs';
import PlanActGate from './components/PlanActGate.mjs';
import SearchOverlay from './components/SearchOverlay.mjs';
import useMouse from './hooks/useMouse.mjs';

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

  // Sprint-2.11 — live streaming buffer. While a token stream is in
  // flight, the partial reply lives here. It renders ABOVE the Static
  // transcript via a normal <ChatLine>, so React can redraw it on
  // every token without re-mounting all finished messages. When the
  // stream ends, the final text is appended to `messages` (which is
  // Static-backed) and `liveAssistant` is cleared.
  const [liveAssistant, setLiveAssistant] = useState(null);
  const liveBufRef = useRef('');
  const liveFlushTimerRef = useRef(null);

  // Sprint-2.12 — agent mode state. When the user runs /agent <task>,
  // we keep the plan + current step + failed indices live so the
  // StepRail can pulse the active chip. The rail clears when the
  // agent run ends; failed tools stay in the transcript as ToolCards.
  const [agentPlan, setAgentPlan] = useState([]);
  const [agentCurrentIdx, setAgentCurrentIdx] = useState(-1);
  const [agentFailed, setAgentFailed] = useState(() => new Set());
  const [agentMode, setAgentMode] = useState(false);
  // Active-tool placeholder card — shows the tool name + spinner while
  // it's running. Promoted to a real ToolCard in the transcript when
  // the 'result' event fires.
  const [liveTool, setLiveTool] = useState(null);
  // Sprint-2.14 — ref-mirror for agentCurrentIdx. The onStep callback
  // inside runAgentTask closes over the initial render's index value,
  // so setAgentFailed(prev => prev.add(agentCurrentIdx)) used the
  // stale -1 instead of the live index. Refs are stable so the
  // callback reads the latest value via .current.
  const currentIdxRef = useRef(-1);
  useEffect(() => { currentIdxRef.current = agentCurrentIdx; }, [agentCurrentIdx]);
  // Sprint-2.14 — tick state to force re-render every 500ms while
  // liveTool is set, so the displayed duration counts up instead of
  // freezing at the value it was when 'executing' fired.
  const [liveToolTick, setLiveToolTick] = useState(0);
  useEffect(() => {
    if (!liveTool) return;
    const id = setInterval(() => setLiveToolTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [liveTool]);

  // Sprint-2.15 — slow breathe tick (every 700ms) used by the StepRail
  // to softly dim/un-dim *pending* step chips while the agent runs.
  // Done = static bright green ✓. Current = Spinner (already animated).
  // Pending was the visual dead spot — now it gently breathes so the
  // whole rail feels alive while there's still work to do.
  const [pendingBreathe, setPendingBreathe] = useState(0);
  useEffect(() => {
    if (!agentMode || !agentPlan.length) return;
    const id = setInterval(() => setPendingBreathe((t) => t + 1), 700);
    return () => clearInterval(id);
  }, [agentMode, agentPlan.length]);

  // Sprint-2.13 — Plan/Act gate. When the agent's askPermission fires
  // for a dangerous tool we stash the promise resolver here and render
  // the PlanActGate panel above the composer. User keystrokes (Enter
  // approves, Esc rejects) call the resolver.
  const [pendingApproval, setPendingApproval] = useState(null);
  const approvalResolverRef = useRef(null);

  // Sprint-2.13 — scrollback search. Ctrl-R opens an overlay above the
  // composer. While active: typing edits query, ↑↓ navigates filtered
  // hits, Enter copies the matched line into the composer (so user can
  // re-send / quote it), Esc cancels.
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState([]);
  const [searchPos, setSearchPos] = useState(0);

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

  // Sprint-2.11 — streaming chat path. Uses runtime.runChatStream if
  // available, falls back to runChat. Tokens accumulate into liveBufRef
  // (no per-token re-render — debounced flush every ~80ms via the
  // liveFlushTimerRef interval). When done, the buffer is appended to
  // the Static transcript and the live area clears.
  const sendChat = useCallback(async (text) => {
    setBusy(true);
    setBusyLabel('thinking…');

    const hasStream = typeof runtime?.runChatStream === 'function';
    if (hasStream) {
      // Reset live buffer + show empty live assistant slot.
      liveBufRef.current = '';
      const ts = _hhmm();
      setLiveAssistant({ ts, text: '' });
      // Debounced flush — copy buf into state every 80ms so React only
      // re-renders ~12fps instead of once per token (which would
      // saturate the event loop and cause flicker).
      if (liveFlushTimerRef.current) clearInterval(liveFlushTimerRef.current);
      liveFlushTimerRef.current = setInterval(() => {
        setLiveAssistant({ ts, text: liveBufRef.current });
      }, 80);
      try {
        const r = await runtime.runChatStream(text, {
          history: historyRef.current,
        }, (chunk) => {
          liveBufRef.current += String(chunk || '');
        });
        // Final flush + promote to Static transcript.
        if (liveFlushTimerRef.current) {
          clearInterval(liveFlushTimerRef.current);
          liveFlushTimerRef.current = null;
        }
        const finalText = r?.reply || liveBufRef.current;
        setLiveAssistant(null);
        if (r?.error) {
          append({ type: 'system', text: '✗ ' + friendlyError(r.error) });
        } else if (finalText) {
          append({ type: 'assistant', text: finalText, ts });
          historyRef.current.push({ role: 'user', content: text });
          historyRef.current.push({ role: 'assistant', content: finalText });
        }
        if (r?.usage) {
          const t = (r.usage.total || (r.usage.in || 0) + (r.usage.out || 0)) || 0;
          setSessionTokens((prev) => prev + t);
          if (typeof r.cost === 'number') setSessionCost((prev) => prev + r.cost);
        }
      } catch (e) {
        if (liveFlushTimerRef.current) {
          clearInterval(liveFlushTimerRef.current);
          liveFlushTimerRef.current = null;
        }
        setLiveAssistant(null);
        append({ type: 'system', text: '✗ ' + (e?.message || String(e)) });
      } finally {
        setBusy(false);
        setBusyLabel('');
      }
      return;
    }

    // Fallback — single-shot runChat.
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

  // Sprint-2.12 — agent loop path. Calls runtime.runAgent with an
  // onStep handler that updates StepRail / live tool card / transcript
  // in real time. The plan event seeds the rail; each executing event
  // bumps the current index and shows a live spinner card; result
  // promotes that card into the Static transcript with status colour;
  // reflection appends a verdict line; the final answer is appended
  // as a normal assistant line.
  const runAgentTask = useCallback(async (task) => {
    if (typeof runtime?.runAgent !== 'function') {
      append({ type: 'system', text: '✗ runAgent is not available in this runtime build.' });
      return;
    }
    setBusy(true);
    setBusyLabel('planning…');
    setAgentMode(true);
    setAgentPlan([]);
    setAgentCurrentIdx(-1);
    setAgentFailed(new Set());
    const toolStartsRef = { current: new Map() };  // tool name → startedAt ms

    try {
      const r = await runtime.runAgent(task, {
        history: historyRef.current,
        // Sprint-2.13 — Plan/Act approval. Render PlanActGate panel and
        // wait for the user's Enter/Y or Esc/N keystroke. The result of
        // the promise is `true` (approve) or `false` (reject).
        askPermission: ({ tool, args, reason }) => {
          // Skip approval for safe tools — same allowlist as readline TUI.
          const dangerous = /^(run_code|run_shell|run_python|run_powershell|shell_command|write_file|delete_file|move_file|conn_.*_send|conn_.*_post|conn_.*_create|mouse_click|keyboard_type|smart_click|type_text|press_key)$/i.test(tool || '');
          if (!dangerous) return Promise.resolve(true);
          return new Promise((resolve) => {
            approvalResolverRef.current = resolve;
            setPendingApproval({ tool, args, reason });
            setBusyLabel('awaiting approval…');
          });
        },
        onStep: (event) => {
          if (!event) return;
          switch (event.type) {
            case 'plan': {
              if (event.plan?.steps) {
                setAgentPlan(event.plan.steps);
                setAgentCurrentIdx(0);
                setBusyLabel('executing step 1…');
              }
              break;
            }
            case 'executing': {
              const tool = String(event.tool || 'tool');
              toolStartsRef.current.set(tool, Date.now());
              setLiveTool({
                tool,
                args: event.args,
                reason: event.reason,
                startedAt: Date.now(),
              });
              setBusyLabel(`${tool}…`);
              break;
            }
            case 'result': {
              const tool = String(event.tool || 'tool');
              const startedAt = toolStartsRef.current.get(tool) || Date.now();
              const durationMs = Math.max(0, Date.now() - startedAt);
              setLiveTool(null);
              const ok = event.ok !== false;
              const out = String(event.result?.out || event.result?.err || event.result?.content || '').trim();
              // Promote to Static transcript as a real ToolCard.
              append({
                type: 'tool',
                text: tool,
                meta: {
                  status: ok ? 'ok' : 'err',
                  durationMs,
                  args: event.args,
                  output: out,
                },
              });
              if (!ok) {
                // Sprint-2.14 — read live index via ref, not the closed-over
                // agentCurrentIdx (which was -1 at runAgentTask creation).
                setAgentFailed((prev) => new Set(prev).add(currentIdxRef.current));
              } else {
                // Advance the plan index — agent emits steps in order.
                setAgentCurrentIdx((prev) => prev + 1);
              }
              break;
            }
            case 'reflection': {
              const verdict = event.goalMet === 'yes' ? '✓ goal met'
                : event.goalMet === 'partial' ? '⊘ partial'
                : '✗ not met';
              const conf = event.confidence != null
                ? `  · confidence ${event.confidence}`
                : '';
              append({ type: 'system', text: verdict + conf });
              break;
            }
            default: break;
          }
        },
      });
      if (r?.error) {
        append({ type: 'system', text: '✗ ' + friendlyError(r.error) });
      } else if (r?.answer) {
        const ts = _hhmm();
        append({ type: 'assistant', text: r.answer, ts });
        historyRef.current.push({ role: 'user', content: task });
        historyRef.current.push({ role: 'assistant', content: r.answer });
      }
      if (r?.usage) {
        const t = (r.usage.total || (r.usage.in || 0) + (r.usage.out || 0)) || 0;
        setSessionTokens((prev) => prev + t);
        if (typeof r?.cost === 'number') setSessionCost((prev) => prev + r.cost);
      }
    } catch (e) {
      append({ type: 'system', text: '✗ ' + (e?.message || String(e)) });
    } finally {
      setAgentMode(false);
      setAgentPlan([]);
      setAgentCurrentIdx(-1);
      setLiveTool(null);
      setBusy(false);
      setBusyLabel('');
    }
  // Sprint-2.14 — agentCurrentIdx dep removed; reads go through
  // currentIdxRef.current which doesn't need to be in the deps array.
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
            'Commands',
            '  /help            show this list',
            '  /quit            exit the TUI',
            '  /clear           clear scrollback',
            '  /reset           clear history (start fresh context)',
            '  /agent <task>    run the full agent loop with step rail + tool cards',
            '  /theme <name>    switch theme (try /theme cyberpunk)',
            '  /theme --list    list all themes',
            '  /persona <id>    switch persona',
            '  /model <prov>    switch provider',
            '  /demo-tool       render a sample ToolCard',
            '',
            'Keys',
            '  Enter            send message',
            '  Shift+Enter      newline (multi-line message)',
            '  Ctrl+R           search scrollback (↑↓ navigate, Enter quote, Esc cancel)',
            '  Ctrl+L           clear screen',
            '  Ctrl+U           clear current line',
            '  Ctrl+W           delete word backward',
            '  Esc              interrupt running turn / dismiss overlay',
            '  Y / N            approve / reject Plan-Act gate',
            '  Mouse wheel      scroll search hits (when overlay active)',
            '',
            'Any non-slash input runs a chat turn with the active provider.',
          ].join('\n'),
        });
        break;
      case '/agent': {
        if (!argText) {
          append({ type: 'system', text: 'Usage: /agent <task description>' });
        } else {
          // Don't await — let agent run in background, slash dispatch returns.
          runAgentTask(argText).catch(() => {});
        }
        break;
      }
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
  }, [append, exit, nextId, runtime, activeTheme, activePersona, activeProvider, model, runAgentTask]);

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

  // Sprint-2.13 — mouse support. Wheel up/down navigates the search
  // overlay hits when it's active. In future iterations we can extend
  // to click-to-focus, drag-to-select, etc. For now: wheel only.
  useMouse(useCallback((ev) => {
    if (!ev) return;
    if (searchActive) {
      if (ev.kind === 'scroll-up')   setSearchPos((p) => Math.max(0, p - 1));
      if (ev.kind === 'scroll-down') setSearchPos((p) => Math.min(searchHits.length - 1, p + 1));
    }
  }, [searchActive, searchHits.length]));

  // Compute hits for the search overlay — runs every render while
  // searchActive is true. Cheap because messages is a flat array of
  // ≤few-hundred items and we substring-match in lowercase.
  // Sprint-2.13 — placed before useInput so the keydown handler has
  // the latest searchHits in closure.
  useEffect(() => {
    if (!searchActive) return;
    if (!searchQuery) { setSearchHits([]); setSearchPos(0); return; }
    const lq = searchQuery.toLowerCase();
    const hits = [];
    for (const m of messages) {
      const body = (m.text || '').toString();
      if (body.toLowerCase().includes(lq)) {
        const preview = body.replace(/\s+/g, ' ').slice(0, 80);
        hits.push({ id: m.id, type: m.type, preview });
      }
    }
    setSearchHits(hits);
    setSearchPos((prev) => Math.max(0, Math.min(prev, hits.length - 1)));
  }, [searchActive, searchQuery, messages]);

  // Global keys: Ctrl+L clear, Esc interrupts a busy turn.
  useInput((inputCh, key) => {
    // Sprint-2.13 — search overlay takes precedence. Char input edits
    // query; Up/Down navigates; Enter sends the matched preview to
    // composer; Esc cancels.
    if (searchActive) {
      if (key.escape) {
        setSearchActive(false);
        setSearchQuery('');
        setSearchHits([]);
        setSearchPos(0);
        return;
      }
      if (key.return) {
        const hit = searchHits[searchPos];
        if (hit) {
          setInput(hit.preview);
        }
        setSearchActive(false);
        setSearchQuery('');
        return;
      }
      if (key.upArrow) {
        setSearchPos((p) => Math.max(0, p - 1));
        return;
      }
      if (key.downArrow) {
        setSearchPos((p) => Math.min(searchHits.length - 1, p + 1));
        return;
      }
      if (key.backspace || key.delete) {
        setSearchQuery((q) => q.slice(0, -1));
        return;
      }
      if (inputCh && !key.ctrl && !key.meta) {
        setSearchQuery((q) => q + inputCh);
        return;
      }
      return;
    }

    // Sprint-2.13 — Ctrl-R opens the search overlay.
    if (key.ctrl && (inputCh === 'r' || inputCh === 'R')) {
      setSearchActive(true);
      setSearchQuery('');
      return;
    }

    // Sprint-2.13 — Plan/Act gate takes precedence over everything else.
    // Enter or Y approves, Esc or N rejects. Resolves the stashed promise.
    if (pendingApproval) {
      if (key.return || inputCh === 'y' || inputCh === 'Y') {
        const resolver = approvalResolverRef.current;
        approvalResolverRef.current = null;
        setPendingApproval(null);
        setBusyLabel('');
        if (resolver) resolver(true);
        return;
      }
      if (key.escape || inputCh === 'n' || inputCh === 'N') {
        const resolver = approvalResolverRef.current;
        approvalResolverRef.current = null;
        setPendingApproval(null);
        setBusyLabel('');
        append({ type: 'system', text: '⊘ rejected — agent run will abort' });
        if (resolver) resolver(false);
        return;
      }
      return;  // swallow other keys while gate is up
    }

    if (key.ctrl && (inputCh === 'l' || inputCh === 'L')) {
      setMessages([]);
    }
    if (key.escape && busy) {
      // Sprint-2.11 — clean up streaming buffer + timer so we don't
      // keep redrawing a half-message after the user aborted.
      if (liveFlushTimerRef.current) {
        clearInterval(liveFlushTimerRef.current);
        liveFlushTimerRef.current = null;
      }
      if (liveAssistant && liveAssistant.text) {
        // Promote what we have so far into the transcript so the user
        // can read the partial reply they aborted on.
        append({ type: 'assistant', text: liveAssistant.text + ' …⊘', ts: liveAssistant.ts });
      }
      setLiveAssistant(null);
      setBusy(false);
      setBusyLabel('');
      append({ type: 'system', text: '⟂ interrupted' });
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
    // Sprint-2.12 — live step rail (visible only while an agent run is
    // active and a plan has been emitted). Pulses the current step.
    agentMode && agentPlan.length > 0
      ? React.createElement(StepRail, {
          key: 'rail',
          steps: agentPlan,
          currentIdx: agentCurrentIdx,
          failedSet: agentFailed,
          pendingBreathe,
        })
      : null,
    // Sprint-2.12 — in-flight tool card. Replaces a Static ToolCard
    // entry briefly: appears when 'executing' fires, disappears when
    // 'result' lands (the result then promotes to a Static ToolCard).
    liveTool
      ? React.createElement(ToolCard, {
          key: 'live-tool',
          name: liveTool.tool,
          status: 'ok',
          // Sprint-2.14 — liveToolTick is bumped every 500ms by a
          // useEffect; touching it here means the duration value is
          // recomputed on every tick, so the displayed timer counts
          // up instead of freezing at the spawn-time value.
          durationMs: liveToolTick === 0 || liveToolTick > 0
            ? Math.max(0, Date.now() - (liveTool.startedAt || Date.now()))
            : 0,
          args: liveTool.args,
          output: '⌁ running…',
        })
      : null,
    // Sprint-2.13 — Plan/Act approval gate. Sits above the composer
    // while pendingApproval is set. Enter/Y approves, Esc/N rejects.
    pendingApproval
      ? React.createElement(PlanActGate, {
          key: 'plan-gate',
          tool: pendingApproval.tool,
          args: pendingApproval.args,
          reason: pendingApproval.reason,
        })
      : null,
    // Sprint-2.13 — scrollback search overlay. Sits above composer.
    // While active, all keystrokes are eaten by the search handler.
    searchActive
      ? React.createElement(SearchOverlay, {
          key: 'search',
          query: searchQuery,
          hits: searchHits,
          pos: searchPos,
        })
      : null,
    // Sprint-2.11 — live streaming slot. Sits between Static and the
    // status bar; React rerenders it on every 80ms timer tick without
    // touching the immutable Static items above. Cleared when the
    // stream completes (assistant message is then promoted to Static).
    liveAssistant
      ? React.createElement(ChatLine, {
          key: 'live',
          type: 'assistant',
          text: liveAssistant.text || ' ',
          ts: liveAssistant.ts,
        })
      : null,
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
      // Sprint-2.13 — disable composer input when an overlay (search or
      // approval gate) is consuming keystrokes, otherwise both handlers
      // fire and characters double up.
      disabled: searchActive || !!pendingApproval,
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

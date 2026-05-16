// Phase 4.2 — Image generation mode (BYOK).
//
// When user activates Image mode (composer Mode picker → "Image"),
// sendMsg routes through generateImageFromPrompt instead of the
// normal AI chat path. Generated images render in chat history as
// regular bot messages with download / regenerate buttons.
//
// Provider routing: respects the active provider chip in composer
// model picker (gemini → Imagen 3, openai → DALL-E 3). Other
// providers fall back to OpenAI if the user has an openai key, else
// to Gemini, else an error message that explains BYOK setup.
//
// API key handling: BYOK — keys come from H.getKey('openai') and
// H.getKey('gemini'), same store as chat provider keys. We never
// proxy prompts or images.

(function () {
  // Map active provider → image provider. If user is on Claude/Mistral/etc
  // we still need to pick an image provider, so we prefer whichever
  // image-capable key is set.
  async function pickImageProvider() {
    const cur = (window.prov || window.provider || '').toLowerCase();
    if (cur === 'gemini') return 'gemini';
    if (cur === 'openai') return 'openai';
    // Fall through: prefer openai (DALL-E 3 is the more battle-tested),
    // fall back to gemini, else null (caller renders helpful error).
    try { if (await window.H?.hasKey?.('openai')) return 'openai'; } catch (_) {}
    try { if (await window.H?.hasKey?.('gemini')) return 'gemini'; } catch (_) {}
    return null;
  }

  function imgGenIcon() {
    return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>';
  }

  // Render a generated image into the chat as a bot message.
  function renderImageMessage(prompt, image) {
    if (!image || !image.b64) return;
    const dataUrl = `data:${image.mime || 'image/png'};base64,${image.b64}`;
    const msgEl = window.addMsg?.('bot', '', {
      model: `${image.provider} · ${image.model}`,
    });
    if (!msgEl) return;
    const bubble = msgEl.querySelector('.bub');
    if (!bubble) return;
    const revisedNote = image.revised_prompt && image.revised_prompt !== prompt
      ? `<div style="font:600 10px var(--mono);color:var(--t3);margin-top:6px;line-height:1.4">Provider revised prompt: <span style="color:var(--t2)">${escapeText(image.revised_prompt)}</span></div>`
      : '';
    bubble.innerHTML = `
      <div class="img-gen-card" style="display:flex;flex-direction:column;gap:8px">
        <div style="font:700 11px/1 var(--mono);color:var(--t3);letter-spacing:.4px;text-transform:uppercase">🎨 Image · ${escapeText(image.provider)} · ${escapeText(image.model)}</div>
        <img src="${dataUrl}" style="max-width:100%;border-radius:10px;border:1px solid var(--b1);cursor:zoom-in"
             onclick="window.open(this.src, '_blank')"
             alt="${escapeText(prompt).slice(0,200)}"/>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="ic-btn img-gen-download" style="height:28px;padding:0 10px;font:700 10px var(--mono)">⬇ Download</button>
          <button class="ic-btn img-gen-regen"    style="height:28px;padding:0 10px;font:700 10px var(--mono)">↻ Regenerate</button>
          <button class="ic-btn img-gen-copy"     style="height:28px;padding:0 10px;font:700 10px var(--mono)">📋 Copy prompt</button>
        </div>
        ${revisedNote}
      </div>
    `;
    // Wire action buttons.
    bubble.querySelector('.img-gen-download')?.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `horizon-${image.provider}-${Date.now()}.png`;
      a.click();
    });
    bubble.querySelector('.img-gen-regen')?.addEventListener('click', async () => {
      await window.generateImageFromPrompt?.(prompt);
    });
    bubble.querySelector('.img-gen-copy')?.addEventListener('click', () => {
      try {
        navigator.clipboard.writeText(prompt);
      } catch (_) { try { window.H?.copy?.(prompt); } catch (__) {} }
    });
  }

  function escapeText(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Main entry — called from sendMsg when mode === 'image'.
  // Renders a "generating..." stub immediately, then swaps in the
  // image (or an error) when the provider responds.
  window.generateImageFromPrompt = async function (prompt) {
    const text = String(prompt || '').trim();
    if (!text) return;
    const provider = await pickImageProvider();
    if (!provider) {
      window.addMsg?.('bot',
        '🎨 **Image mode needs an API key.**\n\n' +
        'Image generation is BYOK (bring-your-own-key) — Horizon never proxies image prompts. ' +
        'Open **Settings → Providers** and add a key for either:\n' +
        '- **OpenAI** (DALL-E 3) — `sk-...` from platform.openai.com\n' +
        '- **Gemini** (Imagen 3) — from aistudio.google.com'
      );
      return;
    }
    // Stub message — user sees we accepted the prompt immediately.
    const stubEl = window.addMsg?.('bot', '', { model: `${provider} · generating...` });
    const stubBubble = stubEl?.querySelector('.bub');
    if (stubBubble) {
      stubBubble.innerHTML = `<div style="display:flex;align-items:center;gap:10px;color:var(--t3);font:600 12px var(--font)">
        <span style="width:14px;height:14px;border:2px solid var(--t3);border-top-color:transparent;border-radius:50%;display:inline-block;animation:spin .8s linear infinite"></span>
        Generating image via ${provider}... (10-30s)
      </div>`;
    }
    try {
      const res = await window.H?.aiImage?.({
        provider,
        prompt: text,
        size: '1024x1024',
      });
      // Remove the stub regardless of success.
      stubEl?.remove();
      if (!res?.ok) {
        window.addMsg?.('bot',
          `🎨 **Image generation failed** (${provider})\n\n` +
          '```\n' + (res?.error || 'Unknown error') + '\n```\n\n' +
          'Common fixes: check your API key in Settings, verify your provider account has image-gen enabled, or try the other provider.'
        );
        return;
      }
      for (const image of res.images || []) {
        renderImageMessage(text, image);
      }
    } catch (e) {
      stubEl?.remove();
      window.addMsg?.('bot', `🎨 Image generation crashed: ${e?.message || e}`);
    }
  };

  // Inject the spinner keyframes once (avoids duplicating in CSS files).
  if (typeof document !== 'undefined' && !document.getElementById('img-gen-style')) {
    const s = document.createElement('style');
    s.id = 'img-gen-style';
    s.textContent = '@keyframes spin { to { transform: rotate(360deg) } }';
    document.head.appendChild(s);
  }
})();

'use strict';
/**
 * Horizon AI v2 — Screen Recorder + AI Narrator
 * Записывает экран и генерирует AI-нарратив через Vision API
 */

const { desktopCapturer, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

class ScreenRecorder {
  constructor(keysStore, settingsStore) {
    this.keysStore = keysStore;
    this.settingsStore = settingsStore;
    this.isRecording = false;
    this.recordingPath = null;
    this.startTime = null;
    this.narratorInterval = null;
    this.narratorFrames = [];
  }

  async getSources() {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 1280, height: 720 }
      });
      return {
        ok: true,
        sources: sources.map(s => ({
          id: s.id,
          name: s.name,
          thumbnail: s.thumbnail.toPNG().toString('base64')
        }))
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  startRecording(outputPath) {
    if (this.isRecording) return { ok: false, error: 'Already recording' };
    this.isRecording = true;
    this.startTime = Date.now();
    this.recordingPath = outputPath || path.join(os.homedir(), `horizon-recording-${Date.now()}.webm`);
    return { ok: true, path: this.recordingPath, message: 'Recording started (use renderer MediaRecorder)' };
  }

  stopRecording() {
    if (!this.isRecording) return { ok: false, error: 'Not recording' };
    this.isRecording = false;
    const duration = Math.round((Date.now() - this.startTime) / 1000);
    return { ok: true, path: this.recordingPath, duration };
  }

  saveRecording(base64Data, mimeType) {
    try {
      const ext = mimeType.includes('webm') ? 'webm' : 'mp4';
      const outputPath = path.join(os.homedir(), `horizon-recording-${Date.now()}.${ext}`);
      const buf = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(outputPath, buf);
      return { ok: true, path: outputPath, size: buf.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async generateNarration(base64Screenshot, mimeType, context) {
    const fetch = require('node-fetch');
    const lang = this.settingsStore.get('lang') || 'ru';
    const prompt = lang === 'ru'
      ? `Ты AI-нарратор записи экрана. Опиши кратко (1-2 предложения) что происходит на экране. ${context ? 'Контекст: ' + context : ''} Будь конкретным и информативным.`
      : `You are an AI screen recording narrator. Briefly describe (1-2 sentences) what's happening on screen. ${context ? 'Context: ' + context : ''} Be specific and informative.`;

    // Try OpenAI GPT-4o Vision
    const openaiKey = this.keysStore.get('k_openai');
    if (openaiKey) {
      try {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
          body: JSON.stringify({
            model: 'gpt-4o',
            max_tokens: 150,
            messages: [{ role: 'user', content: [
              { type: 'image_url', image_url: { url: `data:${mimeType || 'image/png'};base64,${base64Screenshot}`, detail: 'low' } },
              { type: 'text', text: prompt }
            ]}]
          })
        });
        const d = await r.json();
        if (!d.error) return { ok: true, narration: d.choices[0].message.content, model: 'GPT-4o' };
      } catch {}
    }

    // Try Gemini Vision
    const geminiKey = this.keysStore.get('k_gemini');
    if (geminiKey) {
      try {
        const model = this.settingsStore.get('geminiModel') || 'gemini-2.5-flash';
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [
            { inline_data: { mime_type: mimeType || 'image/png', data: base64Screenshot } },
            { text: prompt }
          ]}], generationConfig: { maxOutputTokens: 150 } })
        });
        const d = await r.json();
        if (!d.error && d.candidates?.[0]?.content?.parts?.[0]?.text) {
          return { ok: true, narration: d.candidates[0].content.parts[0].text, model: 'Gemini' };
        }
      } catch {}
    }

    // Try Claude Vision
    const claudeKey = this.keysStore.get('k_claude');
    if (claudeKey) {
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-opus-4-5', max_tokens: 150,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/png', data: base64Screenshot } },
              { type: 'text', text: prompt }
            ]}]
          })
        });
        const d = await r.json();
        if (!d.error) return { ok: true, narration: d.content[0].text, model: 'Claude' };
      } catch {}
    }

    return { ok: false, error: 'Need OpenAI, Gemini or Claude key for AI narration' };
  }

  getStatus() {
    return {
      isRecording: this.isRecording,
      startTime: this.startTime,
      duration: this.isRecording ? Math.round((Date.now() - this.startTime) / 1000) : 0,
      path: this.recordingPath
    };
  }
}

module.exports = { ScreenRecorder };

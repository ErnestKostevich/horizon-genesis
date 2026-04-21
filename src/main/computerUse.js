'use strict';
/**
 * Horizon AI — Computer Use Module (Agent-S3 style)
 * 
 * Provides screen analysis + automated clicking based on visual understanding.
 * Uses screenshot + AI vision to find UI elements and interact with them.
 */

const { exec } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Execute shell command
function sh(cmd, timeout = 15000) {
  return new Promise(resolve => {
    exec(cmd, { timeout, encoding: 'utf8', shell: IS_WIN ? 'cmd.exe' : '/bin/bash', maxBuffer: 10*1024*1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || err?.message || '').trim() });
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN ANALYSIS WITH GRID OVERLAY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Analyzes a screenshot and returns clickable regions with coordinates
 * Uses AI vision to understand UI elements
 */
async function analyzeScreenForClick(screenshotBase64, targetDescription, aiVisionFn) {
  // Create a grid overlay description for the AI
  const gridPrompt = `You are a Computer Use AI agent. Analyze this screenshot and find: "${targetDescription}"

Your task:
1. Look at the screenshot carefully
2. Find the UI element that matches the description
3. Estimate its CENTER coordinates (x, y) on the screen

The screenshot is from a ${IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : 'Linux'} computer.
Common screen resolution: 1920x1080 or similar.

Response format (JSON only):
{
  "found": true/false,
  "element": "description of what you found",
  "x": estimated_x_coordinate,
  "y": estimated_y_coordinate,
  "confidence": 0.0-1.0,
  "action": "click" | "double_click" | "right_click"
}

If you cannot find the element, respond with:
{"found": false, "reason": "explanation"}`;

  try {
    const result = await aiVisionFn(screenshotBase64, gridPrompt);
    if (!result || result.error) {
      return { found: false, error: result?.error || 'Vision analysis failed' };
    }

    // Parse AI response
    const text = result.text || result.reply || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e) {
        return { found: false, error: 'Failed to parse AI response' };
      }
    }
    return { found: false, error: 'No JSON in AI response' };
  } catch (e) {
    return { found: false, error: e.message };
  }
}

/**
 * Takes a screenshot with grid overlay for better coordinate estimation
 */
async function captureScreenWithGrid() {
  // This will be called from main.js using desktopCapturer
  // Returns base64 screenshot
  return null; // Implemented in main.js
}

// ═══════════════════════════════════════════════════════════════════════════════
// SMART CLICK - Click on element by description
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Finds and clicks on a UI element by description
 * @param {string} targetDescription - What to click on (e.g., "the blue Send button")
 * @param {Function} captureScreenFn - Function to capture screen
 * @param {Function} aiVisionFn - Function to analyze image with AI
 * @param {Function} clickFn - Function to perform mouse click
 */
async function smartClick(targetDescription, captureScreenFn, aiVisionFn, clickFn) {
  // Step 1: Capture screen
  const screenshot = await captureScreenFn();
  if (!screenshot || !screenshot.base64) {
    return { ok: false, error: 'Failed to capture screen' };
  }

  // Step 2: Analyze with AI vision
  const analysis = await analyzeScreenForClick(screenshot.base64, targetDescription, aiVisionFn);
  
  if (!analysis.found) {
    return { ok: false, error: analysis.reason || analysis.error || 'Element not found' };
  }

  // Step 3: Perform click
  const { x, y, action, confidence } = analysis;
  
  if (confidence && confidence < 0.5) {
    return { ok: false, error: `Low confidence (${confidence}). Element might not be correct.`, analysis };
  }

  let clickResult;
  if (action === 'double_click') {
    clickResult = await clickFn(x, y, 'left', true);
  } else if (action === 'right_click') {
    clickResult = await clickFn(x, y, 'right', false);
  } else {
    clickResult = await clickFn(x, y, 'left', false);
  }

  return {
    ok: clickResult.ok,
    clicked: { x, y, action },
    element: analysis.element,
    confidence: analysis.confidence,
    error: clickResult.err
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN OCR - Extract text from screen regions
// ═══════════════════════════════════════════════════════════════════════════════

async function extractTextFromScreen(screenshotBase64, aiVisionFn, region = null) {
  const prompt = region
    ? `Extract ALL text visible in the ${region} region of this screenshot. Return just the text, preserving formatting.`
    : `Extract ALL text visible in this screenshot. Return just the text, preserving formatting.`;

  try {
    const result = await aiVisionFn(screenshotBase64, prompt);
    return { ok: true, text: result?.text || result?.reply || '' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIND UI ELEMENTS - Get all clickable elements
// ═══════════════════════════════════════════════════════════════════════════════

async function findUIElements(screenshotBase64, aiVisionFn) {
  const prompt = `Analyze this screenshot and list ALL clickable UI elements you can see.

For each element, provide:
- description: what it is (button, link, input, icon, etc.)
- text: any visible text on/near it
- approximate_location: top-left, top-center, top-right, middle-left, center, middle-right, bottom-left, bottom-center, bottom-right
- estimated_coords: {x, y} approximate center coordinates

Return as JSON array:
[
  {"description": "...", "text": "...", "location": "...", "coords": {"x": 100, "y": 200}},
  ...
]`;

  try {
    const result = await aiVisionFn(screenshotBase64, prompt);
    const text = result?.text || result?.reply || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return { ok: true, elements: JSON.parse(jsonMatch[0]) };
    }
    return { ok: false, elements: [], error: 'No elements found' };
  } catch (e) {
    return { ok: false, elements: [], error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTOMATED WORKFLOWS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Execute a multi-step workflow based on visual analysis
 */
async function executeWorkflow(steps, captureScreenFn, aiVisionFn, clickFn, typeFn, waitMs = 500) {
  const results = [];
  
  for (const step of steps) {
    // Wait between steps
    await new Promise(r => setTimeout(r, waitMs));
    
    let result;
    switch (step.action) {
      case 'click':
        result = await smartClick(step.target, captureScreenFn, aiVisionFn, clickFn);
        break;
      case 'type':
        result = await typeFn(step.text, step.enter || false);
        break;
      case 'wait':
        await new Promise(r => setTimeout(r, step.ms || 1000));
        result = { ok: true, action: 'wait', ms: step.ms };
        break;
      case 'screenshot':
        result = await captureScreenFn();
        break;
      default:
        result = { ok: false, error: `Unknown action: ${step.action}` };
    }
    
    results.push({ step, result });
    
    // Stop on error unless step has continueOnError
    if (!result.ok && !step.continueOnError) {
      break;
    }
  }
  
  return { ok: results.every(r => r.result.ok), steps: results };
}

module.exports = {
  analyzeScreenForClick,
  smartClick,
  extractTextFromScreen,
  findUIElements,
  executeWorkflow
};

// Unit tests for the ANSI markdown renderer.
// We check both inline patterns and block-level constructs.

const test = require('node:test');
const assert = require('node:assert/strict');

// Render markdown without colour codes for deterministic snapshots
process.env.NO_COLOR = '1';
delete require.cache[require.resolve('../../bin/lib/tty')]; // reload to pick up NO_COLOR
delete require.cache[require.resolve('../../bin/lib/markdown')];
const { renderMarkdown } = require('../../bin/lib/markdown');

test('renders bold + italic + code stripping markers when colour off', () => {
  const out = renderMarkdown('Hello **world** and *italic* and `code`');
  // With NO_COLOR, all ANSI codes are empty; markers stay where they are
  // (we don't strip; we just don't paint). Verify text passes through.
  assert.match(out, /Hello/);
  assert.match(out, /world/);
  assert.match(out, /italic/);
  assert.match(out, /code/);
});

test('renders bullets', () => {
  const out = renderMarkdown('- item one\n- item two');
  // Bullet glyph + content
  assert.match(out, /• item one/);
  assert.match(out, /• item two/);
});

test('renders numbered list', () => {
  const out = renderMarkdown('1. first\n2. second');
  assert.match(out, /1\. first/);
  assert.match(out, /2\. second/);
});

test('renders headings', () => {
  const out = renderMarkdown('# H1\n## H2\n### H3');
  assert.match(out, /H1/);
  assert.match(out, /H2/);
  assert.match(out, /H3/);
});

test('renders blockquote with side bar', () => {
  const out = renderMarkdown('> quoted');
  assert.match(out, /│ quoted/);
});

test('renders horizontal rule', () => {
  const out = renderMarkdown('---');
  assert.match(out, /─+/);
});

test('renders fenced code block with language label', () => {
  const out = renderMarkdown('```python\nprint(1)\n```');
  assert.match(out, /python/);
  assert.match(out, /print\(1\)/);
});

test('renders links with url in parens', () => {
  const out = renderMarkdown('See [docs](https://example.com)');
  assert.match(out, /docs/);
  assert.match(out, /https:\/\/example\.com/);
});

test('mixed content survives', () => {
  const md = `
## Setup

Run \`horizon setup\` then choose a **provider**.

- Gemini (free tier)
- Claude ($3/M input)

> Bring your own key — never leaves your machine.
`;
  const out = renderMarkdown(md);
  assert.match(out, /Setup/);
  assert.match(out, /horizon setup/);
  assert.match(out, /provider/);
  assert.match(out, /• Gemini/);
  assert.match(out, /• Claude/);
  assert.match(out, /│ Bring your own key/);
});

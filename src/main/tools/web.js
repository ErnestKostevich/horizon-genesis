'use strict';
/**
 * Web/browser tools — open URLs, run a search, open well-known sites.
 *
 * Routes through agent.js's browserNavigate / browserSearch helpers. The
 * built-in `open_site` table covers the four shortcuts the agent's prompt
 * advertises (youtube/google/gmail/github); unknown names fall back to a
 * `.com` guess, exactly as before.
 */

const { register } = require('./registry');

function _agent() { return require('../agent'); }

register({
  name: 'browser_open',
  description: 'Open URL in default browser',
  parameters: { url: 'string' },
  async execute(args = {}) {
    return _agent().browserNavigate(args.url);
  },
});

register({
  name: 'browser_search',
  description: 'Search on Google/YouTube/Bing',
  parameters: { query: 'string', engine: 'google|youtube|bing' },
  async execute(args = {}) {
    return _agent().browserSearch(args.query, args.engine);
  },
});

register({
  name: 'open_site',
  description: 'Open a website: google, youtube, gmail, github, etc',
  parameters: { name: 'string' },
  async execute(args = {}) {
    const sites = {
      'youtube': 'https://youtube.com',
      'google': 'https://google.com',
      'gmail': 'https://mail.google.com',
      'github': 'https://github.com',
    };
    const siteUrl = sites[(args.name || '').toLowerCase()] || `https://${args.name}.com`;
    return _agent().browserNavigate(siteUrl);
  },
});

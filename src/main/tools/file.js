'use strict';
/**
 * Filesystem tools — read, write, list, search.
 *
 * All work is delegated to the host-side helpers in agent.js so behaviour
 * (path normalisation, encoding, error envelopes) stays bit-identical.
 */

const os = require('os');
const { register } = require('./registry');

function _agent() { return require('../agent'); }

register({
  name: 'read_file',
  description: 'Read file content from disk',
  parameters: { path: 'string' },
  async execute(args = {}) {
    return _agent().readFile(args.path);
  },
});

register({
  name: 'write_file',
  description: 'Write/create file on disk',
  parameters: { path: 'string', content: 'string' },
  async execute(args = {}) {
    return _agent().writeFile(args.path, args.content);
  },
});

register({
  name: 'list_dir',
  description: 'List directory contents',
  parameters: { path: 'string' },
  async execute(args = {}) {
    return _agent().listDir(args.path || os.homedir());
  },
});

register({
  name: 'search_files',
  description: 'Find files matching pattern',
  parameters: { dir: 'string', pattern: 'string' },
  async execute(args = {}) {
    return _agent().searchFiles(args.dir || os.homedir(), args.pattern || '');
  },
});

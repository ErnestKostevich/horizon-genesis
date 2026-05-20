'use strict';
/**
 * System-introspection tools — quick CPU/RAM/active-window snapshot and
 * a running-process list.
 */

const { register } = require('./registry');

function _agent() { return require('../agent'); }

register({
  name: 'get_system_info',
  description: 'Get system info: CPU, RAM, active window',
  parameters: {},
  async execute() {
    return _agent().getDetailedSysInfo();
  },
});

register({
  name: 'get_running_apps',
  description: 'List currently running apps',
  parameters: {},
  async execute() {
    return { ok: true, out: await _agent().getRunningApps() };
  },
});

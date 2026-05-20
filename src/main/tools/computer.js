'use strict';
/**
 * Computer-use tools — mouse, keyboard, scroll.
 *
 * Thin wrappers over the host-side automation helpers in agent.js. Defaults
 * (button='left', double=false, enter=false, direction='down', amount=3)
 * are preserved exactly as the original switch-case had them.
 */

const { register } = require('./registry');

function _agent() { return require('../agent'); }

register({
  name: 'mouse_move',
  description: 'Move mouse without clicking',
  parameters: { x: 'number', y: 'number' },
  async execute(args = {}) {
    return _agent().mouseMove(args.x, args.y);
  },
});

register({
  name: 'mouse_click',
  description: 'Click mouse at screen coordinates',
  parameters: { x: 'number', y: 'number', button: 'left|right', double: 'boolean' },
  async execute(args = {}) {
    return _agent().mouseClick(args.x, args.y, args.button || 'left', args.double || false);
  },
});

register({
  name: 'type_text',
  description: 'Type text into focused window',
  parameters: { text: 'string', enter: 'boolean' },
  async execute(args = {}) {
    return _agent().typeText(args.text || '', args.enter || false);
  },
});

register({
  name: 'press_key',
  description: 'Press key or shortcut: enter, ctrl+c, ctrl+v, alt+tab, ctrl+s, f5',
  parameters: { key: 'string' },
  async execute(args = {}) {
    return _agent().pressKey(args.key);
  },
});

register({
  name: 'scroll',
  description: 'Scroll mouse wheel up or down',
  parameters: { direction: 'up|down', amount: 'number 1-10' },
  async execute(args = {}) {
    return _agent().scroll(args.direction || 'down', args.amount || 3);
  },
});

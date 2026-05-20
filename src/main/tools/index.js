'use strict';
/**
 * Tool index — side-effect loads every category file so that, by the time
 * this module returns, the registry has been populated with all 34 tools.
 *
 * agent.js requires this exactly once. The order doesn't matter for
 * correctness, but we group it the way the old switch was grouped to
 * make the diff easier to follow.
 */

require('./exec');
require('./file');
require('./computer');
require('./web');
require('./system');
require('./memory');
require('./skills');
require('./subagent');
require('./canvas');
require('./self');

module.exports = require('./registry');

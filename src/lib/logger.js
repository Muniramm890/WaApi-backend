'use strict';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[process.env.LOG_LEVEL || 'info'] || 20;
function out(level, msg, extra) {
  if (LEVELS[level] < min) return;
  const rec = { t: new Date().toISOString(), level, msg };
  if (extra) {
    if (extra instanceof Error) rec.err = { message: extra.message, stack: extra.stack, code: extra.code };
    else Object.assign(rec, extra);
  }
  (level === 'error' ? process.stderr : process.stdout).write(JSON.stringify(rec) + '\n');
}
module.exports = {
  debug: (m, e) => out('debug', m, e),
  info: (m, e) => out('info', m, e),
  warn: (m, e) => out('warn', m, e),
  error: (m, e) => out('error', m, e),
};

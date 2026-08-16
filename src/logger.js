'use strict';

function ts() {
  return new Date().toISOString();
}

function fmt(level, args) {
  const tag = `[${ts()}] [${level}]`;
  return [tag, ...args];
}

module.exports = {
  info: (...a) => console.log(...fmt('INFO', a)),
  warn: (...a) => console.warn(...fmt('WARN', a)),
  error: (...a) => console.error(...fmt('ERROR', a)),
  debug: (...a) => {
    if (process.env.DEBUG) console.log(...fmt('DEBUG', a));
  },
};

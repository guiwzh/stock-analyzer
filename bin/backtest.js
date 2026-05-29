#!/usr/bin/env node
const path = require('path');
process.chdir(path.join(__dirname, '..'));
require('../backtest.js').main().catch(e => {
  console.error('回测出错:', e.message);
  process.exit(1);
});

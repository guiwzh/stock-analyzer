#!/usr/bin/env node
const path = require('path');
process.chdir(path.join(__dirname, '..'));
require('../analyze.js').main().catch(e => {
  console.error('分析出错:', e.message);
  process.exit(1);
});

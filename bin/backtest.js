#!/usr/bin/env node
const path = require('path');
process.chdir(path.join(__dirname, '..'));
require('../backtest.js');

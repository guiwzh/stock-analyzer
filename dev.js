/**
 * 开发模式启动器 - 自动监听文件变化并重启服务
 * 用法: node dev.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVER_FILE = path.join(__dirname, 'server.js');
const WATCH_FILES = [
  SERVER_FILE,
  path.join(__dirname, 'analyze.js'),
  path.join(__dirname, 'backtest.js'),
  path.join(__dirname, 'scoring.js'),
  path.join(__dirname, 'indicators.js'),
  path.join(__dirname, 'index.html'),
];
let child = null;
let restarting = false;

function start() {
  console.log(`[dev] 启动 server.js ...`);
  child = spawn('node', [SERVER_FILE], { stdio: 'inherit', cwd: __dirname });
  child.on('exit', (code) => {
    if (!restarting) {
      console.log(`[dev] 进程退出 (code=${code})`);
      process.exit(code);
    }
  });
}

function restart() {
  if (restarting) return;
  restarting = true;
  console.log(`\n[dev] 检测到文件变化，重启中...`);
  if (child) {
    child.kill();
    child.on('exit', () => {
      restarting = false;
      start();
    });
  } else {
    restarting = false;
    start();
  }
}

// 监听文件变化
let debounce = null;
for (const file of WATCH_FILES) {
  fs.watch(file, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(restart, 500);
  });
}

start();

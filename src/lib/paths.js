/**
 * 定位原始数据目录（管线输入）。
 *
 * 为什么需要它：这个项目有两种存在形式，脚本要都认。
 *   ① 单独克隆 onthisday  →  原始数据在 onthisday/data-src/
 *   ② 完整工作副本        →  原始数据可能在仓库根的 data-src/（调研期布局）
 *
 * 优先级：环境变量 ONTHISDAY_SRC > 第一种 > 第二种
 *
 * 用法:
 *   const { SRC } = require('./lib/paths');
 *   const RAW = path.join(SRC, '维基-历史上的今天离线', '_raw', 'zh');
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');          // onthisday/

function pick() {
  const cands = [];
  if (process.env.ONTHISDAY_SRC) cands.push(process.env.ONTHISDAY_SRC);
  cands.push(path.join(ROOT, 'data-src'));              // ① 自包含：onthisday/data-src/
  cands.push(path.join(ROOT, '..', 'data-src'));        // ② 仓库根
  for (const c of cands) if (c && fs.existsSync(c)) return path.resolve(c);
  return path.resolve(cands[cands.length - 1]);         // 都不在也返回一个可读的路径，便于报错
}

/** 原始数据根目录 */
const SRC = pick();

/** 拼一个原始数据路径，顺带给出「文件不存在时」该提示什么 */
function src(...parts) {
  return path.join(SRC, ...parts);
}

/** 读文件，文件缺失时给出可操作的提示（而不是一句 ENOENT） */
function readOrHint(file, hint) {
  if (!fs.existsSync(file)) {
    console.error(`\n找不到数据文件: ${file}`);
    console.error(`  当前的数据目录: ${SRC}`);
    console.error(hint ? `  ${hint}` : '  可用环境变量 ONTHISDAY_SRC 指定数据目录。');
    process.exit(1);
  }
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

module.exports = { SRC, src, readOrHint };

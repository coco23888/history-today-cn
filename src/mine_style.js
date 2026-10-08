/**
 * 从百度官方源（60s 的上游）里挖「好例子」，用于反推目标文风并写进提示词
 * 用法: node src/mine_style.js [日期,逗号分隔]  默认 10-7,1-1,7-4
 */
const fs = require('fs');
const path = require('path');
const { src } = require('./lib/paths');

const ROOT = path.join(__dirname, '..');
const BAIDU = src('百度百科-历史上的今天');
const merged = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'merged.json'), 'utf8').replace(/^\uFEFF/, ''));

const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function loadBaidu() {
  const all = {};
  for (let m = 1; m <= 12; m++) {
    const f = path.join(BAIDU, `${String(m).padStart(2, '0')}.json`);
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    const mk = Object.keys(j)[0];
    for (const [mmdd, arr] of Object.entries(j[mk])) {
      const key = `${parseInt(mmdd.slice(0, 2), 10)}-${parseInt(mmdd.slice(2), 10)}`;
      all[key] = arr.map((e) => ({
        year: String(e.year || ''), type: e.type,
        title: stripTags(e.title), desc: stripTags(e.desc),
        festival: e.festival || '', recommend: e.recommend === true,
      }));
    }
  }
  return all;
}

const baidu = loadBaidu();
const days = (process.argv[2] || '10-7,1-1,7-4').split(',');

console.log('\n=== 百度/60s 文风分析 ===\n');
for (const day of days) {
  const m = merged[day];
  if (!m) { console.log(`[${day}] 无数据`); continue; }
  console.log(`\n########## ${day} ##########`);

  // 只取 recommend=true 的（百度自己标为推荐，质量较高）
  const rec = (baidu[day] || []).filter((e) => e.recommend);
  console.log(`\n--- 百度 recommend=true 的例子（${rec.length} 条）---`);
  rec.slice(0, 8).forEach((e) => {
    console.log(`\n  [${e.year}] ${e.type}`);
    console.log(`   title : ${e.title}   (${e.title.length}字)`);
    console.log(`   desc  : ${e.desc.slice(0, 130)}   (${e.desc.length}字)`);
  });

  // 与维基做同(年)匹配，看同一件事两种写法
  console.log(`\n--- 同一年份的「维基原文 vs 百度标题+描述」对照 ---`);
  let shown = 0;
  for (const we of m.entries) {
    if (shown >= 6) break;
    const w = we.year.replace(/[^0-9]/g, '');
    if (!w) continue;
    const be = (baidu[day] || []).find((b) => b.year === w);
    if (!be) continue;
    shown++;
    console.log(`\n  ${w} 年  (维基 ${we.typeCn})`);
    console.log(`   维基 : ${we.text}`);
    console.log(`   百度 : ${be.title}`);
    console.log(`   百度desc: ${be.desc.slice(0, 120)}`);
  }
}

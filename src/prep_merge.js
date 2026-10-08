/**
 * 数据准备：把简体维基数据 + 百度节日数据合并成统一结构，并给每条分配稳定 ID
 *
 * 用法: node src/prep_merge.js
 *
 * 输入:
 *   data/wiki-zh-Hans.json                       简体维基 366 天
 *   data-src/百度百科-历史上的今天/{01..12}.json      百度官方源（取 festival 字段）
 * 输出:
 *   data/festivals.json   按天汇总的节日
 *   data/merged.json      合并后的统一数据集（AI 处理的输入）
 */
const fs = require('fs');
const path = require('path');
const { src } = require('./lib/paths');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const BAIDU = src('百度百科-历史上的今天');
const RAW_DIR = src('维基-历史上的今天离线', '_raw', 'zh');

/* ---------- 1. 从百度官方源抽取节日 ---------- */
function buildFestivals() {
  const out = {};   // { '10-7': ['全国高血压日', ...] }
  let files = 0;
  for (let m = 1; m <= 12; m++) {
    const f = path.join(BAIDU, `${String(m).padStart(2, '0')}.json`);
    if (!fs.existsSync(f)) continue;
    files++;
    const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    const monthKey = Object.keys(j)[0];
    for (const [mmdd, arr] of Object.entries(j[monthKey])) {
      const key = `${parseInt(mmdd.slice(0, 2), 10)}-${parseInt(mmdd.slice(2), 10)}`;
      const set = new Set(out[key] || []);
      for (const e of arr) if (e.festival && String(e.festival).trim()) set.add(String(e.festival).trim());
      if (set.size) out[key] = [...set];
    }
  }
  return { festivals: out, files };
}

/* ---------- 2. 合并 ---------- */
const TYPE_CODE = { events: 'e', births: 'b', deaths: 'd', holidays: 'h' };
const TYPE_CN = { events: '事件', births: '出生', deaths: '逝世', holidays: '维基节日' };

/** 某条是否已经有 AI 结果（决定补回的条目要不要再花钱跑） */
let _aiIds = null;
function hasAiResult(id) {
  if (_aiIds === null) {
    _aiIds = new Set();
    const f = path.join(DATA, 'ai', 'results.jsonl');
    if (fs.existsSync(f)) {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        const m = line.match(/"id"\s*:\s*"([^"]+)"/);
        if (m) _aiIds.add(m[1]);
      }
    }
  }
  return _aiIds.has(id);
}

function main() {
  const wikiPath = path.join(DATA, 'wiki-zh-Hans.json');
  if (!fs.existsSync(wikiPath)) { console.error('找不到 ' + wikiPath); process.exit(1); }
  const wiki = JSON.parse(fs.readFileSync(wikiPath, 'utf8').replace(/^\uFEFF/, ''));

  const { festivals, files } = buildFestivals();
  fs.writeFileSync(path.join(DATA, 'festivals.json'), JSON.stringify(festivals, null, 1), 'utf8');

  const merged = {};
  let total = 0;
  const withFestivalDays = new Set();

  for (const [key, day] of Object.entries(wiki)) {
    if (day.error) continue;
    const mmdd = String(day.month).padStart(2, '0') + String(day.day).padStart(2, '0');
    const fes = festivals[key] || [];
    if (fes.length) withFestivalDays.add(key);

    const rec = { month: day.month, day: day.day, festivals: fes, entries: [] };
    for (const [type, code] of Object.entries(TYPE_CODE)) {
      (day[type] || []).forEach((it, i) => {
        rec.entries.push({
          id: `${mmdd}-${code}-${i}`,
          date: key,
          type,
          typeCn: TYPE_CN[type],
          year: it.year || '',
          text: it.text || '',
        });
        total++;
      });
    }
    merged[key] = rec;
  }

  /* ---------- 3. 段落误分类修正（幂等，与 patch_sections.js 共用同一份逻辑） ----------
     不做这一步的话，每次重跑 prep 都会把之前修好的两个解析器 bug 悄悄还原。
     详见 src/lib/section_fix.js 的注释。 */
  const { applySectionFix, rawReader } = require('./lib/section_fix');
  const fix = applySectionFix(merged, rawReader(RAW_DIR));
  if (fix.removed || fix.added) {
    console.log('\n=== 段落误分类修正 ===');
    fix.log.forEach((l) => console.log(l));
    total += fix.added - fix.removed;
  }
  fs.writeFileSync(path.join(DATA, 'merged.json'), JSON.stringify(merged), 'utf8');

  /* ---------- 报告 ---------- */
  const dayCount = Object.keys(merged).length;
  const byType = {};
  for (const d of Object.values(merged)) for (const e of d.entries) byType[e.typeCn] = (byType[e.typeCn] || 0) + 1;
  const fesTotal = Object.values(festivals).reduce((a, b) => a + b.length, 0);

  console.log('\n=== 数据准备完成 ===');
  console.log(`  百度源文件: ${files} 个（01–12 月）`);
  console.log(`  维基天数  : ${dayCount}`);
  console.log(`  总条目    : ${total}`);
  console.log('  按类型    :');
  for (const [k, v] of Object.entries(byType)) console.log(`    ${k.padEnd(6)} ${v}`);
  console.log(`  节日      : ${fesTotal} 条，覆盖 ${withFestivalDays.size} 天`);
  console.log(`\n  输出: data/festivals.json  data/merged.json (${(fs.statSync(path.join(DATA, 'merged.json')).size / 1024 / 1024).toFixed(2)} MB)`);
  if (fix.added) {
    // 补回的条目 ID 通常沿用老的，如果 results.jsonl 里还有它们的 AI 结果就直接可用。
    // 只有真正没结果的才需要再花钱跑 AI —— 别误报。
    const missing = Array.isArray(fix.addedIds) ? fix.addedIds.filter((id) => !hasAiResult(id)) : [];
    if (missing.length) {
      console.log(`  ⚠️ 新增/补回 ${fix.added} 条，其中 ${missing.length} 条还没有 AI 结果：${missing.join(', ')}`);
      console.log('     跑 npm run ai:repair 补上');
    } else {
      console.log(`  ✓ 补回 ${fix.added} 条，它们的 AI 结果在 results.jsonl 里已存在，无需重跑`);
    }
  }

  // 抽一天展示
  const d = merged['10-7'];
  if (d) {
    console.log(`\n  ── 10-7 样例 ──`);
    console.log(`  节日: ${d.festivals.length ? d.festivals.join('、') : '(无)'}`);
    console.log(`  条目: ${d.entries.length} 条`);
    d.entries.slice(0, 3).forEach((e) => console.log(`    [${e.id}] (${e.typeCn}) ${e.year} ${e.text.slice(0, 46)}`));
  }
}

main();

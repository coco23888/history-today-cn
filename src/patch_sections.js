/**
 * 单独修补已经生成好的 merged.json 里的两处段落误分类（幂等，可反复跑）
 *
 *   1) 删除 7-1 births 里误入的「法定出生日」条目（那是民法条文，不是出生事件）
 *   2) 补回被整个丢弃的「体育」章节条目（10-29 / 11-26 / 11-6）
 *
 * 用法: node src/patch_sections.js [--dry]
 *
 * 注意:
 *   - 逻辑与 `prep_merge.js` 共用同一份实现（src/lib/section_fix.js），
 *     所以 `npm run prep` 重跑也不会把这些修正抹掉了。
 *   - 新增条目 ID 用不冲突的最小序号，**不移动已有 ID**，以免破坏已完成的 AI 结果。
 *   - 新增的条目还没有 AI 结果，需要跑 `npm run ai:repair` 或 `npm run ai:missing` 补上。
 */
const fs = require('fs');
const path = require('path');
const { src } = require('./lib/paths');
const { applySectionFix, rawReader } = require('./lib/section_fix');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const RAW = src('维基-历史上的今天离线', '_raw', 'zh');
const DRY = process.argv.includes('--dry');

const mergedPath = path.join(DATA, 'merged.json');
const merged = JSON.parse(fs.readFileSync(mergedPath, 'utf8'));

console.log('\n=== 段落误分类修正 ===');
const fix = applySectionFix(merged, rawReader(RAW));
if (fix.log.length) fix.log.forEach((l) => console.log(l));
else console.log('  ✓ 数据已经是干净的，无需修改');

console.log(`\n=== 结果 ===\n  删除 ${fix.removed} 条，新增 ${fix.added} 条`);
if (DRY) { console.log('  (--dry 模式，未写文件)'); process.exit(0); }
if (!fix.removed && !fix.added) { console.log('  没有变化，未写文件'); process.exit(0); }

fs.writeFileSync(mergedPath, JSON.stringify(merged), 'utf8');
console.log(`  已写回 ${mergedPath}`);
if (fix.added) console.log(`  ⚠️ 新增的 ${fix.added} 条还没有 AI 结果，跑 npm run ai:repair 补上`);

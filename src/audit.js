/** 数据质量审计 / 修复
 *  用法: node src/audit.js          # 只审计
 *        node src/audit.js --fix    # 修复非法分类（写回 results.jsonl 的规范化副本）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AI = path.join(ROOT, 'data', 'ai');
const tagsCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'tags.json'), 'utf8'));
const CATS = tagsCfg.categories.map((c) => c.key);
const TAGS = tagsCfg.sensitivityTags.map((t) => t.key);

const FIX = process.argv.includes('--fix');
const file = path.join(AI, 'results.jsonl');

/* 载入全部结果：results.json（早期快照）+ results.jsonl（逐条追加，覆盖前者） */
const byId = new Map();
const jsonFile = path.join(AI, 'results.json');
if (fs.existsSync(jsonFile)) {
  try { for (const o of Object.values(JSON.parse(fs.readFileSync(jsonFile, 'utf8')))) if (o && o.id) byId.set(o.id, o); } catch (e) {}
}
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try { const o = JSON.parse(line); if (o && o.id) byId.set(o.id, o); } catch (e) {}
}
const all = [...byId.values()];

/* 非法分类 → 最近的合法分类（按关键词映射，兜底 其他） */
const CAT_FIX = [
  [/宗教|神职|教会|教派/, '文化艺术'],
  [/军|战|防务|政权|外交|政治/, '政治军事'],
  [/科技|科学|发明|技术|计算|航天/, '科技发明'],
  [/艺术|文学|音乐|影视|绘画|文化/, '文化艺术'],
  [/经济|商业|企业|金融|贸易|社会/, '经济社会'],
  [/自然|地理|天文|气象|生物|环境/, '自然地理'],
  [/体育|运动|赛事|竞技/, '体育'],
  [/灾|事故|地震|洪水|台风|空难/, '灾难事故'],
  [/医|药|疾病|健康|卫生/, '医药健康'],
  [/教育|学校|大学|学术/, '教育'],
];
function normalizeCat(cat) {
  if (CATS.includes(cat)) return cat;
  for (const [re, to] of CAT_FIX) if (re.test(cat)) return to;
  return '其他';
}

/* 非法标签 → 最近的合法标签 */
const TAG_FIX = {
  '涉恐怖主义': '涉战争', '涉恐': '涉战争', '涉恐怖': '涉战争',
  '涉灾难': '涉伤亡', '涉灾': '涉伤亡', '涉事故': '涉伤亡',
  '涉政治': '涉政', '涉宗教冲突': '涉宗教', '涉民族矛盾': '涉民族',
  '涉领土主权': '涉领土', '涉争议': '涉争议人物',
};
function normalizeTag(t) {
  if (TAGS.includes(t)) return t;
  if (TAG_FIX[t]) return TAG_FIX[t];
  for (const [k, v] of Object.entries(TAG_FIX)) if (t.includes(k) || k.includes(t)) return v;
  return null;   // 无法映射则丢弃
}

/** 类型自洽：只有「通篇没提正确事件、只提了相反事件」才算错。
 *  例："田岛锅逝世，她是最后一位出生于19世纪的人。" —— 提到了"出生于"但主语是逝世，属正常，不该误报。 */
function typeSwap(r) {
  if (!r.out) return false;
  const death = /逝世|去世|牺牲|死亡|殉职|遇害|被杀/.test(r.out);
  const birth = /出生|诞生/.test(r.out);
  if (r.type === 'births' && death && !birth) return true;
  if (r.type === 'deaths' && birth && !death) return true;
  return false;
}

/* ---------- 维基残留检查（针对 merged.json 的原文）----------
   解析器漏掉的 wikitext 残渣：[[未闭合链接、{{模板、<ref>、&nbsp;、裸 URL。
   AI 的改写结果通常是干净的，但**原文**会原样显示在展示页的「原文」视图里，所以也要查。
   实测漏了 10 条（其中几条是把 "[[a|b" 截断成 "[[b" 的半截链接）。 */
const RESIDUE_RE = /\[\[|\{\{|<[a-zA-Z/][^>]*>|&(?:nbsp|amp|lt|gt|quot|#\d+);|https?:\/\//;
const { src } = require('./lib/paths');

/** 清掉残留：截断的模板/引用/裸链接一律从该标记起切掉 */
function cleanResidue(t) {
  let s = String(t || '');
  s = s.replace(/\{\{[^]*$/, '');                       // {{cite ... 到结尾（半截模板）
  s = s.replace(/\[\[[^\]]*$/, '');                     // [[未闭合链接到结尾
  s = s.replace(/\[https?:\/\/[^\]]*$/, '');            // [http://... 未闭合（旧式外链）
  s = s.replace(/<[a-zA-Z/][^>]*$/, '');                // <ref name=... 被截断在结尾
  s = s.replace(/\{\{[^{}]*\}\}/g, '');                 // 完整模板
  s = s.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2').replace(/\[\[([^\]]*)\]\]/g, '$1');
  s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '').replace(/<[^>]*>/g, '');
  s = s.replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, '$1');   // [url 文字] → 文字
  s = s.replace(/\s*https?:\/\/\S+/g, '');              // 裸 URL
  s = s.replace(/[（(][^）)]*$/, '');                    // 结尾半截括号
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  s = s.replace(/[\[【]\s*$/, '');                       // 结尾孤零零的开括号
  s = s.replace(/\s{2,}/g, ' ').replace(/[，、,。；;：:]\s*$/, '').trim();
  return s;
}

const mergedFile = path.join(ROOT, 'data', 'merged.json');
let residueList = [];
if (fs.existsSync(mergedFile)) {
  const merged = JSON.parse(fs.readFileSync(mergedFile, 'utf8'));
  for (const [k, day] of Object.entries(merged)) {
    for (const e of day.entries) if (RESIDUE_RE.test(e.text || '')) residueList.push({ day: k, e });
  }
}

console.log('\n=== 数据质量审计 ===');
console.log(`  总条数: ${all.length}`);

const badCat = all.filter((x) => !CATS.includes(x.cat));
const badTag = all.filter((x) => (x.tags || []).some((t) => !TAGS.includes(t)));
const badAct = all.filter((x) => !['keep', 'trim', 'flag'].includes(x.act));
const badSens = all.filter((x) => ![0, 1, 2, 3].includes(x.sens));
const badScore = all.filter((x) => !(Number.isFinite(x.score) && x.score >= 1 && x.score <= 100));
const trimNoOut = all.filter((x) => x.act === 'trim' && !x.out);
const flagNoOut = all.filter((x) => x.act === 'flag' && !x.out);
const typeSwapList = all.filter(typeSwap);

console.log(`  非法分类    : ${badCat.length}`);
console.log(`  非法标签    : ${badTag.length}`);
console.log(`  非法动作    : ${badAct.length}`);
console.log(`  非法敏感度  : ${badSens.length}`);
console.log(`  非法分数    : ${badScore.length}`);
console.log(`  trim无文本  : ${trimNoOut.length}`);
console.log(`  flag无改写  : ${flagNoOut.length}`);
console.log(`  类型自洽问题: ${typeSwapList.length}`);
console.log(`  原文维基残留: ${residueList.length}${residueList.length ? '   ← 加 --fix 可清（会备份 merged.json）' : ''}`);

if (badCat.length) {
  console.log('\n  --- 非法分类明细 ---');
  badCat.slice(0, 20).forEach((x) => console.log(`    [${x.id}] cat="${x.cat}" → 建议 "${normalizeCat(x.cat)}"  | ${x.src.slice(0, 40)}`));
}
if (typeSwapList.length) {
  console.log('\n  --- 类型自洽问题明细 ---');
  typeSwapList.slice(0, 20).forEach((x) => {
    console.log(`    [${x.id}] type=${x.type} year=${x.year}`);
    console.log(`       原: ${x.src}`);
    console.log(`       AI: ${x.out}`);
  });
}
if (badTag.length) {
  console.log('\n  --- 非法标签明细 ---');
  badTag.slice(0, 10).forEach((x) => console.log(`    [${x.id}] ${JSON.stringify(x.tags)}`));
}
if (residueList.length) {
  console.log('\n  --- 原文维基残留明细 ---');
  residueList.slice(0, 15).forEach(({ e }) => {
    console.log(`    [${e.id}] ${e.text.slice(0, 60)}`);
    console.log(`         → 清理后: ${cleanResidue(e.text).slice(0, 60) || '(空!)'}`);
  });
}

/* 动作分布 */
const g = {};
all.forEach((x) => g[x.act] = (g[x.act] || 0) + 1);
console.log('\n  动作分布:', JSON.stringify(g));

if (FIX) {
  let fixed = 0;
  let tagFixed = 0;
  const outLines = all.map((x) => {
    const nc = normalizeCat(x.cat);
    if (nc !== x.cat) { fixed++; x.cat = nc; }
    const nt = [...new Set((x.tags || []).map(normalizeTag).filter(Boolean))];
    if (nt.length !== (x.tags || []).length || nt.some((t, i) => t !== (x.tags || [])[i])) { tagFixed++; x.tags = nt; }
    return JSON.stringify(x);
  });
  const backup = file.replace('.jsonl', `.backup-${Date.now()}.jsonl`);
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, outLines.join('\n') + '\n', 'utf8');
  console.log(`\n  ✅ 已修复 ${fixed} 条非法分类、${tagFixed} 条非法标签，写回 ${file}`);
  console.log(`     原文件已备份: ${path.basename(backup)}`);
  console.log(`     ⚠️ 如果 worker 正在运行，新写入的行不会被修复，收尾时请再跑一次`);

  /* 原文残留清理 */
  if (residueList.length) {
    const merged = JSON.parse(fs.readFileSync(mergedFile, 'utf8'));
    let n = 0;
    for (const day of Object.values(merged)) {
      for (const e of day.entries) {
        if (RESIDUE_RE.test(e.text || '')) {
          const cleaned = cleanResidue(e.text);
          if (cleaned) { e.text = cleaned; n++; }
        }
      }
    }
    const mBackup = mergedFile.replace('.json', `.backup-${Date.now()}.json`);
    fs.copyFileSync(mergedFile, mBackup);
    fs.writeFileSync(mergedFile, JSON.stringify(merged), 'utf8');
    console.log(`  ✅ 已清理 ${n} 条原文维基残留，写回 ${mergedFile}`);
    console.log(`     原文件已备份: ${path.basename(mBackup)}`);
    console.log('     ⚠️ 原文变了但 AI 结果没变 —— 展示页的「原文」视图不会再有残留，成品不受影响');
  }
}

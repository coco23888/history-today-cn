/**
 * 生成「世界纪念日」JSON —— 直接从维基原始 wikitext 提取（保留国家/地区前缀）
 *
 * 用法:
 *   node src/build_observances.js              # 全流程
 *   node src/build_observances.js --no-ai      # 跳过英文翻译
 *   node src/build_observances.js --refresh-tpl # 重新解析国家模板
 *
 * 背景：主数据集里的 holidays 条目丢了国家前缀（维基用 {{ROC}}、{{USA}} 这类模板写，
 *      解析时被当垃圾剥掉了），导致出现裸的"云南起义纪念日"这种看不懂的条目。
 *      本脚本回到原始 wikitext 重新提取，并把 277 个国旗模板渲染成真实国名。
 *
 * 输入:  ../data-src/维基-历史上的今天离线/_raw/zh/*.txt
 * 输出:  data/world-observances.json
 *        data/country-templates.json（模板 → 国名 映射）
 */
const fs = require('fs');
const path = require('path');
const { chat, extractJSON, RateLimiter } = require('./lib/sf');
const { src } = require('./lib/paths');
const OpenCC = require('opencc-js');

/* 原始 wikitext 是繁体，输出统一转简体 */
const _cvt = OpenCC.Converter({ from: 'tw', to: 'cn' });
const toSimp = (s) => { let t = String(s || ''); for (let i = 0; i < 4; i++) { const n = _cvt(t); if (n === t) break; t = n; } return t; };

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const RAW = src('维基-历史上的今天离线', '_raw', 'zh');
const OUT = path.join(DATA, 'world-observances.json');
const TPL_MAP = path.join(DATA, 'country-templates.json');
const TRANS = path.join(DATA, 'observance-translations.json');

const args = process.argv.slice(2);
const NO_AI = args.includes('--no-ai');
const REFRESH_TPL = args.includes('--refresh-tpl');
const UA = 'onthisday/0.1 (local research)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= 1. 从原始 wikitext 提取节假日段落 ================= */

/** 抓出「节假日和习俗」这一节的所有行（保留 * / ** 层级） */
function extractHolidaySection(wikitext) {
  const lines = String(wikitext).split('\n');
  let i = -1;
  for (let k = 0; k < lines.length; k++) {
    const h = lines[k].match(/^==([^=].*?)==\s*$/);
    if (h && /節日|节日|習俗|习俗|風俗|风俗/.test(h[1])) { i = k + 1; break; }
  }
  if (i < 0) return [];
  const out = [];
  for (let k = i; k < lines.length; k++) {
    const line = lines[k];
    if (/^==[^=]/.test(line)) break;          // 下一个二级标题，结束
    if (/^\*/.test(line)) out.push(line);
  }
  return out;
}

/** 解析成 [{ region, items }]
 *  三种形态：
 *    * {{ROC}}：                    → 区域行，条目在下面的 ** 行
 *    * {{PAK}}：[[真納誕辰紀念日]]   → 区域行 + 内联条目
 *    * {{BHR}}、{{MEX}}：[[工程師節]] → 多区域 + 内联条目
 *    * 太陽神密特拉誕辰              → 无区域，整行就是条目
 */
const TPL = String.raw`\{\{[A-Za-z]{2,12}\}\}`;
const RE_REGION = new RegExp(`^((?:${TPL})(?:\\s*[、,，]\\s*(?:${TPL}))*)\\s*[：:]\\s*([\\s\\S]*)$`);

function parseGroups(lines) {
  const groups = [];
  let cur = null;
  for (const line of lines) {
    const depth = (line.match(/^\*+/) || [''])[0].length;
    const body = line.replace(/^\*+\s*/, '').trim();
    if (!body) continue;

    const m = body.match(RE_REGION);
    if (m) {
      const inline = m[2].trim();
      cur = { region: m[1], items: inline ? [inline] : [] };
      groups.push(cur);
    } else if (depth === 1) {
      cur = null;
      groups.push({ region: null, items: [body] });
    } else {
      if (!cur) { cur = { region: null, items: [] }; groups.push(cur); }
      cur.items.push(body);
    }
  }
  return groups;
}

/* ================= 2. 渲染国家模板 ================= */

function collectTemplates() {
  const set = new Set();
  for (const f of fs.readdirSync(RAW).filter((x) => /^\d+-\d+\.txt$/.test(x))) {
    const c = fs.readFileSync(path.join(RAW, f), 'utf8');
    for (const line of extractHolidaySection(c)) {
      for (const m of line.matchAll(/\{\{([A-Za-z]{2,12})\}\}/g)) set.add(m[1]);
    }
  }
  return [...set].sort();
}

/** 用维基 API 渲染模板为纯文本国名 */
async function renderTemplates(names) {
  const map = {};
  const BATCH = 45;
  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);
    const text = batch.map((n) => `{{${n}}}`).join('@@@');
    const url = 'https://zh.wikipedia.org/w/api.php?action=parse&format=json&prop=text&contentmodel=wikitext&text=' + encodeURIComponent(text);
    let html = null;
    for (let a = 1; a <= 3 && html === null; a++) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(45000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        html = (await r.json()).parse.text['*'];
      } catch (e) { await sleep(1200 * a); }
    }
    if (html === null) { console.log(`  ✗ 批 ${i / BATCH + 1} 渲染失败`); continue; }
    // 去标签取文本，再按分隔符切
    const plain = html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    const parts = plain.split('@@@');
    batch.forEach((n, k) => {
      const v = (parts[k] || '').trim();
      if (v) map[n] = v;
    });
    console.log(`  ✓ 批 ${i / BATCH + 1}（${batch.length} 个）`);
    await sleep(300);
  }
  return map;
}

/* ================= 3. 清洗 ================= */

function cleanText(s, tplMap) {
  let t = String(s || '');
  t = t.replace(/<ref[^>]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  t = t.replace(/\{\{([A-Za-z]{2,12})\}\}/g, (m, code) => tplMap[code] || '');
  t = t.replace(/\{\{[^{}]*\|([^{}|]*)\}\}/g, '$1');
  t = t.replace(/\{\{[^{}]*\}\}/g, '');
  t = t.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1');
  t = t.replace(/\[\[([^\]]*)\]\]/g, '$1');
  t = t.replace(/'''?/g, '');
  t = t.replace(/<[^>]*>/g, '');
  // HTML 实体（维基的 {{ROC}} 渲染出来带 &#160; 前缀）
  t = t.replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
  t = t.replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)));
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  t = t.replace(/\s*(?:time|date)\s*=\s*\d+/gi, '');
  t = t.replace(/^(?:time|date)\s*=\s*/i, '');
  t = t.replace(/\{\{|\}\}/g, '');
  t = t.replace(/[\s、，,；;：:]+$/, '');
  while (t && '、，,：:；; '.includes(t[0])) t = t.slice(1);
  t = t.replace(/([\u4e00-\u9fff])[0-9]+$/, '$1');
  t = t.replace(/\s+/g, ' ').trim();
  return toSimp(t);
}

const isAscii = (s) => /^[\x00-\x7F]+$/.test(s);
const isJunk = (t) => !t || /^-?\d{1,2}-\d{1,2}。?$/.test(t) || /^\d{4}-\d{1,2}-\d{1,2}。?$/.test(t) || /^(time|date)\s*=/i.test(t);

/* ================= 主流程 ================= */

(async () => {
  if (!fs.existsSync(RAW)) { console.error('找不到原始 wikitext 目录: ' + RAW); process.exit(1); }

  /* --- 国家模板映射 --- */
  const decode = (v) => String(v || '').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n))).replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  let tplMap = (!REFRESH_TPL && fs.existsSync(TPL_MAP)) ? JSON.parse(fs.readFileSync(TPL_MAP, 'utf8')) : {};
  for (const k of Object.keys(tplMap)) tplMap[k] = decode(tplMap[k]);
  const allTpl = collectTemplates();
  const missing = allTpl.filter((t) => !tplMap[t]);
  console.log(`\n=== 国家/地区模板 ===`);
  console.log(`  原始文件里共用到 ${allTpl.length} 个模板，已有映射 ${allTpl.length - missing.length} 个`);
  if (missing.length) {
    console.log(`  需要渲染 ${missing.length} 个…`);
    const got = await renderTemplates(missing);
    Object.assign(tplMap, got);
    fs.writeFileSync(TPL_MAP, JSON.stringify(tplMap, null, 1), 'utf8');
    console.log(`  渲染成功 ${Object.keys(got).length} / ${missing.length}`);
  }
  // 抽查
  console.log('  抽查: ' + ['ROC', 'USA', 'PRC', 'JPN', 'DDR', 'TWN'].map((k) => `${k}→${tplMap[k] || '?'}`).join('  '));

  /* --- 提取 --- */
  const days = {};
  const enSet = new Set();
  let rawGroups = 0, rawItems = 0, dropped = 0;

  for (const f of fs.readdirSync(RAW).filter((x) => /^\d+-\d+\.txt$/.test(x))) {
    const key = f.replace(/\.txt$/, '');
    const groups = parseGroups(extractHolidaySection(fs.readFileSync(path.join(RAW, f), 'utf8')));
    const outGroups = [];
    for (const g of groups) {
      rawGroups++;
      const region = g.region ? cleanText(g.region, tplMap) : '';
      const names = [];
      const seen = new Set();
      for (const it of g.items) {
        rawItems++;
        const t = cleanText(it, tplMap);
        if (isJunk(t)) { dropped++; continue; }
        const k = t.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        if (isAscii(t)) enSet.add(t);
        names.push(t);
      }
      if (!names.length) continue;
      const rec = {};
      if (region) rec.region = region;
      rec.names = names;
      outGroups.push(rec);
    }
    if (outGroups.length) days[key] = outGroups;
  }

  // 按日期排序
  const sorted = {};
  Object.keys(days).sort((a, b) => {
    const [am, ad] = a.split('-').map(Number), [bm, bd] = b.split('-').map(Number);
    return am - bm || ad - bd;
  }).forEach((k) => (sorted[k] = days[k]));

  const totalItems = Object.values(sorted).reduce((a, gs) => a + gs.reduce((x, g) => x + g.names.length, 0), 0);
  console.log(`\n=== 提取结果 ===`);
  console.log(`  分组 ${rawGroups} → ${Object.values(sorted).reduce((a, g) => a + g.length, 0)}，条目 ${rawItems} → ${totalItems}`);
  console.log(`  丢弃杂质 ${dropped}，覆盖 ${Object.keys(sorted).length} 天`);
  console.log(`  纯英文 ${enSet.size} 条`);

  /* --- 翻译英文 --- */
  const trans = fs.existsSync(TRANS) ? JSON.parse(fs.readFileSync(TRANS, 'utf8')) : {};
  const todoEn = [...enSet].filter((e) => !trans[e]).sort();
  if (!NO_AI && todoEn.length) {
    console.log(`\n=== 翻译 ${todoEn.length} 条英文 ===`);
    const limiter = new RateLimiter({ tpm: 100000, rpm: 1000, safety: 0.8 });
    const SYS = `你是翻译助手。用户给你一批英文的纪念日/节日名称，请翻译成简体中文。
要求：
1. 只输出 JSON 数组，长度和顺序与输入一致，不要解释、不要 markdown 代码块
2. 每项格式：{"en":"原文","zh":"中文译名"}
3. 译名符合中文习惯："World Polio Day"→"世界脊髓灰质炎日"、"German-American Day"→"德裔美国人日"
4. 人名/地名节庆音译或意译均可，优先常见译法
5. 不确定的按字面直译，不要编造背景`;
    for (let i = 0; i < todoEn.length; i += 25) {
      const batch = todoEn.slice(i, i + 25);
      const r = await chat({ system: SYS, user: JSON.stringify(batch), maxTokens: 2500, temperature: 0, limiter, estTokens: 3000 });
      if (!r.ok) { console.log(`  ✗ 批 ${i / 25 + 1}`); continue; }
      let arr = extractJSON(r.content);
      if (arr && !Array.isArray(arr)) arr = [arr];
      if (!Array.isArray(arr)) { console.log(`  ✗ 批 ${i / 25 + 1} 不可解析`); continue; }
      for (const it of arr) if (it && it.en && it.zh) trans[it.en] = it.zh;
      console.log(`  ✓ 批 ${i / 25 + 1}`);
    }
    fs.writeFileSync(TRANS, JSON.stringify(trans, null, 1), 'utf8');
  }

  // 替换英文
  let replaced = 0;
  for (const gs of Object.values(sorted)) {
    for (const g of gs) {
      g.names = g.names.map((n) => { if (trans[n]) { replaced++; return trans[n]; } return n; });
    }
  }

  /* --- 输出 --- */
  const out = {
    meta: {
      desc: '维基百科各日期条目「节假日和习俗」段落的纪念日 / 节日汇总（按国家/地区分组）',
      note: '循环纪念日，没有年份。已从主数据集剥离，避免混进「事件/出生/逝世」污染语义。中文节日另见 festival_info.json（来自百度源，含设立由来）。',
      source: 'zh.wikipedia.org 各「M月D日」条目的「节假日和习俗」段落',
      days: Object.keys(sorted).length,
      groups: Object.values(sorted).reduce((a, g) => a + g.length, 0),
      names: totalItems,
      countryTemplatesResolved: Object.keys(tplMap).length,
      englishTranslated: replaced,
      exportedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    },
    days: sorted,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1), 'utf8');

  console.log(`\n✅ ${OUT}`);
  console.log(`   ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB · ${totalItems} 条 · ${Object.keys(sorted).length} 天 · 翻译替换 ${replaced}`);
  console.log('\n样例 12-25:');
  (sorted['12-25'] || []).forEach((g) => console.log(`   ${(g.region || '(未标注地区)').padEnd(12)} ${g.names.join('、')}`));
  console.log('样例 10-6:');
  (sorted['10-6'] || []).forEach((g) => console.log(`   ${(g.region || '(未标注地区)').padEnd(12)} ${g.names.join('、')}`));
})();

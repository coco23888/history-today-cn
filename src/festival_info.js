/**
 * 抓取并提炼「节日由来」—— 这个节日是哪年、因为什么设立的
 *
 * 数据源：百度百科官方 API（BaikeLemmaCardApi）的 card 结构化字段 + abstract 摘要
 *   问题：card 值有引用角标残留（"…决定4"）且会截断；个别词条匹配错误（平安夜→一首歌）
 *   做法：抓全字段 → 清洗 + 匹配校验 → 交 AI 合成一句话由来
 *
 * 用法:
 *   node src/festival_info.js --fetch      # 抓取原始字段
 *   node src/festival_info.js --extract    # AI 合成由来
 *   node src/festival_info.js              # 两步都跑
 *   node src/festival_info.js --force      # 强制重抓
 *
 * 输入:  data/festivals.json          按天汇总的节日名
 * 中间:  data/festival_raw.json       原始字段（存档）
 * 输出:  data/festival_info.json      { "教师节": {"since":"1985","origin":"1985年1月…","area":"中国"} }
 */
const fs = require('fs');
const path = require('path');
const { chat, extractJSON, RateLimiter } = require('./lib/sf');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const RAW = path.join(DATA, 'festival_raw.json');
const OUT = path.join(DATA, 'festival_info.json');
const API = 'https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?appid=379020&bk_key=';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';

const args = process.argv.slice(2);
const DO_FETCH = args.includes('--fetch') || args.length === 0;
const DO_EXTRACT = args.includes('--extract') || args.length === 0;
const FORCE = args.includes('--force');

/** 清洗百度 card 值：去 HTML、去尾部引用角标数字 */
function cleanVal(s) {
  let t = String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return t.replace(/[\d\s]+$/, '').trim();   // 去掉尾部的引用编号（如 "…决定4"）
}

/** 匹配校验：返回的词条标题是否真的对得上查询词 */
function matchOk(query, title) {
  if (!title) return false;
  const q = query.replace(/^(国际|世界|全国|中国|国家)/, '');
  const t = title.replace(/^(国际|世界|全国|中国|国家)/, '');
  return title.includes(query) || query.includes(title) || t.includes(q) || q.includes(t);
}

async function fetchRaw(word, attempt = 1) {
  const res = await fetch(API + encodeURIComponent(word), {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  if (!j || !j.title) throw new Error('未找到词条');
  return j;
}

async function doFetch() {
  const fes = JSON.parse(fs.readFileSync(path.join(DATA, 'festivals.json'), 'utf8'));
  const names = [...new Set(Object.values(fes).flat())].sort();
  const raw = (!FORCE && fs.existsSync(RAW)) ? JSON.parse(fs.readFileSync(RAW, 'utf8')) : {};

  console.log(`\n=== 抓取节日字段（${names.length} 个）===`);
  let ok = 0, skip = 0, fail = 0, suspect = 0;

  for (const name of names) {
    if (raw[name] && raw[name].title && !FORCE) { skip++; continue; }
    let j = null;
    for (let a = 1; a <= 3 && !j; a++) {
      try { j = await fetchRaw(name); } catch (e) { if (a === 3) console.log(`  ✗ ${name}: ${e.message}`); await new Promise((r) => setTimeout(r, 400 * a)); }
    }
    if (!j) { fail++; continue; }

    const cards = {};
    for (const c of j.card || []) {
      const n = cleanVal(c.name);
      const v = (c.value || []).map(cleanVal).filter(Boolean).join(' ').trim();
      if (n && v) cards[n] = v;
    }
    const good = matchOk(name, j.title);
    if (!good) suspect++;

    raw[name] = {
      query: name, title: cleanVal(j.title), matched: good,
      desc: cleanVal(j.desc),
      abstract: String(j.abstract || '').replace(/[\d\s]+$/, '').trim(),
      cards,
      url: j.url || '',
      at: new Date().toISOString(),
    };
    ok++;
    const flag = good ? '✓' : '⚠匹配可疑';
    console.log(`  ${flag} ${name} → ${raw[name].title}  [${cards['节日起源'] || cards['设定时间'] || '无起源字段'}]`);
    await new Promise((r) => setTimeout(r, 200));
  }

  fs.writeFileSync(RAW, JSON.stringify(raw, null, 1), 'utf8');
  console.log(`\n  新增 ${ok} / 跳过 ${skip} / 失败 ${fail} / 匹配可疑 ${suspect}  →  ${RAW}`);
  return raw;
}

/* ---------- AI 合成 ---------- */
const SYS = `你是资料整理助手。用户给你一个节日名，以及从百度百科抓到的**结构化字段**和**摘要**。

请合成这个节日的**由来**（它是哪年、因为什么被设立的）。

要求：
1. 只输出 JSON 数组，长度和顺序与输入一致，不要任何解释文字，不要 markdown 代码块
2. 每项格式：{"name":"节日名","since":"设立年份（4位数字，不确定填空字符串）","origin":"一句话由来（20-45字）","ok":true}
3. origin 写清楚**哪年、由谁/因为什么设立**，例如：
   - 教师节 → "1985年1月，全国人大常委会决定每年9月10日为教师节。"
   - 世界卫生日 → "1948年联合国第一届世界卫生大会决定设立，以世卫组织宪章生效日4月7日为节日。"
   - 全国土地日 → "1991年5月24日国务院第83次常务会议决定设立。"
4. **不要盲信 matched 字段**。它只是"标题字面不完全一致"的提示，很多是**同一节日的不同名字**
   （如「世界环境保护日」返回「世界环境日」、「建党节」返回「中国共产党成立纪念日」、
   「国际志愿者日」返回「国际志愿人员日」）—— 这些是**正常别名，照常提炼**。
   只有当材料明显是**无关词条**时才拒绝，例如「平安夜」返回了一首叫《圣诞夜》的歌曲
   （desc/cards 全是作词作曲专辑等信息）。
5. **不要编造年份**。材料里确实没有设立信息就返回空 origin 且 ok=false。
6. 字段值可能有截断，你可以结合多个字段（如"设定时间"+"设立机构"）推断出完整意思，但不要凭空补事实。
7. 用简体中文，客观陈述，不加评价。`;

async function doExtract() {
  const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const names = Object.keys(raw).sort();
  const out = (!FORCE && fs.existsSync(OUT)) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const todo = names.filter((n) => !out[n] || FORCE);

  console.log(`\n=== AI 合成节日由来（待处理 ${todo.length} / 共 ${names.length}）===`);
  if (!todo.length) { console.log('  已完成'); return out; }

  const limiter = new RateLimiter({ tpm: 100000, rpm: 1000, safety: 0.8 });
  const BATCH = 12;
  let okc = 0, empty = 0, fail = 0;

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const payload = batch.map((n) => {
      const r = raw[n];
      return {
        name: n,
        matched: r.matched ? 'ok' : '匹配可疑',
        returnedTitle: r.title,
        desc: r.desc,
        cards: r.cards,
        abstract: (r.abstract || '').slice(0, 400),
      };
    });
    const res = await chat({
      system: SYS, user: JSON.stringify(payload), maxTokens: 4000,
      temperature: 0, limiter, estTokens: 4500,
    });
    if (!res.ok) { fail += batch.length; console.log(`  ✗ 批 ${i / BATCH + 1} 失败: ${JSON.stringify(res.error).slice(0, 100)}`); continue; }
    let arr = extractJSON(res.content);
    if (arr && !Array.isArray(arr)) arr = [arr];
    if (!Array.isArray(arr)) { fail += batch.length; console.log(`  ✗ 批 ${i / BATCH + 1} 无法解析`); continue; }

    for (const it of arr) {
      if (!it || !it.name) continue;
      const rec = {
        since: String(it.since || '').trim(),
        origin: String(it.origin || '').trim(),
        time: raw[it.name].cards['节日时间'] || '',
        type: raw[it.name].cards['节日类型'] || '',
        area: raw[it.name].cards['流行地区'] || '',
        url: raw[it.name].url,
      };
      if (!it.ok || !rec.origin) { rec.origin = ''; rec.since = ''; empty++; }
      else { okc++; }
      out[it.name] = rec;
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 1), 'utf8');
  const good = Object.values(out).filter((x) => x.origin).length;
  console.log(`\n  合成成功 ${okc} / 无由来 ${empty} / 失败 ${fail}`);
  console.log(`  最终有「由来」的节日: ${good} / ${names.length}  →  ${OUT}`);
  return out;
}

(async () => {
  if (DO_FETCH) await doFetch();
  if (DO_EXTRACT) await doExtract();
})();

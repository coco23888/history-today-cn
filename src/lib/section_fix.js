/**
 * 段落误分类修正 —— 被 prep_merge 和 patch_sections 共用，保证两处逻辑完全一致。
 *
 * 修的是两个解析器的 bug（都是「子串匹配章节名」导致的）：
 *   1) `法定出生日` 章节被当成了 births —— 那是民法条文说明，不是出生事件
 *   2) `体育` 章节整个被丢弃 —— 章节名匹配写成了子串，`体育` 没被认出来
 *
 * ⚠️ 为什么必须让 prep_merge 也调用它：
 *    pre_merge 是**从零重建 merged.json**（不是增量更新），如果不在这里一起修，
 *    每次重跑 `npm run prep` 都会把修正悄悄抹掉。这是真实踩过的坑。
 *
 * 新增条目的 id 用「不冲突的最小序号」，不移动已有 id，避免破坏已完成的 AI 结果。
 */
const fs = require('fs');
const path = require('path');
const OpenCC = require('opencc-js');

const _cvt = OpenCC.Converter({ from: 'tw', to: 'cn' });
const toSimp = (s) => { let t = String(s || ''); for (let i = 0; i < 4; i++) { const n = _cvt(t); if (n === t) break; t = n; } return t; };

/* ---- 复用解析器的清洗逻辑 ---- */
function wikiClean(s) {
  let t = String(s || '');
  t = t.replace(/<ref[^>]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  t = t.replace(/\{\{單雙書名號轉換\|([^{}]*)\}\}/g, '《$1》');
  t = t.replace(/\{\{[^{}]*\|([^{}|]*)\}\}/g, '$1');
  t = t.replace(/\{\{[^{}]*\}\}/g, '');
  t = t.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2');
  t = t.replace(/\[\[([^\]]*)\]\]/g, '$1');
  t = t.replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, '$1');
  t = t.replace(/'''?/g, '');
  t = t.replace(/<[^>]*>/g, '');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  t = t.replace(/^\s*[：:]\s*/, '');
  return t.replace(/\s+/g, ' ').trim();
}

function splitYear(line) {
  const s = line.replace(/^\*+\s*/, '').trim();
  let m = s.match(/^\[\[([^\]|]*?年[^\]|]*)(?:\|[^\]]*)?\]\]\s*[：:]?\s*([\s\S]*)$/);
  if (m) return { year: m[1].replace(/年$/, ''), body: m[2] };
  m = s.match(/^(\d{1,4})\s*年\s*[：:]?\s*([\s\S]*)$/);
  if (m) return { year: m[1], body: m[2] };
  m = s.match(/^([\d]{1,4})\s*[：:]\s*([\s\S]*)$/);
  if (m) return { year: m[1], body: m[2] };
  return { year: '', body: s };
}

const isJunk = (t) => /^(time|date)\s*=/i.test(t) || /^\d{4}-\d{1,2}-\d{1,2}。?$/.test(t);

/** 抓某个精确章节名（全等匹配，不是子串）下的条目 */
function sectionItems(wikitext, wanted) {
  const lines = String(wikitext).split('\n');
  let on = false;
  const out = [];
  for (const raw of lines) {
    const h = raw.match(/^==([^=].*?)==\s*$/);      // 只认 == X ==，子标题 === X === 不算
    if (h) { on = wanted.includes(h[1].trim()); continue; }
    if (/^=/.test(raw)) continue;
    if (!on || !/^\*/.test(raw)) continue;
    const { year, body } = splitYear(raw);
    const text = wikiClean(body);
    if (text && !isJunk(text)) out.push({ year, text });
  }
  return out;
}

/** 需要修正的日期 → 要补回的章节名 */
const SPORTS_DATES = ['10-29', '11-26', '11-6'];

/**
 * 就地修正 merged（会改传入的对象）
 * @param {object} merged  merged.json 的内容
 * @param {(date:string)=>string} readRaw  读取某天原始 wikitext 的函数（找不到返回 ''）
 * @returns {{removed:number, added:number, log:string[]}}
 */
function applySectionFix(merged, readRaw) {
  const log = [];
  const addedIds = [];
  let removed = 0, added = 0;

  /* ---------- 1. 删除误入 births 的「法定出生日」 ---------- */
  const raw71 = readRaw('7-1');
  if (raw71) {
    const badTexts = sectionItems(raw71, ['法定出生日']).map((x) => toSimp(x.text));
    if (badTexts.length) {
      log.push(`  「法定出生日」章节解析出 ${badTexts.length} 条（民法条文，不是出生事件）`);
      const day = merged['7-1'];
      if (day) {
        const before = day.entries.length;
        day.entries = day.entries.filter((e) => {
          const hit = e.type === 'births' && badTexts.includes(e.text);
          if (hit) { log.push(`    ✂ 删除 ${e.id}: ${e.text.slice(0, 50)}`); removed++; }
          return !hit;
        });
        log.push(`  7-1 条目数 ${before} → ${day.entries.length}`);
      }
    }
  }

  /* ---------- 2. 补回被丢弃的「体育」条目 ---------- */
  for (const date of SPORTS_DATES) {
    const raw = readRaw(date);
    if (!raw) continue;
    const items = sectionItems(raw, ['体育', '體育']);
    if (!items.length) continue;
    const day = merged[date];
    if (!day) continue;
    const existing = new Set(day.entries.map((e) => e.text));
    const [m, d] = date.split('-').map(Number);
    const mmdd = String(m).padStart(2, '0') + String(d).padStart(2, '0');
    for (const it of items) {
      const text = toSimp(it.text);
      if (existing.has(text)) continue;
      let idx = 0;
      while (day.entries.some((e) => e.id === `${mmdd}-e-${idx}`)) idx++;
      const rec = { id: `${mmdd}-e-${idx}`, date, type: 'events', typeCn: '事件', year: it.year, text };
      day.entries.push(rec);
      existing.add(text);
      added++;
      addedIds.push(rec.id);
      log.push(`    ➕ ${rec.id} [${it.year}] ${text.slice(0, 56)}`);
    }
  }

  return { removed, added, addedIds, log };
}

/** 从 RAW 目录造一个 readRaw（找不到文件返回空串，不抛异常） */
function rawReader(rawDir) {
  return (date) => {
    const f = path.join(rawDir, date + '.txt');
    try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; }
  };
}

module.exports = { applySectionFix, rawReader, sectionItems, toSimp, wikiClean, SPORTS_DATES };

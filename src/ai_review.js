/**
 * AI 审核/精简 worker（批量版）
 *
 * 一次请求处理多条（默认 20 条），把固定的 system 提示词成本摊薄 —— 输入 token 约降 10 倍。
 * 某一批失败时自动二分重试，最后定位到具体是哪条被拒绝，单独记入 errors。
 *
 * 用法:
 *   node src/ai_review.js --estimate                  # 只看时间/成本估算
 *   node src/ai_review.js --date=10-7                 # 只跑某一天
 *   node src/ai_review.js --spread=200                # 跨日期均匀抽 200 条
 *   node src/ai_review.js --limit=200 --concurrency=4
 *   node src/ai_review.js --batch=20                  # 每请求条数
 *   node src/ai_review.js --resume                    # 跳过已完成的，续跑
 *
 * 输出: data/ai/results.json  data/ai/errors.json
 */
const fs = require('fs');
const path = require('path');
const { chat, extractJSON, RateLimiter, MODEL } = require('./lib/sf');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const AI = path.join(DATA, 'ai');

/* ---------- 参数 ---------- */
const args = process.argv.slice(2);
const arg = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const has = (k) => args.includes(`--${k}`);

const LIMIT = parseInt(arg('limit', '0'), 10);
const SPREAD = parseInt(arg('spread', '0'), 10);
const DATE = arg('date', '');
const CONCURRENCY = parseInt(arg('concurrency', '5'), 10);
const BATCH = Math.max(1, parseInt(arg('batch', '20'), 10));
const RESUME = has('resume');
const ESTIMATE = has('estimate');
const ONLY_FAILED = has('only-failed');
const REPAIR = has('repair');
const MISSING = has('missing');   // 只处理还没有 AI 结果的条目（如新增的）

/** 校验一条 AI 结果是否合规；不合规的会被 --repair 重跑 */
const VALID_CATS = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'tags.json'), 'utf8')).categories.map((c) => c.key));
const VALID_TAGS = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'tags.json'), 'utf8')).sensitivityTags.map((t) => t.key));
function invalidResult(r) {
  if (!r) return false;                       // 未处理的不算"需要修复"
  if (!VALID_CATS.has(r.cat)) return 'bad_category';
  if ((r.tags || []).some((t) => !VALID_TAGS.has(t))) return 'bad_tag';
  if (!['keep', 'trim', 'flag'].includes(r.act)) return 'bad_action';
  if (![0, 1, 2, 3].includes(r.sens)) return 'bad_sens';
  if (!(Number.isFinite(r.score) && r.score >= 1 && r.score <= 100)) return 'bad_score';
  if (r.act === 'trim' && !r.out) return 'trim_without_text';
  // flag 现在也应给出改写文本（人工只负责放行），只有极少数允许留空
  // 出生/逝世写反：只有「通篇没提正确事件、只提了相反事件」才算错
  if (r.out) {
    const death = /逝世|去世|牺牲|死亡|殉职|遇害|被杀/.test(r.out);
    const birth = /出生|诞生/.test(r.out);
    if (r.type === 'births' && death && !birth) return 'birth_written_as_death';
    if (r.type === 'deaths' && birth && !death) return 'death_written_as_birth';
  }
  return false;
}

/* ---------- 载入 ---------- */
const merged = JSON.parse(fs.readFileSync(path.join(DATA, 'merged.json'), 'utf8').replace(/^\uFEFF/, ''));
const systemPrompt = fs.readFileSync(path.join(ROOT, 'config', 'prompt.md'), 'utf8')
  .replace(/^#[\s\S]*?\n---\n/, '')
  .trim();

fs.mkdirSync(AI, { recursive: true });
const resultsPath = path.join(AI, 'results.json');
const errorsPath = path.join(AI, 'errors.json');
const resultsJsonl = path.join(AI, 'results.jsonl');
const errorsJsonl = path.join(AI, 'errors.jsonl');

/* ---------- 载入已有进度（jsonl 为主，崩溃可恢复） ---------- */
const results = {};
const errors = [];
function loadJsonl(file, sink, key) {
  if (!fs.existsSync(file)) return 0;
  let n = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && o[key]) { sink[o[key]] = o; n++; } } catch (e) {}
  }
  return n;
}
// 先读 json 快照，再读 jsonl（jsonl 更新，覆盖旧值）
if (fs.existsSync(resultsPath)) { try { Object.assign(results, JSON.parse(fs.readFileSync(resultsPath, 'utf8'))); } catch (e) {} }
const loadedJsonl = loadJsonl(resultsJsonl, results, 'id');
// 错误用数组语义：jsonl 去重后重建
const errSeen = new Set();
for (const line of (fs.existsSync(errorsJsonl) ? fs.readFileSync(errorsJsonl, 'utf8').split('\n') : [])) {
  if (!line.trim()) continue;
  try { const o = JSON.parse(line); if (o && o.id && !errSeen.has(o.id)) { errSeen.add(o.id); errors.push(o); } } catch (e) {}
}
if (fs.existsSync(errorsPath)) { try { for (const o of JSON.parse(fs.readFileSync(errorsPath, 'utf8'))) if (o && o.id && !errSeen.has(o.id)) { errSeen.add(o.id); errors.push(o); } } catch (e) {} }

/* 追加写流（崩溃时已落盘的行不会丢）；同时更新内存计数 */
const resultsStream = fs.createWriteStream(resultsJsonl, { flags: 'a' });
const errorsStream = fs.createWriteStream(errorsJsonl, { flags: 'a' });
const recordResult = (o) => { results[o.id] = o; resultsStream.write(JSON.stringify(o) + '\n'); };
const recordError = (o) => { errors.push(o); errorsStream.write(JSON.stringify(o) + '\n'); };

/* ---------- 组任务 ---------- */
const allEntries = [];
for (const [, day] of Object.entries(merged)) {
  for (const e of day.entries) if (e.text && e.text.trim()) allEntries.push(e);
}

let tasks;
if (MISSING) {
  tasks = allEntries.filter((e) => !results[e.id]);
} else if (REPAIR) {
  tasks = allEntries.filter((e) => invalidResult(results[e.id]));
} else if (ONLY_FAILED) {
  const ids = new Set(errors.map((x) => x.id));
  tasks = allEntries.filter((e) => ids.has(e.id));
} else if (DATE) tasks = allEntries.filter((e) => e.date === DATE);
else if (SPREAD > 0) {
  const byDate = new Map();
  for (const e of allEntries) { if (!byDate.has(e.date)) byDate.set(e.date, []); byDate.get(e.date).push(e); }
  const dates = [...byDate.keys()].sort((a, b) => {
    const [am, ad] = a.split('-').map(Number), [bm, bd] = b.split('-').map(Number);
    return am - bm || ad - bd;
  });
  tasks = [];
  let round = 0;
  while (tasks.length < SPREAD) {
    let added = false;
    for (const d of dates) {
      const arr = byDate.get(d);
      if (round < arr.length) { tasks.push(arr[round]); added = true; if (tasks.length >= SPREAD) break; }
    }
    if (!added) break;
    round++;
  }
} else tasks = allEntries;
if (LIMIT > 0) tasks = tasks.slice(0, LIMIT);
if (RESUME && !ONLY_FAILED) tasks = tasks.filter((t) => !results[t.id]);

const batches = [];
for (let i = 0; i < tasks.length; i += BATCH) batches.push(tasks.slice(i, i + BATCH));

/* ---------- 估算 ---------- */
const SYS_TOKENS = Math.ceil(systemPrompt.length / 1.6);
const PER_ITEM_IN = 95, PER_ITEM_OUT = 160;
const estIn = batches.length * SYS_TOKENS + tasks.length * PER_ITEM_IN;
const estOut = tasks.length * PER_ITEM_OUT;
console.log('\n=== AI 审核任务（批量模式）===');
console.log(`  模型        : ${MODEL}`);
console.log(`  system 提示词: ${systemPrompt.length} 字 ≈ ${SYS_TOKENS} tokens（固定，可命中缓存）`);
console.log(`  批量大小    : ${BATCH} 条/请求 → ${batches.length} 个请求`);
console.log(`  待处理      : ${tasks.length} 条${RESUME ? '（--resume）' : ''}${ONLY_FAILED ? '（只重跑失败）' : ''}`);
console.log(`  并发        : ${CONCURRENCY}`);
console.log(`  预估输入    : ${(estIn / 1e6).toFixed(2)}M tokens`);
console.log(`  预估输出    : ${(estOut / 1e6).toFixed(2)}M tokens`);
console.log(`  预估费用    : ¥${(estIn / 1e6 * 4 + estOut / 1e6 * 6).toFixed(2)}（无缓存）
                 ¥${((SYS_TOKENS * batches.length) / 1e6 * 0.4 + (estIn - SYS_TOKENS * batches.length) / 1e6 * 4 + estOut / 1e6 * 6).toFixed(2)}（system 命中缓存）`);
console.log(`  预估耗时    : ${(((estIn + estOut) / 1e6) * 1000 / 100).toFixed(0)} 分钟（按 100k TPM 上限）`);

if (ESTIMATE) { console.log('\n(--estimate 模式，未调用接口)'); process.exit(0); }

/* ---------- 执行 ---------- */
const limiter = new RateLimiter({ tpm: 100000, rpm: 1000, safety: 0.85 });
let doneItems = 0, okItems = 0, failedItems = 0, reqCount = 0;
let kept = 0, trimmed = 0, flagged = 0;
let tokIn = 0, tokOut = 0, tokCached = 0;
const t0 = Date.now();

const saveAll = () => {
  fs.writeFileSync(resultsPath, JSON.stringify(results), 'utf8');
  fs.writeFileSync(errorsPath, JSON.stringify(errors, null, 1), 'utf8');
};

function report() {
  const el = (Date.now() - t0) / 1000;
  const rate = doneItems / Math.max(el, 0.001);
  const eta = rate > 0 ? (tasks.length - doneItems) / rate : 0;
  const cost = (tokIn - tokCached) / 1e6 * 4 + tokCached / 1e6 * 0.4 + tokOut / 1e6 * 6;
  process.stdout.write(
    `\r  ${doneItems}/${tasks.length} 条  请求 ${reqCount}  失败 ${failedItems}  ` +
    `keep ${kept}/trim ${trimmed}/flag ${flagged}  ${rate.toFixed(1)} 条/秒  ETA ${(eta / 60).toFixed(1)}分  ¥${cost.toFixed(3)}   `
  );
}

/** 处理一个条目数组；失败则二分 */
async function runBatch(items) {
  const user = JSON.stringify(items.map((e) => ({ id: e.id, t: e.typeCn, year: e.year, text: e.text })));
  const maxTokens = Math.min(8000, Math.max(400, items.length * PER_ITEM_OUT * 2));
  const r = await chat({ system: systemPrompt, user, maxTokens, temperature: 0, limiter, estTokens: SYS_TOKENS + items.length * PER_ITEM_IN + items.length * PER_ITEM_OUT });
  reqCount++;

  if (r.usage) {
    tokIn += r.usage.prompt_tokens || 0;
    tokOut += r.usage.completion_tokens || 0;
    tokCached += (r.usage.prompt_tokens_details && r.usage.prompt_tokens_details.cached_tokens) || 0;
  }

  let arr = null;
  if (r.ok) {
    const p = extractJSON(r.content);
    if (Array.isArray(p)) arr = p;
    else if (p && p.id) arr = [p];           // 模型偶尔只回一条
  }

  if (arr) {
    const byId = new Map(arr.filter((x) => x && x.id).map((x) => [x.id, x]));
    const missed = [];
    for (const e of items) {
      const p = byId.get(e.id);
      doneItems++;
      if (!p || !p.cat || !p.act) { missed.push(e); continue; }
      const rec = {
        id: e.id, date: e.date, type: e.type, typeCn: e.typeCn, year: e.year, src: e.text,
        cat: p.cat,
        tags: Array.isArray(p.tags) ? p.tags : [],
        sens: typeof p.sens === 'number' ? p.sens : 0,
        act: p.act,
        score: Number.isFinite(Number(p.score)) ? Math.max(1, Math.min(100, Math.round(Number(p.score)))) : 0,
        out: typeof p.out === 'string' ? p.out.trim() : '',
      };
      results[e.id] = rec;
      recordResult(rec);
      okItems++;
      if (p.act === 'keep') kept++; else if (p.act === 'trim') trimmed++; else if (p.act === 'flag') flagged++;
    }
    // 模型漏回的条目，降级为单条重试
    if (missed.length && items.length > 1) {
      doneItems -= missed.length; okItems -= 0;
      for (const e of missed) await runBatch([e]);
    } else if (missed.length) {
      for (const e of missed) {
        failedItems++; doneItems = doneItems; // 已计入
        recordError({ id: e.id, date: e.date, type: e.type, year: e.year, text: e.text,
          error: { kind: 'missing_in_response', message: (r.content || '').slice(0, 200) }, at: new Date().toISOString() });
      }
    }
    return;
  }

  // 整批失败
  if (items.length > 1) {
    const mid = Math.ceil(items.length / 2);
    await runBatch(items.slice(0, mid));
    await runBatch(items.slice(mid));
    return;
  }

  // 单条也失败 → 记录
  failedItems++; doneItems++;
  recordError({
    id: items[0].id, date: items[0].date, type: items[0].type, year: items[0].year, text: items[0].text,
    error: r.ok ? { kind: 'unparsable', message: (r.content || '').slice(0, 300) } : r.error,
    at: new Date().toISOString(),
  });
}

(async () => {
  const queue = [...batches];
  let sinceSave = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const b = queue.shift();
      if (!b) return;
      try { await runBatch(b); }
      catch (err) {
        for (const e of b) {
          failedItems++; doneItems++;
          recordError({ id: e.id, text: e.text, error: { kind: 'exception', message: String(err.message || err) }, at: new Date().toISOString() });
        }
      }
      // JSONL 已是持久层（逐条落盘），全量快照只为给 build_site.js 用，不必太频繁
      if (++sinceSave >= 25) { saveAll(); sinceSave = 0; }
      report();
    }
  });
  await Promise.all(workers);
  saveAll();
  resultsStream.end();
  errorsStream.end();

  const el = (Date.now() - t0) / 1000;
  const cost = (tokIn - tokCached) / 1e6 * 4 + tokCached / 1e6 * 0.4 + tokOut / 1e6 * 6;
  console.log('\n\n=== 完成 ===');
  console.log(`  处理    : ${doneItems} 条（成功 ${okItems}，失败 ${failedItems}）  请求 ${reqCount} 次`);
  console.log(`  动作分布: keep ${kept} / trim ${trimmed} / flag ${flagged}`);
  console.log(`  token   : 输入 ${tokIn}（缓存命中 ${tokCached}）+ 输出 ${tokOut}`);
  console.log(`  实际费用: ¥${cost.toFixed(4)}`);
  console.log(`  耗时    : ${(el / 60).toFixed(1)} 分钟（${(doneItems / el).toFixed(2)} 条/秒）`);
  console.log(`  结果    : ${resultsPath}`);
  if (errors.length) console.log(`  错误    : ${errorsPath}（${errors.length} 条）`);
})();

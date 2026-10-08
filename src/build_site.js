/**
 * 生成展示页：按日期 + 分类筛选，并能切换「原样 / AI 精简 / 对比」
 * 用法: node src/build_site.js
 * 输出: web/index.html（自包含，双击即开）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const merged = JSON.parse(fs.readFileSync(path.join(DATA, 'merged.json'), 'utf8').replace(/^\uFEFF/, ''));

/* AI 结果：以 results.jsonl 为准（逐条追加、实时），results.json 快照作为兜底 */
const results = {};
const resultsJson = path.join(DATA, 'ai', 'results.json');
const resultsJsonl = path.join(DATA, 'ai', 'results.jsonl');
if (fs.existsSync(resultsJson)) {
  try { Object.assign(results, JSON.parse(fs.readFileSync(resultsJson, 'utf8'))); } catch (e) {}
}
if (fs.existsSync(resultsJsonl)) {
  for (const line of fs.readFileSync(resultsJsonl, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && o.id) results[o.id] = o; } catch (e) {}
  }
}

const errors = [];
const errSeen = new Set();
for (const f of [path.join(DATA, 'ai', 'errors.json'), path.join(DATA, 'ai', 'errors.jsonl')]) {
  if (!fs.existsSync(f)) continue;
  const txt = fs.readFileSync(f, 'utf8');
  const items = f.endsWith('.jsonl')
    ? txt.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean)
    : (() => { try { return JSON.parse(txt); } catch (e) { return []; } })();
  for (const o of items) if (o && o.id && !errSeen.has(o.id)) { errSeen.add(o.id); errors.push(o); }
}
const tagsCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'tags.json'), 'utf8'));
const festivalInfo = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'festival_info.json'), 'utf8')); } catch (e) { return {}; } })();

/* ---------- 组装紧凑数据 ---------- */
const TYPE_CODE = { events: 'e', births: 'b', deaths: 'd', holidays: 'h' };
const days = {};
let totalEntries = 0, aiCount = 0;

/** 维基节日段落里的解析残留（如 "time=2020-1-3。"），不展示 */
const isJunkText = (t) => /^(time|date)\s*=/i.test(String(t || '').trim()) || /^\d{4}-\d{1,2}-\d{1,2}。?$/.test(String(t || '').trim());

/** 日期键统一补零成 MM-DD（merged.json 里是 '1-1'/'10-8'，页面里统一成 '01-01'/'10-08'） */
const padKey = (k) => {
  const m = String(k).match(/^(\d{1,2})-(\d{1,2})$/);
  return m ? String(+m[1]).padStart(2, '0') + '-' + String(+m[2]).padStart(2, '0') : String(k);
};

for (const [key, day] of Object.entries(merged)) {
  // 每条: [typeCode, year, text, aiIndex|null]
  // 【剥离】维基「节日」条目（type=holidays）—— 循环纪念日、无年份、多为外国节日，
  // 混在事件/出生/逝世里会污染语义。中文节日由百度源单独提供（带由来）。
  const entries = day.entries.filter((e) => e.type !== 'holidays' && !isJunkText(e.text)).map((e) => {
    totalEntries++;
    const ai = results[e.id];
    let aiArr = null;
    if (ai) {
      aiCount++;
      aiArr = [ai.cat, ai.tags, ai.sens, ai.act, ai.out || '', ai.score || 0];
    }
    return [TYPE_CODE[e.type], e.year, e.text, aiArr];
  });
  // 键统一补零（'1-1' -> '01-01'、'10-8' -> '10-08'），页面里所有查表（含「今天」）都用同一套写法
  days[padKey(key)] = { key: padKey(key), m: day.month, d: day.day, f: day.festivals || [], fes: (day.festivals || []).map((n) => {
    const info = festivalInfo[n] || {};
    return { name: n, since: info.since || '', origin: info.origin || '', time: info.time || '', area: info.area || '' };
  }), e: entries };
}

const DATA_OBJ = {
  generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
  categories: tagsCfg.categories.map((c) => c.key),
  sensTags: tagsCfg.sensitivityTags.map((t) => t.key),
  stats: { totalEntries, aiCount, days: Object.keys(days).length, errors: errors.length },
  errors: errors.slice(0, 300).map((e) => ({ id: e.id, text: e.text, kind: (e.error && e.error.kind) || '?', status: (e.error && e.error.status) || 0 })),
  days,
};

const json = JSON.stringify(DATA_OBJ).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');

/* 两种打包方式：
 *   默认（拆分）  web/index.html 是个几十 KB 的空壳，数据放 web/data.json，用 fetch 加载
 *                 —— 页面小、数据可单独缓存/替换，起 `npm run review` 或任意静态服务访问
 *   --standalone  web/standalone.html 把数据内嵌进去，单文件双击即开（约 10 MB）
 */
const STANDALONE = process.argv.includes('--standalone');
const OUT_NAME = STANDALONE ? 'standalone.html' : 'index.html';
const OUT = path.join(ROOT, 'web', OUT_NAME);
const OUT_DATA = path.join(ROOT, 'web', 'data.json');
const BOOT = STANDALONE
  ? `const DATA = ${json};`
  : `const DATA = await fetch('./data.json').then(r => {
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
});
(function () { const b = document.getElementById('boot'); if (b) b.style.display = 'none'; })();`;

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>历史上的今天 · 数据展示</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--panel2:#1c2330;--line:#2a3240;--fg:#e6edf3;--dim:#8b949e;--dim2:#6e7681;
--accent:#58a6ff;--green:#3fb950;--red:#f85149;--amber:#d29922;--purple:#bc8cff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
a{color:var(--accent)}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px 70px}

header{background:linear-gradient(160deg,#161b22,#0d1117 70%);border-bottom:1px solid var(--line);padding:26px 0 20px}
h1{margin:0 0 6px;font-size:24px}
.sub{color:var(--dim);font-size:13.5px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:10px;margin:18px 0 0}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:11px 13px}
.stat b{display:block;font-size:20px}.stat span{color:var(--dim);font-size:12px}
.stat.g b{color:var(--green)}.stat.a b{color:var(--amber)}.stat.p b{color:var(--purple)}

.bar{position:sticky;top:0;z-index:40;background:rgba(13,17,23,.95);backdrop-filter:blur(8px);
border-bottom:1px solid var(--line);padding:10px 0}
.bar .inner{max-width:1180px;margin:0 auto;padding:0 20px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
select,input[type=search]{background:var(--panel);border:1px solid var(--line);color:var(--fg);
border-radius:8px;padding:7px 11px;font:inherit;font-size:13.5px}
select:focus,input:focus{outline:none;border-color:var(--accent)}
.toggle{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.toggle button{background:var(--panel);border:0;color:var(--dim);padding:7px 13px;font:inherit;font-size:13px;cursor:pointer}
.toggle button.on{background:#1f6feb;color:#fff}
.dnav{display:flex;align-items:center;gap:6px}
.dnav button{background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:8px;
padding:7px 11px;font:inherit;font-size:13px;cursor:pointer;line-height:1.2}
.dnav button:hover{border-color:var(--accent);color:var(--accent)}
.dnav button.on{background:#1f6feb;border-color:#1f6feb;color:#fff}
.dnav button:disabled{opacity:.4;cursor:default}
.dnav #date{min-width:200px;font-variant-numeric:tabular-nums}
#dayNav{color:var(--dim2);font-size:11.5px;font-weight:400;margin-left:6px}

h2{font-size:19px;margin:34px 0 10px;padding-bottom:9px;border-bottom:1px solid var(--line);
display:flex;gap:10px;align-items:center;flex-wrap:wrap}
h2 .n{font-size:12px;color:var(--dim2);font-weight:400;background:var(--panel2);padding:2px 9px;border-radius:20px;border:1px solid var(--line)}
.fes{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0 0}
.fescard{background:#1d1806;border:1px solid #7a5c11;border-radius:9px;padding:8px 12px;max-width:520px}
.fescard .fesname{color:var(--amber);font-size:13.5px;font-weight:600}
.fescard .since{color:var(--dim2);font-weight:400;font-size:12px;margin-left:5px}
.fescard .fesori{color:var(--fg);font-size:13px;margin-top:4px;line-height:1.5}
.fescard .fesori.dim{color:var(--dim2)}
.fescard .fesmeta{color:var(--dim2);font-size:11.5px;margin-top:4px}

.chips{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}
.chip{background:var(--panel2);border:1px solid var(--line);color:var(--dim);font-size:12.5px;
padding:4px 11px;border-radius:20px;cursor:pointer;user-select:none}
.chip:hover{color:var(--fg)}
.chip.on{background:#1f6feb;border-color:#1f6feb;color:#fff}
.chip .c{opacity:.7;margin-left:5px;font-size:11px}

.item{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:10px;padding:13px 15px}
.item.flagged{border-color:#8b2c26;background:#1d1213}
.item .top{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:7px}
.item .yr{color:var(--amber);font-weight:700;font-size:13.5px;font-variant-numeric:tabular-nums}
.pill{font-size:11px;padding:1.5px 8px;border-radius:5px;background:#0d1117;border:1px solid var(--line);color:var(--dim)}
.pill.cat{color:var(--accent);border-color:#1f4d80}
.pill.tag{color:var(--purple);border-color:#5a3f96}
.pill.sens0{color:var(--green);border-color:#1f6f36}
.pill.sens1{color:var(--amber);border-color:#7a5c11}
.pill.sens2{color:#ff9e64;border-color:#8a4b1a}
.pill.sens3{color:var(--red);border-color:#8b2c26}
.pill.keep{color:var(--dim2)}
.pill.trim{color:var(--green);border-color:#1f6f36}
.pill.flag{color:var(--red);border-color:#8b2c26}
.pill.score{color:var(--amber);border-color:#7a5c11;font-weight:700}
.chips .lbl{color:var(--dim2);font-size:12px;align-self:center;margin-right:3px}
.pill.type{color:var(--dim)}

.src{color:var(--fg);font-size:14px}
.srcOnly .out{display:none}
.outOnly .src{display:none}
.compare .src{color:var(--dim)}
.compare .src::before{content:"原 ";color:var(--dim2);font-size:12px}
.compare .out{margin-top:6px}
.compare .out::before{content:"AI ";color:var(--green);font-size:12px}
.out{color:var(--green);font-size:14.5px}
.noai{color:var(--dim2);font-size:12.5px;margin-top:6px}
.len{font-size:11.5px;color:var(--dim2);margin-left:6px}
.empty{color:var(--dim);text-align:center;padding:40px 0}
#boot{max-width:1180px;margin:0 auto;padding:26px 20px;color:var(--dim);font-size:13.5px}
#boot code{background:var(--panel2);border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:12.5px}
#boot .err{color:var(--red)}
footer{color:var(--dim2);font-size:12.5px;text-align:center;margin-top:50px;padding-top:20px;border-top:1px solid var(--line)}
</style></head>
<body>
<div id="boot">正在加载 <code>data.json</code>…</div>
<script>
window.addEventListener('error', function (e) {
  var b = document.getElementById('boot');
  if (b && b.style.display !== 'none') {
    b.innerHTML = '<span class="err">加载 data.json 失败：' + (e.message || e) + '</span><br><br>'
      + '如果是双击打开的（file:// 协议），浏览器会拦下 fetch —— 请改用：<br>'
      + '　① <code>npm run review</code> 然后访问 <code>http://127.0.0.1:8770/index.html</code>，或<br>'
      + '　② 生成单文件版本：<code>node src/build_site.js --standalone</code> → <code>web/standalone.html</code>';
  }
});
</script>
<header><div class="wrap" style="padding-bottom:0">
  <h1>历史上的今天 · 数据展示</h1>
  <div class="sub">简体中文维基数据 + 百度节日 · AI 审核精简对照 · 生成于 <span id="gen"></span><br>
  数据截至 <b id="genYear"></b> · 每条带分类 / 标签 / 敏感度 / 中国关注度评分 · 可按敏感度筛选、按分数排序</div>
  <div class="stats" id="stats"></div>
</div></header>

<div class="bar"><div class="inner">
  <div class="dnav">
    <button id="prevDay" title="上一天（快捷键 ←）">◀</button>
    <select id="date"></select>
    <button id="nextDay" title="下一天（快捷键 →）">▶</button>
    <button id="todayBtn" title="跳到今天（快捷键 t）">今天</button>
  </div>
  <div class="toggle" id="view">
    <button data-v="compare" class="on">对比</button>
    <button data-v="srcOnly">只看原样</button>
    <button data-v="outOnly">只看 AI</button>
  </div>
  <input type="search" id="q" placeholder="🔍 搜索条目…" style="flex:1;min-width:150px">
</div></div>

<div class="wrap">
  <h2 id="dayTitle">—</h2>
  <div class="fes" id="festivals"></div>

  <div class="chips" id="typeChips"></div>
  <div class="chips" id="catChips"></div>
  <div class="chips" id="extraChips"></div>

  <div id="list"></div>
</div>
<footer>数据：维基百科（CC BY-SA）+ 百度百科官方源 · AI：DeepSeek-V3.2 via SiliconFlow<br>
生成脚本 <span style="font-family:monospace">src/build_site.js</span></footer>

<script>
${BOOT}
const $ = (s,r=document)=>r.querySelector(s);
const esc = s => String(s==null?'':s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const TYPE_CN = {e:'事件',b:'出生',d:'逝世',h:'节日'};
const TCODE = {events:'e',births:'b',deaths:'d',holidays:'h'};
const tcode = (t)=>TCODE[t]||t;

/* ---------- 日期工具（键统一为补零 MM-DD） ---------- */
const DATES = Object.keys(DATA.days).sort((a,b)=>{
  const [am,ad]=a.split('-').map(Number),[bm,bd]=b.split('-').map(Number);
  return am-bm||ad-bd;
});
const padKey = (k)=>{const m=String(k||'').match(/^(\\d{1,2})-(\\d{1,2})$/);return m?String(+m[1]).padStart(2,'0')+'-'+String(+m[2]).padStart(2,'0'):'';};
const DAYS_IN_MONTH = [31,29,31,30,31,30,31,31,30,31,30,31];
function stepDate(key, delta){
  let [m,d] = key.split('-').map(Number);
  d += delta;
  while(d < 1){ m--; if(m<1)m=12; d += DAYS_IN_MONTH[m-1]; }
  while(d > DAYS_IN_MONTH[m-1]){ d -= DAYS_IN_MONTH[m-1]; m++; if(m>12)m=1; }
  return String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
}
const todayKey = ()=>{const t=new Date();return String(t.getMonth()+1).padStart(2,'0')+'-'+String(t.getDate()).padStart(2,'0');};

let curDate = (function(){
  const saved = padKey(new URLSearchParams(location.search).get('d'));
  if(saved && DATA.days[saved]) return saved;
  const t = todayKey();
  if(DATA.days[t]) return t;
  return DATES[0];
})();
let curType = '';
let curCat = null;
let curTag = null;
let curSens = null;
let curAct = null;
let curView = 'compare';
let kw = '';

/* ---------- 顶部统计 ---------- */
(function(){
  const s = DATA.stats;
  const cov = (100*s.aiCount/s.totalEntries).toFixed(1);
  $('#stats').innerHTML = [
    ['', s.totalEntries.toLocaleString(), '总条目'],
    ['g', s.aiCount.toLocaleString(), 'AI 已处理'],
    ['', cov+'%', 'AI 覆盖率'],
    ['p', s.days, '覆盖天数'],
    ['a', s.errors, '处理失败'],
  ].map(([k,v,l])=>\`<div class="stat \${k}"><b>\${v}</b><span>\${l}</span></div>\`).join('');
  $('#gen').textContent = DATA.generatedAt;
  // 数据的「新鲜度」：让使用者一眼知道这份数据有多新
  const gy = document.getElementById('genYear');
  if (gy) gy.textContent = (DATA.generatedAt || '').slice(0, 7);
})();

/* ---------- 日期下拉 ---------- */
(function(){
  // 键已经统一成零填充 MM-DD（见构建时的 padKey），这里直接用
  const keys = Object.keys(DATA.days).sort((a,b)=>{
    const [am,ad]=a.split('-').map(Number),[bm,bd]=b.split('-').map(Number);
    return am-bm||ad-bd;
  });
  const sel = $('#date');
  sel.innerHTML = keys.map(k=>{
    const d = DATA.days[k];
    const mark = d.f.length ? ' 🎉' : '';
    return \`<option value="\${k}"\${k===curDate?' selected':''}>\${d.m} 月 \${d.d} 日 · \${d.e.length} 条\${mark}</option>\`;
  }).join('');
  sel.onchange = () => goDate(sel.value);
  $('#prevDay').onclick = () => stepDay(-1);
  $('#nextDay').onclick = () => stepDay(1);
  $('#todayBtn').onclick = () => goDate(todayKey());
})();

/* 跳日期：写进 URL 的 ?d=，刷新后还停在同一天；停在今天就保持干净地址 */
function goDate(key){
  if(!key || !DATA.days[key]) return;
  curDate = key;
  curType = ''; curCat = curTag = curAct = curSens = null;
  const sel = $('#date');
  if(sel && sel.value !== key) sel.value = key;
  syncNav();
  buildChips(); render();
  window.scrollTo({top:0,behavior:'smooth'});
}
function stepDay(delta){
  const i = DATES.indexOf(curDate);
  if(i < 0) return;
  const t = i + delta;
  if(t < 0 || t >= DATES.length) return;
  goDate(DATES[t]);
}
function syncNav(){
  const i = DATES.indexOf(curDate), t = todayKey();
  const prev = $('#prevDay'), next = $('#nextDay');
  if(prev) prev.disabled = i <= 0;
  if(next) next.disabled = i < 0 || i >= DATES.length - 1;
  const tb = $('#todayBtn');
  if(tb) tb.classList.toggle('on', curDate === t);
  window.history.replaceState(null, '', curDate === t ? location.pathname : '?d=' + curDate);
}
document.addEventListener('keydown', (ev)=>{
  if(['INPUT','TEXTAREA','SELECT'].includes(ev.target.tagName)) return;
  if(ev.key === 'ArrowLeft'){ ev.preventDefault(); stepDay(-1); }
  else if(ev.key === 'ArrowRight'){ ev.preventDefault(); stepDay(1); }
  else if(ev.key === 't'){ ev.preventDefault(); goDate(todayKey()); }
});
syncNav();

/* ---------- 分类 / 类型 / 标签 chips（日期变化时需重建） ---------- */
function buildChips(){
  const day = DATA.days[curDate];
  const counts = {};
  day.e.forEach(e=>{ if(e[3]) counts[e[3][0]] = (counts[e[3][0]]||0)+1; });
  const cats = DATA.categories.filter(c=>counts[c]);
  $('#catChips').innerHTML = \`<span class="lbl">分类</span><span class="chip \${curCat===null?'on':''}" data-cat="">全部 <span class="c">\${day.e.length}</span></span>\`
    + cats.map(c=>\`<span class="chip \${curCat===c?'on':''}" data-cat="\${esc(c)}">\${esc(c)} <span class="c">\${counts[c]}</span></span>\`).join('');

  // 类型 chips（事件 / 出生 / 逝世 / 节日）
  const tcount = {};
  day.e.forEach(e=>{ tcount[e[0]] = (tcount[e[0]]||0)+1; });
  $('#typeChips').innerHTML = '<span class="lbl">类型</span>'
    + [['e','事件'],['b','出生'],['d','逝世'],['h','节日']].filter(([k])=>tcount[k])
        .map(([k,l])=>\`<span class="chip \${curType===k?'on':''}" data-type="\${k}">\${l} <span class="c">\${tcount[k]}</span></span>\`).join('');

  const tags = {}, acts = {}, sens = {};
  day.e.forEach(e=>{ if(!e[3])return;
    (e[3][1]||[]).forEach(t=>tags[t]=(tags[t]||0)+1);
    acts[e[3][3]]=(acts[e[3][3]]||0)+1;
    sens[e[3][2]]=(sens[e[3][2]]||0)+1;
  });
  let extra = '<span class="lbl">动作</span><span class="chip '+(curAct===null?'on':'')+'" data-act="">全部</span>';
  [['keep','原样保留'],['trim','AI精简'],['flag','待人工复核']].forEach(([k,l])=>{
    if(acts[k]) extra += \`<span class="chip \${curAct===k?'on':''}" data-act="\${k}">\${l} <span class="c">\${acts[k]}</span></span>\`;
  });
  Object.keys(tags).sort((a,b)=>tags[b]-tags[a]).forEach(t=>{
    extra += \`<span class="chip \${curTag===t?'on':''}" data-tag="\${esc(t)}">#\${esc(t)} <span class="c">\${tags[t]}</span></span>\`;
  });
  [0,1,2,3].forEach(s=>{ if(sens[s]) extra += \`<span class="chip \${curSens===s?'on':''}" data-sens="\${s}">敏感度 \${s} <span class="c">\${sens[s]}</span></span>\`; });
  $('#extraChips').innerHTML = extra;

  // 点击已选中的 chip 可取消选择
  document.querySelectorAll('[data-type]').forEach(el=>el.onclick=()=>{ const v=el.dataset.type; curType = curType===v?'':v; buildChips(); render(); });
  document.querySelectorAll('[data-cat]').forEach(el=>el.onclick=()=>{ const v=el.dataset.cat; curCat = (v===''||curCat===v)?null:v; buildChips(); render(); });
  document.querySelectorAll('[data-act]').forEach(el=>el.onclick=()=>{ const v=el.dataset.act; curAct = (v===''||curAct===v)?null:v; buildChips(); render(); });
  document.querySelectorAll('[data-tag]').forEach(el=>el.onclick=()=>{ const v=el.dataset.tag; curTag = curTag===v?null:v; buildChips(); render(); });
  document.querySelectorAll('[data-sens]').forEach(el=>el.onclick=()=>{ const n=Number(el.dataset.sens); curSens = curSens===n?null:n; buildChips(); render(); });
}
buildChips();

/* ---------- 视图切换 ---------- */
document.querySelectorAll('#view button').forEach(b=>{
  b.onclick = ()=>{
    document.querySelectorAll('#view button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on'); curView = b.dataset.v; render();
  };
});
$('#q').addEventListener('input', e=>{ kw = e.target.value.trim(); render(); });

/* ---------- 渲染 ---------- */
function render(){
  const day = DATA.days[curDate];
  const di = DATES.indexOf(curDate), isToday = curDate === todayKey();
  $('#dayTitle').innerHTML = \`\${day.m} 月 \${day.d} 日 <span class="n">\${day.e.length} 条</span>\`
    + \`<span id="dayNav">第 \${di+1} / \${DATES.length} 天\${isToday?' · 今天':''}</span>\`;
  $('#festivals').innerHTML = (day.fes || []).map(f=>\`<div class="fescard">
      <div class="fesname">🎉 \${esc(f.name)}\${f.since?\` <span class="since">\${esc(f.since)} 年设立</span>\`:''}</div>
      \${f.origin?\`<div class="fesori">\${esc(f.origin)}</div>\`:'<div class="fesori dim">（未查到设立由来）</div>'}
      <div class="fesmeta">\${[f.time, f.area].filter(Boolean).map(esc).join(' · ')}</div>
    </div>\`).join('');

  // chips 状态同步（重新渲染 chips 以更新高亮）
  document.querySelectorAll('[data-cat]').forEach(el=>el.classList.toggle('on', (el.dataset.cat||null)===curCat));
  document.querySelectorAll('[data-act]').forEach(el=>el.classList.toggle('on', (el.dataset.act||null)===curAct));
  document.querySelectorAll('[data-tag]').forEach(el=>el.classList.toggle('on', (el.dataset.tag||null)===curTag));
  document.querySelectorAll('[data-sens]').forEach(el=>el.classList.toggle('on', (el.dataset.sens===''?null:Number(el.dataset.sens))===curSens));

  let list = day.e.filter(e=>{
    const ai = e[3];
    if(curType && tcode(curType)!==e[0]) return false;
    if(curCat && (!ai || ai[0]!==curCat)) return false;
    if(curAct && (!ai || ai[3]!==curAct)) return false;
    if(curTag && (!ai || !(ai[1]||[]).includes(curTag))) return false;
    if(curSens!==null && (!ai || ai[2]!==curSens)) return false;
    if(kw){
      const hay = (e[2]+' '+(ai?ai[4]:'')+' '+(ai?ai[0]:'')+' '+(ai?(ai[1]||[]).join(' '):'')).toLowerCase();
      if(!hay.includes(kw.toLowerCase())) return false;
    }
    return true;
  });

  // 排序：默认按分数降序（同一天内优先展示关注度高的）
  list = list.slice().sort((a,b)=>{
    const sa=(a[3]&&a[3][5])||0, sb=(b[3]&&b[3][5])||0;
    return sb-sa;
  });

  if(!list.length){ $('#list').innerHTML = '<div class="empty">没有匹配的条目</div>'; return; }

  const viewCls = curView==='compare'?'compare':(curView==='outOnly'?'outOnly':'srcOnly');
  $('#list').innerHTML = list.map(e=>{
    const [t,y,text,ai] = e;
    const cat = ai?ai[0]:'', tags = ai?(ai[1]||[]):[], sens = ai?ai[2]:null, act = ai?ai[3]:'', out = ai?ai[4]:'', score = ai?(ai[5]||0):0;
    const pills = [
      \`<span class="pill type">\${TYPE_CN[t]}</span>\`,
      cat?\`<span class="pill cat">\${esc(cat)}</span>\`:'',
      act?\`<span class="pill \${act}">\${{keep:'原样',trim:'AI精简',flag:'待复核'}[act]||act}</span>\`:'',
      score?\`<span class="pill score">\${score} 分</span>\`:'',
      sens!==null?\`<span class="pill sens\${sens}">敏感 \${sens}</span>\`:'',
      ...tags.map(x=>\`<span class="pill tag">#\${esc(x)}</span>\`),
    ].filter(Boolean).join('');
    const lenInfo = (ai && out) ? \`<span class="len">\${text.length} → \${out.length} 字</span>\` : '';
    const yearHtml = y ? \`<span class="yr">\${esc(y)}</span>\` : (t==='h' ? '<span class="yr">每年</span>' : '');
    return \`<div class="item \${act==='flag'?'flagged':''}">
      <div class="top">\${yearHtml}\${pills}\${lenInfo}</div>
      <div class="\${viewCls}">
        <div class="src">\${esc(text)}</div>
        \${out?\`<div class="out">\${esc(out)}</div>\`:(ai&&act==='keep'?'<div class="noai">（AI 判定原样即最佳）</div>':'')}
      </div>
      \${!ai?'<div class="noai">（该条尚未经 AI 处理）</div>':''}
    </div>\`;
  }).join('');
}

render();
</script>
</body></html>`;

fs.writeFileSync(OUT, html, 'utf8');
if (!STANDALONE) fs.writeFileSync(OUT_DATA, JSON.stringify(DATA_OBJ), 'utf8');
const kb = fs.statSync(OUT).size / 1024;
console.log('\n=== 展示页已生成 ===');
console.log(`  输出      : ${OUT}  (${kb > 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(1) + ' KB'})`);
if (!STANDALONE) {
  const dkb = fs.statSync(OUT_DATA).size / 1024;
  console.log(`  数据      : ${OUT_DATA}  (${(dkb / 1024).toFixed(2)} MB，页面用 fetch 加载)`);
  console.log('              打开方式: npm run review → http://127.0.0.1:8770/index.html');
} else {
  console.log('              单文件版，双击即开（数据已内嵌）');
}
console.log(`  总条目    : ${totalEntries}`);
console.log(`  AI 已处理 : ${aiCount} (${(100 * aiCount / totalEntries).toFixed(1)}%)`);
console.log(`  覆盖天数  : ${Object.keys(days).length}`);
if (errors.length) console.log(`  失败条目  : ${errors.length}`);

/* ---------- 自检：日期键必须是零填充 MM-DD ----------
   之前 merged.json 的键是 '1-1'/'10-8'，而「今天」算出来是 '10-08'，两边对不上就查不到、
   会悄悄回退到别的日期（表现为「日期不跟今天走」）。这里直接断言，防止再犯。 */
const badKeys = Object.keys(days).filter((k) => !/^\d{2}-\d{2}$/.test(k));
const t = new Date();
const tk = String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
const problems = [];
if (badKeys.length) problems.push(`有 ${badKeys.length} 个日期键不是零填充 MM-DD：${badKeys.slice(0, 5).join(', ')}`);
if (!days[tk]) problems.push(`「今天」${tk} 在数据里查不到（键不匹配会让页面默认到别的日期）`);
if (problems.length) {
  console.error('\n❌ 自检失败：');
  for (const p of problems) console.error('   · ' + p);
  process.exit(1);
}
console.log(`  自检      : ✓ ${Object.keys(days).length} 天键均为 MM-DD，今天 ${tk} 命中 ${days[tk].e.length} 条`);

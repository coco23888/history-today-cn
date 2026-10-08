/**
 * SiliconFlow 客户端（OpenAI 兼容）
 * - 从 config/.env 读 key（不打印）
 * - 指数退避重试
 * - 令牌桶限速（L0 档：1000 RPM / 100,000 TPM，TPM 是实际瓶颈）
 * - 记录每次调用的 token 用量
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/* ---------- 读 .env ---------- */
function loadEnv() {
  const out = {};
  const f = path.join(ROOT, 'config', '.env');
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  }
  return out;
}
const ENV = loadEnv();
const API_KEY = process.env.SF_API_KEY || ENV.SF_API_KEY || '';
const BASE_URL = process.env.SF_BASE_URL || ENV.SF_BASE_URL || 'https://api.siliconflow.cn/v1';
const MODEL = process.env.SF_MODEL || ENV.SF_MODEL || 'deepseek-ai/DeepSeek-V3.2';

if (!API_KEY) { console.error('缺少 SF_API_KEY（config/.env 或环境变量）'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 令牌桶：按 TPM 限速 ---------- */
class RateLimiter {
  constructor({ tpm = 100000, rpm = 1000, safety = 0.85 } = {}) {
    this.tpm = Math.floor(tpm * safety);
    this.rpm = Math.floor(rpm * safety);
    this.events = [];          // {t, tokens}
    this.reqEvents = [];       // {t}
  }
  /** 预估一次请求的 token 量，必要时等待 */
  async acquire(estTokens) {
    for (;;) {
      const now = Date.now();
      this.events = this.events.filter((e) => now - e.t < 60000);
      this.reqEvents = this.reqEvents.filter((t) => now - t < 60000);
      const usedTokens = this.events.reduce((a, e) => a + e.tokens, 0);
      if (this.reqEvents.length < this.rpm && usedTokens + estTokens <= this.tpm) {
        this.events.push({ t: now, tokens: estTokens });
        this.reqEvents.push(now);
        return;
      }
      // 等到最早的事件滑出窗口
      const waitToken = usedTokens + estTokens > this.tpm && this.events.length
        ? 60000 - (now - this.events[0].t) + 20 : 0;
      const waitReq = this.reqEvents.length >= this.rpm && this.reqEvents.length
        ? 60000 - (now - this.reqEvents[0]) + 20 : 0;
      await sleep(Math.max(50, Math.min(5000, Math.max(waitToken, waitReq))));
    }
  }
  /** 用真实用量校正 */
  settle(estTokens, realTokens) {
    if (!this.events.length) return;
    const last = this.events[this.events.length - 1];
    if (last.tokens === estTokens) last.tokens = realTokens;
  }
}

/* ---------- 单次对话 ---------- */
async function chat({ system, user, maxTokens = 400, temperature = 0, retries = 7, limiter = null, estTokens = 900 }) {
  const body = {
    model: MODEL,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
    temperature,
  };
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (limiter) await limiter.acquire(estTokens);
    const t0 = Date.now();
    let res, text;
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
      text = await res.text();
    } catch (e) {
      lastErr = { kind: 'network', message: e.message, status: 0 };
      await sleep(1000 * attempt + Math.random() * 800);
      continue;
    }
    const ms = Date.now() - t0;

    if (res.status === 200) {
      let j;
      try { j = JSON.parse(text); } catch (e) {
        lastErr = { kind: 'bad_json', message: text.slice(0, 300), status: 200 };
        continue;
      }
      const usage = j.usage || {};
      if (limiter) limiter.settle(estTokens, (usage.total_tokens || estTokens));
      return {
        ok: true,
        content: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '',
        finish: j.choices && j.choices[0] && j.choices[0].finish_reason,
        usage, ms,
      };
    }

    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) {}
    const code = parsed && parsed.code;
    const busy = res.status === 429 || code === 50609 || /too busy|rate limit/i.test(text);

    lastErr = {
      kind: busy ? 'rate_limit' : (res.status >= 500 ? 'server' : 'client'),
      status: res.status, code,
      message: ((parsed && parsed.message) || text).slice(0, 300),
    };

    if (busy || res.status >= 500) {
      // 服务端过载：指数退避 + 抖动，最长等 60s
      const wait = Math.min(60000, 2000 * Math.pow(1.7, attempt - 1)) + Math.random() * 1500;
      await sleep(wait);
      continue;
    }
    // 4xx（含内容审核拒绝）不重试
    return { ok: false, error: lastErr, ms };
  }
  return { ok: false, error: lastErr, ms: 0 };
}

/* ---------- 从回复里稳健地抽出 JSON ---------- */
function extractJSON(s) {
  if (!s) return null;
  let t = String(s).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try { return JSON.parse(t.slice(i, j + 1)); } catch (e) {}
  }
  return null;
}

module.exports = { chat, extractJSON, loadEnv, RateLimiter, MODEL, BASE_URL, API_KEY };

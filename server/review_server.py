#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
「历史上的今天」人工复核服务

用法:
    python server/review_server.py            # 默认 http://127.0.0.1:8770
    python server/review_server.py --port 9000

功能:
    - 提供复核页面（可筛选、排序、编辑、标记是否展示）
    - 人工标记持久化到 data/review.json（原子写入，带时间戳）
    - 只依赖 Python 标准库

数据来源:
    data/merged.json              条目原文 + 百度节日
    data/ai/results.jsonl          AI 审核结果（逐条追加）
    data/ai/results.json           AI 结果快照（兜底）
    data/review.json               人工复核记录（本服务写入）
"""
import argparse
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
AI = os.path.join(DATA, 'ai')
WEB = os.path.join(ROOT, 'web')
REVIEW_FILE = os.path.join(DATA, 'review.json')

_lock = threading.Lock()
_cache = {'entries': None, 'days': None, 'reviews': None, 'reviews_mtime': 0}


# ---------------- 数据加载 ----------------

def _load_json(path, default):
    try:
        with open(path, 'r', encoding='utf-8-sig') as f:
            return json.load(f)
    except Exception:
        return default


def load_reviews(force=False):
    """读取人工复核记录（带 mtime 缓存）"""
    try:
        mtime = os.path.getmtime(REVIEW_FILE)
    except OSError:
        mtime = 0
    if force or _cache['reviews'] is None or mtime != _cache['reviews_mtime']:
        _cache['reviews'] = _load_json(REVIEW_FILE, {})
        _cache['reviews_mtime'] = mtime
    return _cache['reviews']


def save_reviews(reviews):
    """原子写入，避免中途崩溃损坏文件"""
    tmp = REVIEW_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(reviews, f, ensure_ascii=False, indent=1)
    os.replace(tmp, REVIEW_FILE)
    _cache['reviews'] = reviews
    _cache['reviews_mtime'] = os.path.getmtime(REVIEW_FILE)


def clean_holiday_text(t):
    """清理维基节日文本里的解析残留，如 '、、：儿童节' -> '儿童节'"""
    s = (t or '').strip()
    while s[:1] in ('、', '，', ',', '：', ':', '；', ';', ' '):
        s = s[1:]
    return s.strip()


def norm_key(key):
    """日期键统一成零填充的 MM-DD。

    merged.json 里的键是不补零的（'1-1'、'10-8'），而前端算「今天」得到的是补零的 '10-08'，
    两边对不上就会查不到、悄悄回退到邻近日期。所有进出都过一遍这个函数，杜绝这类错位。
    """
    try:
        m, d = str(key).split('-')
        return '%02d-%02d' % (int(m), int(d))
    except Exception:
        return str(key)


_JUNK_RE = re.compile(r'^(time|date)\s*=|^\d{4}-\d{1,2}-\d{1,2}。?$', re.I)


def is_junk(text):
    """维基节日段落里的解析残留（如 "time=2020-1-3。"），不展示"""
    return bool(_JUNK_RE.match((text or '').strip()))


# ---------------- 自动通过规则 ----------------
# AI 审核完之后，绝大多数条目其实是干净的：AI 只是做了精简（trim）或原样保留（keep），
# 敏感度为 0，没有被标旗。这类条目不需要人再点一遍「通过」——默认就算通过（展示），
# 但页面上仍保留按钮，可以随时手动切回「不展示」。
# 真正需要人看的只有两类：
#   1) AI 标了 flag（拿不准 / 敏感 / 不肯改写）
#   2) AI 判敏感度 >= 2
AUTO_MIN_SENS = 2


def needs_human(e):
    """该条目是否需要人工复核（AI 拿不准或敏感度较高）"""
    return e.get('act') == 'flag' or (e.get('sens') or 0) >= AUTO_MIN_SENS


def is_auto_pass(e):
    """是否属于「AI 直通」（默认通过、可手动改为不展示）"""
    return bool(e.get('act')) and not needs_human(e)


def auto_pass(rec, rev):
    """结合人工标记，判断条目当前是否处于「自动通过」状态。

    人工一旦动过（通过 / 不展示 / 手改），就以人工为准，不再是自动通过。
    """
    return is_auto_pass(rec) and not (rev or {}).get('status')


def load_all():
    """载入全部数据（首次调用后缓存）"""
    if _cache['entries'] is not None:
        return
    merged = _load_json(os.path.join(DATA, 'merged.json'), {})
    festival_info = _load_json(os.path.join(DATA, 'festival_info.json'), {})

    # AI 结果：快照打底，jsonl 覆盖
    ai = {}
    snap = _load_json(os.path.join(AI, 'results.json'), {})
    if isinstance(snap, dict):
        ai.update(snap)
    jsonl = os.path.join(AI, 'results.jsonl')
    if os.path.exists(jsonl):
        with open(jsonl, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                    if o.get('id'):
                        ai[o['id']] = o
                except Exception:
                    pass

    days = {}
    entries = {}
    stripped_holidays = 0
    for key, day in merged.items():
        lst = []
        for e in day.get('entries', []):
            # 【剥离】维基「节日」条目（type=holidays）
            # 这批是循环纪念日（独立日/团结日/司法节…），没有年份、每天 5 条以上、大多与中文读者无关，
            # 混在「事件/出生/逝世」里会污染"历史上的今天"的语义。中文节日由百度源单独提供（带由来）。
            if e['type'] == 'holidays':
                stripped_holidays += 1
                continue
            a = ai.get(e['id'])
            rec = {
                'id': e['id'], 'type': e['type'], 'typeCn': e.get('typeCn', ''),
                'year': e.get('year', ''), 'src': e.get('text', ''),
            }
            if a:
                rec.update({
                    'cat': a.get('cat', ''), 'tags': a.get('tags', []),
                    'sens': a.get('sens', 0), 'act': a.get('act', ''),
                    'score': a.get('score', 0), 'out': a.get('out', ''),
                })
            lst.append(rec)
        # 默认顺序：类型分组 -> 分数降序（无分数排最后）
        order = {'events': 0, 'births': 1, 'deaths': 2}
        lst.sort(key=lambda x: (order.get(x['type'], 9), -(x.get('score') or 0), x['id']))
        # 节日带上「由来」（哪年、因为什么设立）
        fes = []
        for name in day.get('festivals', []):
            info = festival_info.get(name) or {}
            fes.append({
                'name': name,
                'origin': info.get('origin', ''),
                'since': info.get('since', ''),
                'time': info.get('time', ''),
                'area': info.get('area', ''),
                'url': info.get('url', ''),
            })
        days[key] = {'key': norm_key(key), 'm': day.get('month'), 'd': day.get('day'),
                     'f': day.get('festivals', []), 'fes': fes, 'n': len(lst)}
        for r in lst:
            entries[r['id']] = r

    _cache['entries'] = entries
    _cache['days'] = {norm_key(k): v for k, v in days.items()}
    _cache['strippedHolidays'] = stripped_holidays


def day_payload(key):
    load_all()
    key = norm_key(key)
    merged = _cache['days'].get(key)
    if not merged:
        return None
    reviews = load_reviews()
    ent = []
    for e in _cache['entries'].values():
        if not e['id'].startswith(_mmdd(key)):
            continue
        r = reviews.get(e['id'])
        e = dict(e)
        e['auto'] = auto_pass(e, r)          # AI 直通（默认展示，可切）
        e['need'] = needs_human(e) and not (r or {}).get('status')   # 待人工复核
        ent.append(e)
    return {'key': key, 'month': merged['m'], 'day': merged['d'],
            'festivals': merged['f'], 'fes': merged.get('fes', []), 'entries': ent,
            'reviews': {e['id']: reviews[e['id']] for e in ent if e['id'] in reviews}}


def _mmdd(key):
    m, d = key.split('-')
    return '%02d%02d' % (int(m), int(d))


# ---------------- HTTP ----------------

class Handler(BaseHTTPRequestHandler):
    server_version = 'onthisday-review/1.0'

    def log_message(self, fmt, *args):
        if os.environ.get('REVIEW_QUIET') != '1':
            print('  %s - %s' % (self.address_string(), fmt % args), flush=True)

    # ---- 工具 ----
    def _send(self, code, body, ctype='application/json; charset=utf-8'):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        raw = body.encode('utf-8') if isinstance(body, str) else body
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self.wfile.write(raw)
        except BrokenPipeError:
            pass

    def _read_json(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode('utf-8'))
        except Exception:
            return {}

    # ---- GET ----
    def do_GET(self):
        path = urlparse(self.path).path

        if path in ('/', '/review.html', '/index.html'):
            f = os.path.join(WEB, 'review.html')
            if not os.path.exists(f):
                return self._send(404, {'error': 'web/review.html 不存在'})
            with open(f, 'rb') as fh:
                return self._send(200, fh.read(), 'text/html; charset=utf-8')

        # 运行时自检用的探针页（开发用，不是产品的一部分）
        # 同源把 review.html / index.html 写进探针页，再检查真实渲染结果，见 tools/probe/
        if path in ('/__probe.html', '/__probe_site.html'):
            name = 'probe.html' if path == '/__probe.html' else 'probe_site.html'
            f = os.path.join(ROOT, 'tools', 'probe', name)
            if not os.path.exists(f):
                return self._send(404, {'error': 'tools/probe/' + name + ' 不存在'})
            with open(f, 'rb') as fh:
                return self._send(200, fh.read(), 'text/html; charset=utf-8')

        if path == '/api/days':
            load_all()
            return self._send(200, _cache['days'])

        if path.startswith('/api/day/'):
            key = unquote(path[len('/api/day/'):])
            p = day_payload(key)
            if p is None:
                return self._send(404, {'error': 'no such day: ' + key})
            return self._send(200, p)

        if path == '/api/reviews':
            return self._send(200, load_reviews())

        if path == '/api/stats':
            load_all()
            rev = load_reviews()
            entries = _cache['entries']
            total = len(entries)
            done = sum(1 for e in entries.values() if e.get('act'))
            acts = {}
            auto = need = 0
            for e in entries.values():
                if e.get('act'):
                    acts[e['act']] = acts.get(e['act'], 0) + 1
                r = rev.get(e['id'])
                if auto_pass(e, r):
                    auto += 1
                elif needs_human(e) and not (r or {}).get('status'):
                    need += 1
            approved = sum(1 for r in rev.values() if r.get('status') == 'approved')
            rejected = sum(1 for r in rev.values() if r.get('status') == 'rejected')
            edited = sum(1 for r in rev.values() if r.get('text'))
            return self._send(200, {
                'total': total, 'aiDone': done, 'acts': acts,
                'strippedHolidays': _cache.get('strippedHolidays', 0),
                'autoPass': auto, 'needHuman': need,
                'autoMinSens': AUTO_MIN_SENS,
                'reviewed': len(rev), 'approved': approved,
                'rejected': rejected, 'edited': edited,
            })

        # 静态文件兜底
        rel = path.lstrip('/')
        f = os.path.normpath(os.path.join(WEB, rel))
        if f.startswith(WEB) and os.path.isfile(f):
            ctype = 'text/plain; charset=utf-8'
            if f.endswith('.html'):
                ctype = 'text/html; charset=utf-8'
            elif f.endswith('.css'):
                ctype = 'text/css; charset=utf-8'
            elif f.endswith('.js'):
                ctype = 'application/javascript; charset=utf-8'
            elif f.endswith('.json'):
                ctype = 'application/json; charset=utf-8'
            with open(f, 'rb') as fh:
                return self._send(200, fh.read(), ctype)

        self._send(404, {'error': 'not found: ' + path})

    # ---- POST ----
    def do_POST(self):
        path = urlparse(self.path).path
        if path != '/api/review':
            return self._send(404, {'error': 'not found: ' + path})

        body = self._read_json()
        eid = body.get('id')
        if not eid:
            return self._send(400, {'error': 'missing id'})

        status = body.get('status')          # approved / rejected / pending / None
        text = body.get('text')              # 人工编辑后的文本（None = 不改）

        with _lock:
            reviews = dict(load_reviews(force=True))
            rec = dict(reviews.get(eid) or {})
            if status is not None:
                if status == 'pending':
                    rec.pop('status', None)
                else:
                    rec['status'] = status
            if text is not None:
                if text == '':
                    rec.pop('text', None)    # 空字符串视为「恢复为 AI 版本」
                else:
                    rec['text'] = text
            rec['at'] = time.strftime('%Y-%m-%d %H:%M:%S')
            if rec.get('status') or rec.get('text'):
                reviews[eid] = rec
            else:
                reviews.pop(eid, None)       # 全部清空 = 回到未复核
            save_reviews(reviews)

        return self._send(200, {'ok': True, 'id': eid, 'review': reviews.get(eid)})


def main():
    ap = argparse.ArgumentParser(description='历史上的今天 · 人工复核服务')
    ap.add_argument('--port', type=int, default=8770)
    ap.add_argument('--host', default='127.0.0.1')
    args = ap.parse_args()

    port = int(os.environ.get('REVIEW_PORT', args.port))
    host = os.environ.get('REVIEW_HOST', args.host)

    print('正在载入数据…', flush=True)
    t0 = time.time()
    load_all()
    load_reviews(force=True)
    print('  条目 %d 条 / 天数 %d 天 / 已有复核 %d 条  (%.1fs)'
          % (len(_cache['entries']), len(_cache['days']), len(_cache['reviews']), time.time() - t0), flush=True)

    srv = ThreadingHTTPServer((host, port), Handler)
    print('\n  复核页面: http://%s:%d' % (host, port), flush=True)
    print('  复核记录: %s' % REVIEW_FILE, flush=True)
    print('  Ctrl+C 停止\n', flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止', flush=True)
    finally:
        srv.server_close()


if __name__ == '__main__':
    main()

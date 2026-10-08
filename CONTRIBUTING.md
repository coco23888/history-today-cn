# 贡献指南

数据管线的详细说明在 [`README.md`](README.md)。

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20 | 管线脚本 |
| Python | ≥ 3.8 | 只用标准库，复核服务无需 `pip install` |
| PowerShell 7+（pwsh） | — | 仅运行时自检脚本用得到 |
| Chrome | 任意 | 仅自检脚本用得到（无头渲染） |

重跑 AI 需要一个 OpenAI 兼容的 API Key，默认用 SiliconFlow：
<https://cloud.siliconflow.cn/i/KP7FnJG3>（通过该链接注册赠送 16 元额度）

## 改完请跑这几条

```bash
npm install
npm run site                # 构建自带自检：日期键不合规会直接 exit 1
npm run review              # 另一个终端
npm run verify:review       # 复核页：无头 Chrome 真渲染，16 项断言
npm run verify:site         # 展示页：12 项断言
npm run audit               # 8 项数据质量审计
```

## 修改时要注意的地方

1. **日期键必须零填充 `MM-DD`**。`merged.json` 原本是不补零的 `10-8`，而页面里「今天」是 `10-08`，
   对不上会**静默回退到邻近日期**（不报错，只是日期不对）。三处已归一化，并且构建时会断言。
2. **`prep_merge.js` 是从零重建 `merged.json`**。段落修正逻辑在 `src/lib/section_fix.js`，
   新增修正要加进那个共用模块，否则重跑 `prep` 会把它覆盖掉。
3. **AI 并发不要超过 20**。实测 60 并发会触发 `429 / code 50609` 重试风暴，反而更慢。
4. **不要删或重排 `data/ai/results.jsonl`**。它是 AI 结果的唯一来源，重建要 4 小时 / ¥29。
   中断后用 `npm run ai:resume` 续跑。
5. **改提示词会让 prompt 缓存失效**，短期内成本上升，属正常。
6. **Windows 上 Node 的 `fetch` 连不上 `zh.wikipedia.org`**，抓取要走 PowerShell 的
   `Invoke-WebRequest` 或 `curl.exe`。

## 可以继续做的事

- **接自己的产品**：`web/data.json` 是纯数据，可直接喂给任何前端
- **调整筛选口径**：按 `sens` / `tags` 决定展示哪些条目，不用改代码
- **换分类标准**：改 `config/tags.json` 后重跑 AI
- **补节日数据**：百度源只覆盖 55 天，可再找源补齐，结构见 `data/festival_info.json`

## 提交规范

- 提交信息说清改了什么、为什么
- 不要提交 `config/.env`（已在 `.gitignore`）
- 改了大文件（`merged.json`、`results.jsonl`）请说明原因
- 改了提示词或规则，同步更新 `README.md`

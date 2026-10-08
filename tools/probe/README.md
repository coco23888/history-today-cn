# tools/probe

运行时自检用的**探针页**（开发用，产品运行不需要它们）。

## 为什么需要

纯静态检查抓不到两类问题，只能用无头 Chrome 真渲染一遍：

- **日期查表失败会静默回退** —— 页面看起来正常，只是日期不对，不报错
- **拆包后 `data.json` 没加载上** —— 页面只剩空壳

## 怎么工作

`file://` 父页读不到 `http://` 子页的 DOM，所以探针用**同源**的方式：
它从同一个服务上把自己要测的页面抓下来，用 `document.write` 写进本页，
等真实渲染完成后读取 DOM，把结论塞进 `<title>`。
外部的 `verify_*.ps1` 用 `--dump-dom` 抓这个 title 来断言。

| 探针 | 测什么 | 被谁用 |
|---|---|---|
| `probe.html` | 复核页 `/review.html` | `verify_review.ps1`（16 项断言） |
| `probe_site.html` | 展示页 `/index.html` + `data.json` 加载 | `verify_site.ps1`（12 项断言） |

## 注意

- 探针里的 `<script>` **不要用 `const` / `let` 声明复核页已有的名字**（`$`、`esc` 等），
  同页二次声明会抛 `SyntaxError` 把探针整段干掉
- 服务端在 `server/review_server.py` 里把它们挂在 `/__probe.html`、`/__probe_site.html`
  （带 `__` 前缀是为了不跟产品页面撞名）

```bash
npm run review          # 另开一个终端
npm run verify:review
npm run verify:site
```

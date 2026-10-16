# 更新日志 / Changelog

## 0.1.1

- 修复：在高分屏（如 Windows 150% 缩放）上打开很大的日志 / CSV 并滚到靠后位置时，行的背景色在但文字不显示。原因是滚动区域过高，Chromium 的 GPU 渲染在百万级像素坐标下会丢失文字；现在滚动区域最高 30 万像素，更长的文件按比例映射滚动条（滚轮仍逐行滚动）。

---

- Fix: on HiDPI screens, rows near the end of very large logs/CSVs showed their background but no text (Chromium GPU raster loses glyphs at multi-million-pixel layer coordinates). The scroll extent is now capped at 300k px and mapped proportionally.

## 0.1.0

首个版本 / Initial release.

- 表格视图：CSV / TSV / PSV / JSONL / 日志 / Parquet，虚拟滚动、记录详情面板、排序筛选、列统计、编辑与保存、日志跟随、整文件搜索。
- 树视图：JSON / YAML / TOML / INI / .env / XML，美化模式、对象数组表格、保留注释的最小编辑、格式化 / 压缩 / 按键排序。
- Markdown 所见即所得编辑器（勾选框、块编辑、表格单元格编辑），并增强内置预览的排版。
- 界面支持英文与简体中文。

---

- Table view for CSV/TSV/PSV/JSONL/logs/Parquet, tree view for JSON/YAML/TOML/INI/.env/XML, and a WYSIWYG Markdown editor; fast whole-file search everywhere.

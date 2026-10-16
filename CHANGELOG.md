# 更新日志 / Changelog

## 0.1.2

- 修复：打开大日志 / 大 CSV 时偶尔一片空白——行背景色和行号都在，单元格文字却不显示。原因是每一行的文字都在一个单独的 GPU 图层里，VS Code（Chromium）的 GPU 合成有时不会重绘这些图层；现在改为整个表格只用一个图层，并限制了滚动区域高度（超长文件按比例映射滚动条，滚轮仍逐行滚动）。

---

- Fix: large logs/CSVs sometimes showed row backgrounds and line numbers but no cell text. Each row's cells sat in their own GPU layer, which Chromium's compositor did not always re-raster; rows now share one layer, and the scroll extent is capped (longer files map the scrollbar proportionally).

## 0.1.0

首个版本 / Initial release.

- 表格视图：CSV / TSV / PSV / JSONL / 日志 / Parquet，虚拟滚动、记录详情面板、排序筛选、列统计、编辑与保存、日志跟随、整文件搜索。
- 树视图：JSON / YAML / TOML / INI / .env / XML，美化模式、对象数组表格、保留注释的最小编辑、格式化 / 压缩 / 按键排序。
- Markdown 所见即所得编辑器（勾选框、块编辑、表格单元格编辑），并增强内置预览的排版。
- 界面支持英文与简体中文。

---

- Table view for CSV/TSV/PSV/JSONL/logs/Parquet, tree view for JSON/YAML/TOML/INI/.env/XML, and a WYSIWYG Markdown editor; fast whole-file search everywhere.

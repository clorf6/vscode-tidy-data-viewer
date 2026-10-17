# 更新日志 / Changelog

## 0.1.7

- 选中文字时更清楚：选中部分使用编辑器的选区颜色，所在行 / 单元格暂时去掉选中底色（行号、当前单元格边框仍会标出位置），浅色主题下不再被接近白色的行高亮盖住。

---

- Selected text uses the editor's selection colour, and the selected row/cell drops its own highlight while text is selected, so the selected characters are clearly visible.

## 0.1.6

- 树视图、美化文本、INI / .env 和日志中的文字可以直接拖动选择、部分选择并复制，不必先选中行再双击进入编辑；双击选词、三击选整格 / 整行（只在当前单元格或值内，不会连到旁边的格子），右键菜单新增「复制所选文字」。
- 复制的文字干净可用：美化模式保留缩进，多行树节点按 `键: 值` 排列，`↵` / `→` 还原成换行和制表符，行号、折叠按钮、计数等不会被复制；选区拖出窗口边缘自动滚动时起点不会丢。
- 表格单元格内拖动可选择其中文字，拖到其他单元格则改为选择单元格区域；双击编辑时保持双击的那个词选中。
- 状态栏显示选中文字的字符数和行数，选中字符串节点、单元格或日志行时显示其长度；Markdown 编辑器右下角显示选中文字的长度。

---

- Text in the tree, pretty text, INI and log views can be selected and copied directly (drag, double-click a word, triple-click a cell/line); copies keep indentation and real newlines and leave out gutters and chevrons. Inside a table cell a drag selects text, across cells it selects cells. The status bar shows the selection's characters and lines, or the selected value's length; the Markdown editor shows it in a corner chip.

## 0.1.5

- 修复：日志 / 表格有时打开后只有行号和级别颜色、没有文字（诊断信息里 `gridCols: []`）。标签页被隐藏后 webview 会重建，若文件仍在增长，新页面会先收到一条进度更新、再收到初始化消息，于是表格误以为列已经设置过，结果一列都没有。现在初始化之前的更新会被忽略，并且总是对照表格实际拥有的列来同步。

---

- Fix: logs/tables sometimes showed line numbers and level colours but no text (`gridCols: []`). When a re-created webview got a progress/follow update before its init, the grid never received its columns.

## 0.1.4

- 修复：树视图中点击未选中行的折叠按钮需要点两次。原因是按下鼠标时列表获得焦点 / 选中行会重绘所有行，按钮在松开前被替换，Chromium 就不再触发点击；现在选中改在点击时进行，焦点样式只切换一个类名，不再重绘。

---

- Fix: collapsing an unselected tree row took two clicks (rows were re-rendered on mouse-down, so Chromium dropped the click).

## 0.1.3

- 新增命令“复制表格诊断信息”，用于排查表格 / 日志显示空白的问题。
- 日志重新打开时不再恢复横向滚动位置，避免短行被移出视野而看起来一片空白。

---

- New command "Copy Table Diagnostics"; logs no longer restore a horizontal scroll offset on reopen.

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

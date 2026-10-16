# Tidy Data Viewer · 数据文件查看器

**English summary:** readable, editable views for the data files you open every day — CSV/TSV, JSONL, logs and Parquet as a fast virtualized table; JSON, YAML, TOML, INI, `.env` and XML as a structured tree with a pretty-printed mode; Markdown as a WYSIWYG editor rendered by VS Code's own Markdown engine. Large files stay smooth, edits go through VS Code's undo/save, and every view has fast whole-file Ctrl+F search. UI in English and Simplified Chinese.

---

在 VS Code 里打开数据文件时，直接得到**排版清楚、可以编辑**的视图，而不是一大段难读的原始文本。所有格式默认用新视图打开，工具栏上的「以文本打开」随时切回源码。

## 安装

在扩展视图中搜索 **Tidy Data Viewer**，或按 `Ctrl+P` 输入 `ext install clorf6.tidy-data-viewer`。在 Remote-SSH / WSL 窗口中，扩展装在文件所在的那一侧（点“在 SSH: xxx 中安装”）。

## 表格：CSV / TSV / PSV / JSONL / 日志 / Parquet

- **大文件流畅**：按行建立索引、只渲染看得见的行和列，几百 MB、上百列的文件也能顺滑滚动；VS Code 对 50 MB 以上文件的限制不影响表格视图。
- **宽表好读**：表头和行号固定，列宽自动适配可拖动，数字右对齐；右侧**记录详情面板**把选中行竖着展开（键 → 值，嵌套 JSON 美化显示），专门解决“栏太多看不清”。
- 排序、按列筛选（包含 / 等于 / 正则 / 大于小于 / 空值，附常见值一键筛选）、列统计（数量、空值、去重、最小 / 最大 / 平均 / 合计）、隐藏和固定列、自动换行、行高密度。
- **编辑**：双击或 F2 编辑单元格，粘贴整块 TSV，增删行列；`Ctrl+S` 保存、`Ctrl+Z` 撤销，保存时保留原有的分隔符、换行符、引号和 BOM。超过 `dataViewer.table.maxEditableMB` 的文件以只读方式打开。
- **JSONL**：所有记录的键合并成列，嵌套值紧凑显示，解析失败的行会标出来。
- **日志**（`.log`、`nohup.out`、`slurm-*.out`）：按级别着色和筛选，ANSI 颜色，tqdm 进度条只保留最后状态，**跟随新内容**（类似 `tail -f`），一键跳到下一个错误。
- **Parquet**：只读，显示 schema 和行数，按需读取可见区域。
- 复制为 TSV / CSV / Markdown / JSON，导出当前视图（筛选、排序后的结果），`Ctrl+G` 跳转到行。

## 树：JSON / YAML / TOML / INI / .env / XML

- 带缩进参考线的结构树，类型着色，子项数量，折叠时预览内容；链接可点，颜色值显示色块，时间戳悬停显示可读时间，超长字符串点开看全文。
- **对象数组一键切成表格**，可排序、可直接改单元格。
- **美化模式**：整个文件重新缩进排版、带行号、可折叠；YAML / TOML 也可以转成 JSON 查看。
- **编辑**：改值（按类型校验）、重命名、添加、复制、上下移动、删除。每次只替换最小的一段文本，**注释和原有格式都会保留**。工具栏提供格式化、压缩、按键排序；有语法错误时列出错误并可跳到源码。
- 复制路径（JSONPath、JS、jq、JSON Pointer、XPath）、复制值（JSON / YAML）。
- `package.json`、`tsconfig.json`、`.vscode/` 下的配置文件等默认仍以文本打开（见 `dataViewer.openAsTextPatterns`）。

## Markdown：所见即所得

- 用 VS Code 自带的 Markdown 引擎渲染，效果和内置预览一致（数学公式、其他扩展的 Markdown 插件照常生效），并增强排版：GitHub 风格提示块（`> [!NOTE]` 等）、脚注、任务列表、`[[toc]]` 目录、front matter 属性卡片、可横向滚动的宽表格、代码块复制按钮、图片点击放大。
- **点勾选框直接改源文件**；**双击任意段落、标题、列表、代码块、表格**就地编辑它的 Markdown 源码（`Ctrl+Enter` 保存、`Esc` 取消）；**双击表格单元格**直接改，`Tab` 跳格，还能加行加列。
- 目录侧栏、阅读宽度切换、「编辑源码」在旁边打开文本编辑器并双向同步滚动；撤销、保存都走 VS Code 本身。
- 内置的 Markdown 预览也会获得同样的排版增强（`dataViewer.markdown.enhance`）。

## 搜索

所有视图都支持 `Ctrl+F`：在**整个文件**中搜索（不只是屏幕上的部分），找到第一个结果立即跳过去，匹配数边搜边更新；`Enter` / `F3` 下一个，`Shift+Enter` / `Shift+F3` 上一个；支持区分大小写、全词、正则。

## 设置

| 设置 | 默认值 | 说明 |
|---|---|---|
| `dataViewer.openAsTextPatterns` | 配置文件等 | 这些文件始终以文本打开。 |
| `dataViewer.table.maxEditableMB` | `64` | 超过此大小的表格以只读流式打开。 |
| `dataViewer.table.delimiter` | `auto` | 分隔符，`auto` 自动判断。 |
| `dataViewer.table.wrapCells` | `false` | 单元格内容换行显示。 |
| `dataViewer.table.rowHeight` | `normal` | 行高：`compact` / `normal` / `comfortable`。 |
| `dataViewer.log.follow` | `true` | 日志可见时跟随新追加的内容。 |
| `dataViewer.tree.indent` | `2` | 格式化使用的缩进。 |
| `dataViewer.tree.expandDepth` | `2` | 打开文件时默认展开的层数。 |
| `dataViewer.markdown.enhance` | `true` | 增强 Markdown 排版（也作用于内置预览）。 |
| `dataViewer.markdown.frontMatter` | `card` | front matter 显示为属性卡片或隐藏。 |

不想默认使用某个视图时，在任意文件上右键「打开方式…」→「配置默认编辑器」即可改回文本编辑器。

## 限制

- 树视图基于 VS Code 的文本文档，VS Code 不会把 50 MB 以上的文本文件交给扩展，这类超大 JSON / YAML 请用文本方式打开。
- XML 和 TOML 的部分结构（表头、数组表）只能在源码中修改。
- Markdown 中的 Mermaid 图暂不渲染（可用工具栏的「内置预览」）。

## 开发

需要 Node.js 18+：`npm install`，`npm test`，`npm run package` 生成 `.vsix`，`node scripts/check-manifest.mjs` 检查命令、菜单与翻译。

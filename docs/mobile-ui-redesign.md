# Papilot 移动端界面重构说明（Apple 原生体验优化）

本文档详细介绍在独立工作树（`feat/mobile-ui`）中对 Papilot 移动端界面（`<= 680px` 手机视口与触控设备）进行的系统性视觉重构、交互精简与工程验证。本次改造以 **Apple Human Interface Guidelines (iOS)** 为设计标杆，围绕**内容优先、克制取舍、原生层级与单手拇指交互**四大原则，彻底解决原先移动端控件堆叠、边框杂乱与小屏误触问题。

---

## 一、改造前痛点诊断

在改造前，移动端界面主要由桌面端双栏/三栏工作台直接压缩折行而来，存在以下核心体验短板：

1. **多层工具栏严重挤压阅读画布**：
   - 手稿页同时存在顶栏、双行折行的 PDF 工具栏（目录展开文字、区域框选、分组色标、警告计数、批注计数）以及底部横向条形翻页栏，上下形成“三明治夹心”，大幅压缩论文正文可视高度。
   - 审阅页（Review）的变更进度条与模式切换条在 `390px` 常见手机宽度下被迫拆成两行，且底部操作栏呈生硬直角全宽贴边样式。
2. **桌面键鼠专属功能直接暴露在小屏**：
   - 设置页保留了仅供外接物理键盘使用的 `Keyboard shortcuts`（快捷键重映射）；
   - PDF 与审阅工具栏暴露了依赖鼠标精准拖拽框选的 `Mark region`（区域框选），在手指滑动翻页场景极易误触；
   - 顶栏与工具栏重复展示面向桌面多窗口工作流的 `Open review in new tab` 与 `Full PDF` 外跳图标。
3. **缺乏原生移动应用的层级与材质秩序**：
   - 批注列表（`My notes`）、模型选择器（`Agent picker`）与更多操作菜单（`Action menu`）仍沿用桌面悬浮气泡框，在小屏上显得局促突兀；
   - 设置首页与侧边栏缺乏分组卡片对比度，大量 `1px` 实线边框造成强烈的“后台表格感”；
   - 版本管理（Git）在切换至 `Version history`（版本历史）时，左侧未提交变更表单依然占据近半屏高度，导致提交历史与分支图只能在下半屏狭小缝隙中浏览。

---

## 二、核心设计原则（对标 Apple iOS 原生应用）

1. **内容至上与半透明退让（Deference）**
   导航栏与审阅子工具栏统一采用 `48px` / `42px` 半透明毛玻璃材质（`backdrop-filter: saturate(180%) blur(20px)`）与 `0.5px` 视网膜细分割线（Hairline），消除厚重实心色块与多重边框，让论文 PDF 与审阅对比卡片成为绝对视觉中心。
2. **果断的小屏减法（Focus & Progressive Disclosure）**
   将不适合触屏单手操作的桌面控件果断隐藏，将上下文无关按钮按当前子视图动态收敛（例如切到 `New task` 时自动收起仅服务于 PDF 阅读的编译与分享按钮）。
3. **统一的底部抽屉体系（iOS Bottom Sheets）**
   所有二级浮层——包括手稿批注库（`My notes`）、Agent 模型与权限面板（`Agent settings`）、上下文操作菜单（`Action menu`）以及设置中心（`Settings`）——全部统一为带顶部圆角（`20px`）、拖拽指示条（Grabber）与底部安全区留白（`env(safe-area-inset-bottom)`）的原生底部抽屉。
4. **单手拇指热区与防误触（Thumb-Zone Ergonomics）**
   顶栏左侧紧凑聚合侧边栏按钮与无边框 `UISegmentedControl`（`Review | Chat`、`PDF | New task`），右侧按需对齐编译/分享或任务状态操作，切换视图时零位移、不拥挤；审阅页核心决策按钮与 PDF 标注工具悬浮为底部居中毛玻璃胶囊；所有可点击控件满足 `36px–44px` 触控尺寸，输入控件统一 `16px` 字号防止 iOS Safari 聚焦时自动放大页面。

---

## 三、小屏取舍清单（刻意隐藏与按需收敛项）

为了在小屏上获得如 Apple Books / iOS 邮件 / iOS 设置般干净克制的界面，我们在 `<= 680px` 视口下做出如下明确取舍：

| 所属模块 | 隐藏或收敛的控件 | 小屏取舍原因 | 移动端替代方案 / 保留能力 |
| :--- | :--- | :--- | :--- |
| **全局顶栏** | `Open review in new tab` 外跳按钮 | 手机浏览器多标签页来回切换体验割裂，挤占顶栏右侧空间 | 直接在当前内嵌审阅视图沉浸完成全部审阅与批注 |
| **手稿顶栏** | 处于 `New task` 视图时的 `Recompile PDF` 与 `Share` | 撰写新任务指令时无需编译或导出 PDF，保留会造成顶栏拥挤且语义混乱 | 切回 `PDF` 阅读视图时自动显示在顶栏右侧 |
| **审阅子工具栏** | `Full PDF` 新窗口链接、孤立的紧凑工具组 | 外跳 PDF 造成体验割裂；原先窄屏将左侧整套标注栏隐藏 | 保留 `[Changes \| PDF]` 原地全文切换，底部默认悬浮可收起的毛玻璃标注胶囊栏，并与审阅决策胶囊自动分层避让 |
| **手稿 PDF 工具栏** | `Contents` 文字标签、缩放加减按钮、底部独立翻页栏 | 原先导致工具栏断成两行并多占一条底栏 | 合并为单行 `42px` 纯净工具栏：左侧目录图标、居中 `1 / 2` 页码胶囊、右侧查找与 `My notes` 入口（不增加额外开关图标） |
| **PDF 标注工具栏 (`PdfToolRail`)** | 桌面左侧竖向常驻栏、纯键鼠 `Hand`（抓手平移）工具 | 竖向常驻挤占小屏横向阅读宽度；触屏单指天然可滚动页面，`Hand` 抓手在触屏下完全多余 | **默认在页面底部居中悬浮展示毛玻璃胶囊工具栏**（魔法笔、批注配色、框选、便签、删除线、选择、撤销/重做），点击胶囊右侧 `⌄` 或向下轻扫即可**向下缩起为贴底迷你胶囊**，需要时一点即弹回 |
| **审阅变更卡片** | `Copy reference` 复制引用按钮、冗长的行号路径文本 | 桌面编辑器协作辅助项，挤占窄卡片标题栏 | 仅保留清爽的 `Change 1` 计数与源码折叠开关（DOM 仍保留 `dataset.location` 供评论定位，不影响业务逻辑） |
| **侧边栏抽屉** | `Research Tools`（文献核查工具入口） | 面向桌面宽屏多列核对的重度低频工具，增加主导航噪音 | 突出核心双入口：`Manuscript` 与 `Version Management`（iOS 内嵌分组卡片） |
| **设置中心** | `Keyboard shortcuts`（键盘快捷键设置分类） | 触屏手机无常驻物理键盘，展示快捷键重映射毫无意义 | 在 `<= 680px` 自动隐藏该分类行，`> 680px` 平板与桌面完整保留 |
| **Git 源码对比** | `Before \| After` 行号表头、文件路径次级目录前缀、`+n -m` 统计徽章 | 在 `390px` 宽度下挤占代码正文横向空间 | 行号列由 `52px+52px` 压缩至 `32px+32px`，最大化保留 LaTeX 源码可读宽度 |

---

## 四、七大核心界面改造详解

### 1. 全局导航栏与 iOS 分段控制器（Navigation Bar & UISegmentedControl）
- **结构升级**：在 `src/web/main.tsx` 与 `src/web/style.css` 中，将 `.workspace-navigation` 重构为 `48px` 高度的毛玻璃弹性导航栏：左侧依次固定侧边栏按钮（`44×44px`）与无边框分段控制器（左导航、右动作，切换视图时分段控件位置零跳动，中英文下均不与右侧图标拥挤），右侧通过 `margin-left: auto` 按当前上下文放置状态动作或编译/分享按钮。
- **原生分段视觉**：将 `.view-selector` 与 `.pdf-modes` 去边框化，改用浅灰半透明槽底（`color-mix(in srgb, var(--text) 7%, var(--bg-subtle))`）搭配纯白微投影激活滑块（深色模式下为高对比度悬浮滑块），在 `360px–680px` 主流手机宽度完整保留图标与文字标签，不再出现“激活项有字、未激活项只有图标”的不对称跳动。

### 2. 任务审阅页（Task Review）与悬浮毛玻璃决策胶囊
- **单行子工具栏合并**：在 `src/web/review-frame.tsx` 中精简右侧按钮后，将手机端工具栏折行阈值由 `< 220px` 下调至 `< 185px`，使 `390px` 等主流手机将 `[Changes | PDF]` 切换器、`1 / 5 reviewed` 进度与编译重试图标干净利落地收纳在同一行 `42px` 毛玻璃栏内。
- **圆角纸张卡片**：审阅页 `.sheet` 升级为 `14px` 圆角与柔和自然分层阴影，移除桌面端冗余伪元素装饰。
- **悬浮胶囊 Dock**：底部 `.change-head .dock` 重构为居中悬浮毛玻璃胶囊（`width: min(352px, calc(100% - 20px))`，`border-radius: 999px`，`backdrop-filter: saturate(180%) blur(24px)`），为 `Accept`（浅绿）、`Reject`（浅红）、`Comment`（浅蓝）赋予柔和语义底色胶囊，单手大拇指即可在屏幕底部轻松完成逐条审阅。

### 3. 手稿阅读页（Manuscript PDF）、底部可折叠悬浮标注胶囊与批注底部抽屉
- **单行 42px 纯净工具栏**：将桌面面板的 `@container (max-width: 480px)` 折行规则限定在 `@media (min-width: 681px)`，手机端保持单行紧凑布局：左侧图标化目录入口，中部内置 Apple Books 风格 `1 / 2` 页码胶囊（隐藏冗余的 `.pdf-page-bar` 底栏与缩放加减按钮），右侧仅保留查找、编译问题提示与带完整圆角徽章的 `My notes` 入口，不在顶栏堆砌额外开关图标。
- **底部默认展示、可向下缩起的毛玻璃标注胶囊栏**：
  - 原先窄容器（`@container (max-width: 560px)`）直接将整条 `PdfToolRail` 隐藏，导致魔法笔、便签、删除线、框选与撤销/重做在手机端全部不可达；
  - 现将窄容器退化规则限定在桌面分栏（`@media (min-width: 681px)`），手机端**默认在页面底部居中悬浮展示 `46px` 高的圆角毛玻璃胶囊栏**（包含**魔法笔、批注及配色组、区域框选、便签、删除线、文本选择、撤销、重做**及右侧 `⌄` 收起键共 9 枚圆形按钮，并自动过滤掉触屏无意义的鼠标抓手 `Hand` 工具）；
  - 点击胶囊最右侧的 `⌄` 按钮（或在胶囊上向下轻扫），工具栏即可**向下缩起为贴近底边的 `30px` 迷你毛玻璃胶囊（`✏️ ⌃`）**，收起时自动复位回阅读选择态，让出整页正文视野；点击迷你胶囊（或向上轻扫）即可重新弹出完整工具栏；
  - 针对底部水平胶囊姿态，颜色分组面板（`GroupPicker`）与魔法笔快捷指令菜单（`StampMenu`）自动改为**向上方居中弹出**；同时补齐手稿 PDF 触屏轻点呼出魔法笔圆盘（`StampWheel`）的手势支持，并为 `.pdf-scroll-host` 建立独立层叠上下文（`isolation: isolate`），杜绝 PDF 目录超链接层拦截底部悬浮胶囊点击；
  - 在任务审阅页（`ReviewFrame`）中通过 `--papilot-bottom-rail` 实时同步底部标注栏高度，无论标注胶囊处于展开或缩起状态，审阅决策胶囊均平滑悬浮在其上方，零重叠、零遮挡。
- **`My notes` 原生底部抽屉**：打开批注库时，在阅读区上方铺设轻柔背景遮罩（`.pdf-reading-notes-scrim`，不遮挡顶部主导航栏），`.pdf-reading-notes` 以 `20px` 顶部圆角 + 居中拖拽横条从底部滑出，支持点击遮罩或右上角圆形关闭钮收起。

### 4. 新建任务与对话流（New Task & Chat）
- **极简任务发起页**：切换至 `New task` 时，顶栏自动隐藏 PDF 编译与分享按钮，页面聚焦于居中的品牌问候标题、大圆角（`22px`）输入卡片与底部用量摘要。
- **`Agent settings` 底部抽屉**：点击模型胶囊不再弹出狭窄浮层，而是呼出全宽底部面板（`.agent-picker-panel`），内置圆角搜索框、`40px` 行高的模型列表、推理强度滑块与权限分段开关，并针对 `max-height: 620px` 短屏设备做了紧凑高度自适应，确保不遮挡 `Start task` 发送按钮。
- **iMessage 风格对话流**：优化 `.message.user .message-body` 气泡圆角与留白，底部输入框采用贴合拇指安全区的胶囊设计。

### 5. 版本管理（Git Workspace）
- **沿用单行工具栏**：版本管理工作区已去掉独立的 `Version Management` 标题栏，侧边栏按钮、当前分支与远端操作同在 `.git-toolbar` 一行；`[Changes | Version history]` 分段控制器位于右侧视图的工具栏（或打开的 Diff 工具栏）中，并沿用全局 iOS 分段样式。
- **按视图动态释放全屏空间**：在 `<section className="git-workspace">` 注入 `data-git-detail={detail}` 状态属性；当用户切换到 `Version history` 时隐藏提交表单与文件列表（`.git-panel-content`），只保留顶部工具栏与提示信息，将其余视口完整交给版本历史、提交图谱（Commit Graph）与工作树列表（Worktrees）。
- **紧凑源码 Diff**：在 `src/web/git-diff.css` 中隐藏窄屏表头与次要统计项，收窄双列行号宽度至 `32px + 32px`，显著提升手机端阅读 LaTeX 源码变更的有效列宽。

### 6. iOS 原生分组卡片式设置中心（Settings Modal Sheet）
- **全屏卡片抽屉**：在 `src/web/settings.css` 中，手机端设置弹窗采用距顶部 `10px` 的 iOS 大圆角模态卡片（`border-radius: 20px 20px 0 0`），背景使用类 iOS `systemGroupedBackground` 分组灰底（浅色 `#f5f5f5` / 深色 `#202124`）。
- **Inset Grouped 分组列表**：各分类组渲染为纯白（深色 `#26272b`）圆角卡片，配蓝色线性图标、`0.5px` 内部分割线与右侧 `›` 披露箭头；修复分类目录页残留默认高亮底色与触屏悬停粘滞问题；二级设置页顶部提供醒目的蓝色 `< Settings` 返回导航，开关控件升级为 `44×26px` 标准 iOS Switch 比例。

### 7. 侧边栏抽屉（Sidebar Drawer）与操作菜单（Action Menu）
- **分组式侧边抽屉**：侧边栏背景切换为分组浅灰底，顶部论文切换器加粗突出，`Manuscript` 与 `Version Management` 整合为一组圆角白底导航卡片，任务搜索升级为无边框 iOS Spotlight 搜索胶囊，当前选中任务以白底微投影卡片高亮。
- **底部弹出菜单**：所有 `.action-menu` 在手机端自动转为底部圆角抽屉菜单（每行 `46px` 舒适点击高度），彻底告别贴边拥挤的小号下拉框。

---

## 五、极端视口、深色模式与多语言兼容

1. **超窄屏兜底（`<= 359px` / `<= 350px`，如 iPhone SE `320px`）**：
   - 顶栏分段控制器在 `< 360px` 自动平滑退化为纯图标模式，避免长语言（如德语、俄语、法语）撑破顶栏；
   - 审阅页底部悬浮胶囊在 `<= 350px` 自动切换为上排导航定位、下排决策按钮的双排圆角网格，确保按钮文字零截断、零横向溢出。
2. **深色模式（Dark Mode）**：
   - 全部毛玻璃表面、分段滑块、分组设置卡片与语义色胶囊均基于 `theme.css` 语义变量与 `color-mix()` 动态计算，在浅色与深色主题下均具备恰到好处的层次对比度，同时完整保留 PDF 深色智能反色阅读能力。
3. **国际化（i18n）零硬编码**：
   - 本次改造未新增未翻译硬编码文案，全部复用现有多语言词条，通过 `npm run i18n:check-app` 与多语言端到端排版检查。

---

## 六、修改文件清单

### 前端视图与样式源码
- `src/web/main.tsx`：手稿顶栏分段左对齐与上下文工具按需渲染、`My notes` 遮罩层、移动端打开 Git 默认定位 `Changes`、`GitWorkspace` 的 `data-git-detail` 状态标记。
- `src/web/pdf-tool-rail.tsx`、`src/web/pdf-tools.css`：移动端 `PdfToolRail` 默认在底部居中悬浮展示圆角毛玻璃胶囊栏（自动过滤桌面 `Hand` 工具并抑制触屏悬停气泡），支持通过 `⌄` 按钮或下滑手势向下缩起为贴底迷你胶囊。
- `src/web/pdf-view.tsx`、`src/web/stamp-menu.tsx`、`src/web/note-groups.tsx`：手稿 PDF 触屏轻点呼出魔法笔圆盘 `StampWheel`、底部水平工具栏子菜单向上居中定位。
- `src/web/style.css`：移动端全局顶栏、iOS 分段控制器、单行 PDF 工具栏与居中页码、`.pdf-scroll-host` 层叠隔离、批注/模型/菜单底部抽屉、分组侧边栏、对话流与 iOS 开关样式。
- `src/web/review-frame.tsx`、`src/web/review-notes.tsx`：内嵌审阅页移动端毛玻璃子工具栏、圆角纸张卡片、底部居中毛玻璃决策胶囊，以及 `--papilot-bottom-rail` 动态高度联动避让。
- `src/web/git-overview.css`：移动端 `Version history` 全屏释放布局。
- `src/web/git-diff.css`：移动端 Git Diff 紧凑行号列与工具栏精简。
- `src/web/settings.css`：iOS 分组卡片式设置模态抽屉、隐藏桌面快捷键设置页、蓝色返回导航与卡片视觉细化。
- `src/web/pdf-suggestion.css`：移动端 PDF 批注气泡圆角与阴影质感优化。

### 自动化 UI 回归测试同步更新
- `scripts/check-ui.mjs`、`scripts/check-review-flow.mjs`：同步校验手机端隐藏 `Full PDF` / `Open review in new tab` 并保留编译重试按钮。
- `scripts/check-pdf-tools.mjs`、`scripts/review-tools-checks.mjs`、`scripts/check-note-groups.mjs`：覆盖手机端底部默认悬浮胶囊、向下缩起与展开交互、配色面板向上弹出、审阅决策栏动态分层避让及分组批注流程。
- `scripts/check-unified-review.mjs`：补充内嵌审阅视图 `/look` 与 `/predict` 路由桩，确保审阅工具与统一反馈端到端校验稳定通过。
- `scripts/check-settings-layout.mjs`：同步校验 `<= 680px` 手机视口隐藏 `Keyboard shortcuts` 分类，桌面与平板视口正常展示（覆盖 638 组页面/视口/语言组合）。

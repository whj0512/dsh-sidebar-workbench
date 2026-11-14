# 右侧栏工作台插件

接续开发请先阅读 [分阶段实施计划](docs/剩余任务分阶段实施计划.md)，按页面完成真实业务接入；代码线索和历史限制见 [Agent 交接文档](docs/Agent交接文档.md)。

每阶段须同时交付可操作页面、真实执行与可核验产物，并经人工审核通过后才能继续；demo 或测试适配器不能替代真实业务验收。

阶段 1–3 已获人工审核通过。2026-11-14 用户确认阶段 4 主功能「条目化文档」已完成，并授权「测试009」当前 V1 候选用于阶段 5 开发。正式基线由用户在面板采用后建立，V2 比较和采用待验收。 [阶段 4 验收记录](docs/阶段验收/阶段04-P01-P02-P04.md)

独立的 DeepSeek Harness Web 插件。在右侧栏“开始”页提供“我的工作台”，通过原生 React 页面准备项目材料、运行条目化并审核候选版本。

兼容目标：DSH **0.2.1-rc.3**、Node **24.9.0 或更新版本**、pnpm **11.28.5**。当前开发依赖链接同级 `deepseek-harness` checkout；安装预构建 tarball 不需要插件源码、开发依赖或相邻 checkout。

## 安装预构建包

在已构建的 `E:\deepseek-harness` 中运行以下 PowerShell 命令。已安装 npm CLI 的用户可以将 `pnpm dsh` 替换为 `dsh`。

```powershell
Set-Location E:\deepseek-harness
node --version

# 仅在目标 profile 不存在时从 web 模板初始化，避免覆盖已安装插件或用户配置。
$workbenchHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$workbenchProfile = Join-Path $workbenchHome 'profiles\sidebar-workbench-dev'
if (-not (Test-Path -LiteralPath $workbenchProfile)) {
  pnpm dsh --profile sidebar-workbench-dev --from-default-profile web --dump-config
}

pnpm dsh plugin --profile sidebar-workbench-dev add E:/dsh-sidebar-workbench/dsh-plugin-sidebar-workbench-0.1.0.tgz
pnpm dsh --profile sidebar-workbench-dev --dump-config
pnpm dsh --profile sidebar-workbench-dev --port 3081
```

使用启动日志给出的本地链接打开应用。该链接可能包含本机访问令牌，请勿分享令牌。打开一个会话，展开右侧栏，点击“我的工作台”。若侧栏已有内容，先点击 tab 条的“新标签页”回到开始页。

`--from-default-profile` 会重置目标 profile，因此不要在后续启动命令中保留它。页面需要已选中的会话；不提供独立网页 URL。

## 开发与验证

目录布局：

```text
dsh-sidebar-workbench/
  src/index.ts                 Host 发现入口
  src/client/index.ts          注册与清理
  src/client/app/Workbench.tsx     工作台页面协调
  src/client/app/workbench-types.ts Slot 注入类型
  src/client/components/            tab 定义、标题、导航与流程入口
  src/client/features/project/          项目信息与材料初始化表单
  src/client/features/models/           模型选择与预览
  src/client/features/runs/             运行、授权与产物展示
  src/client/state/            数据投影、视图状态与草稿保护
  src/client/i18n/             typed locale 中英文文案
  src/client/styles/           工作台 CSS Modules
  cordis.patch.yml             profile 安装层
  tsdown.config.ts             独立 Host/Client 构建
  tests/                      组件、生命周期和产物测试
  scripts/browser-smoke.mjs    真实 Web 冒烟测试
```

首次准备时，先在相邻的 DSH checkout 按其 README 完成依赖安装与 `pnpm run build:artifacts`、`pnpm run build:check`。插件使用该 checkout 的已生成类型声明和共享 UI 组件。

```powershell
Set-Location E:\dsh-sidebar-workbench
pnpm install --frozen-lockfile
pnpm run build
pnpm run build:check
pnpm test
pnpm run test:artifact
pnpm pack
```

`pnpm pack` 打包 `lib/` 和插件配置。用户在目标 DSH profile 中自行下载并注册条目化技能。源码变更后请按上述顺序重建与检查，再打包新产物。Client 使用宿主的 React、JSX runtime 和 UI primitives。独立构建脚本实现当前 DSH 的模块 factory 协议。升级 DSH 后需要重新验证，`engines.dsh` 默认拒绝其他版本。

需要链接源码目录开发时，在 DSH checkout 运行：

```powershell
pnpm dsh plugin --profile sidebar-workbench-dev add E:/dsh-sidebar-workbench
```

然后在插件目录运行 `pnpm watch`。重建后重启开发 Host 并刷新网页。pnpm 可能提示 linked peer dependency；Cordis 的开发副本来自相邻 checkout，发布代码不携带自己的 Cordis 或 React 实例。

### 浏览器冒烟

自动化只使用独立 home/profile；会创建工作区和 Session、登记夹具材料并改变测试语言。不要指向日常使用的 profile。隔离初始化和本阶段现有环境见 [T01 验收报告](docs/阶段验收/阶段02-T01.md)。启动时使用项目指定的目录选择器 overlay：

```powershell
Set-Location E:\deepseek-harness
$env:DSH_HOME = '<独立测试 home 的绝对路径>'
pnpm dsh --profile sidebar-workbench-acceptance --patch apps/web/tests/pin-browse-picker.overlay.yml --port 3097 --no-open
```

在另一终端运行下列命令。`DSH_TEST_URL` 使用该次启动日志中的完整 URL；测试不调用模型。两个脚本顺序执行，输出分别放在新的独立目录，避免覆盖证据或并行改变语言。

```powershell
Set-Location E:\dsh-sidebar-workbench
$env:DSH_TEST_URL = '<启动日志中的本地 URL>'
$env:DSH_TEST_OUTPUT_DIR = '<本次冒烟证据的独立目录>'
pnpm run test:browser
$env:DSH_TEST_OUTPUT_DIR = '<本次生命周期证据的独立目录>'
pnpm run test:browser:lifecycle
Remove-Item Env:DSH_TEST_URL
Remove-Item Env:DSH_TEST_OUTPUT_DIR
```

脚本优先使用本机已安装的 Edge 或 Chrome。非标准安装位置可通过 `DSH_BROWSER_PATH` 指定可执行文件。脚本自行创建独立夹具工作区并导航空会话，不发送消息。`DSH_TEST_OUTPUT_DIR` 缺省为当前工作目录的 `artifacts/`；审核时使用独立目录保留结果。截图和 JSON 不进入 tarball。

## 页面行为与扩展

- 计数使用组件本地状态。切换 tab、切换会话、收起侧栏等操作若导致正文卸载，计数会归零；刷新与关闭重开也会归零。语言切换不重置已挂载页面的计数。
- 每个 pane 采用宿主默认的单页行为；分栏、浮动和关闭由宿主控制。插件不访问内部 dockkit 布局数据。
- `guide` 是入口数组；tab、正文和标题使用同一实现 id。业务入口通过 `ctx.sidebarRightTabs.register()` 注册，slot 使用 `ctx.slots.inject()` 等待宿主声明。
- 注册、字典和样式都随插件卸载释放。已保存布局中的工作台记录由宿主显示缺失实现提示；重装后可再次呈现。
- 添加业务功能时优先扩展本包组件和局部状态。跨重挂载状态需要 Slot store；涉及 Host 数据时再设计独立服务与 Remote API。

## 更新与卸载

更新前构建并验证新版本，再使用同一 `plugin add` 命令安装新 tarball，重启 Host 并刷新页面。更新前保留工作区 `.workbench/`、`workbench-runs/` 和 Host 存储备份。旧版本不保证识别新的条目化状态，不能把降级后缺少展示当作数据已删除。

```powershell
Set-Location E:\deepseek-harness
pnpm dsh plugin --profile sidebar-workbench-dev remove dsh-plugin-sidebar-workbench
```

停止并重新启动该 profile 后，开始页不再显示工作台。卸载不删除其他插件、会话或工作区。

更新 `DSH_TEST_URL` 为重启后的地址，再运行 `pnpm run test:browser -- --uninstalled`，可检查中英文开始页均没有工作台入口，也没有残留的插件样式。

## 模型体验

面板创建执行会话时使用「操作 · 材料版本 · 工作区」命名，例如「文档条目化 · V1 · 测试009」。调整和新版本分别使用「条目化调整」和「新版本条目化」作为操作名称。

在「运行记录」对已完成、失败或已取消的任务点击「删除记录」，再点击「确认删除」。Host 持久保存移除状态，候选、产物和执行会话继续可用。中断记录需先核对结果。新增的可选 `deletedAt` 字段兼容已有记录，早于此改动的插件版本无法读取已标记删除的记录。

真实条目化创建独立执行 Session，使用用户在 DSH 注册的 `requirement-itemizer`。面板任务正文套用 `docs/使用手册.pdf` 模板，技能正文、资源位置和调整意见写入 Session。Agent 使用 profile 的文件、Shell 和子 Agent 能力。执行 Session、源材料、候选与日志关联，关闭页面后 Host 继续执行作业。

## 工作台控件样式

工作台采用蓝白主色：蓝色主操作与选中导航、浅蓝内容背景、白色项目和流程卡片；暗色模式继续跟随宿主主题。三条流水线以编号步骤和连接线展示。控件复用宿主 Button、Input、Menu 与 SegmentedTabs，视觉覆盖限制在页面 CSS Modules 内，保留禁用行为与键盘操作。源码修改后执行 `pnpm run build` 和 `pnpm run build:check`，重启链接此目录的 Host 并刷新页面。

本次控件样式验证见 [样式验证记录](docs/控件样式验证记录.md)。

初始化表单支持逐字段错误定位；项目和运行状态使用辅助技术播报。非空修订草稿会启用浏览器离开提醒，草稿仍只保存在原有内存视图状态中；强制退出及不支持 beforeunload 的环境不能保证提醒。关闭侧边栏不会自动清空草稿。

## React 组件结构

`Workbench.tsx` 负责 Slot 数据接入、工作区视图选择和命令协调；各功能按 `components` 和 `features` 分组，数据和视图状态集中在 `state`。Slot 注入类型集中在 `app/workbench-types.ts`。逐文件职责、阅读顺序和修改位置见 [Client 代码导航](src/client/README.md)。

展示组件通过 props 接收数据，使用稳定回调与 `memo` 隔离无关草稿输入。产物列表和待授权运行只在对应页面中派生；草稿离开保护仅在草稿是否为空发生变化时更新。状态仍由原有 Slot store 和 WorkbenchData 持有，未改变状态字段、存储方式或执行授权。检查结果与人工核验步骤见 [React 结构优化记录](docs/React结构优化记录.md)。

## 阶段 3 项目准备

P00 支持真实 PDF/DOCX 与 Markdown 的基本结构检查、材料版本登记、SHA-256 资源快照、显式重新关联及部分绑定失败恢复。P01 显示真实项目与资源摘要；文件链接交给宿主预览。P00 不导入既有成果；条目化候选审核见阶段 4。完整范围、兼容说明和人工核验见[阶段 3 报告](docs/阶段验收/阶段03-P00.md)与[能力核验清单](docs/阶段验收/阶段03-能力核验清单.md)。

插件 config 支持正整数 `maxMaterialBytes`（默认 67108864）、`maxDocumentXmlBytes`（默认 16777216）和 `maxProjectScanEntries`（默认 100000）。超过限制会拒绝相关检查或初始化；配置错误在启动时报错。新增生产依赖安装后需重新构建、重启 Host 并刷新 Client。新清单包含可选 resources 字段，新版可读旧清单，旧版降级读取不保证兼容；不得自动改写已有空材料项目。

## 阶段 4 实施状态

阶段 4 已交付 P01 发起真实条目化、P02 查看和审核候选、P04 查看运行及产物。整体审核待补 V2 比较与采用证据。 [DSH 技能配置与验证](docs/阶段04-原始技能接入与验证交接.md)

真实任务使用 DSH 技能注册表。请在执行任务的 preset 中提供允许模型使用的 `requirement-itemizer`，以及原技能委派所需的 `requirement-chunk-segment`、`requirement-chunk-extract`。工作台在执行会话中按项目目录和 preset 读取技能正文及资源位置。

运行需要 profile 提供 Agent、Preset、Default Model、LLM、Tools、Skill、Subagents 和 WorkingDirectory 服务以及有效模型凭据。Windows `standard` preset 使用 `pwsh`，可通过 `shellToolName` 指定。原技能所需的 Python 和文档解析工具由实际执行环境提供。

原技能自行完成分块、拆分、目录组织、关系生成和校验，并可继续调用工具修正。Host 在 Agent 结束后导入实际产物，保留原始 chunks.json、Markdown 和关系文件，只另建面板读取索引与视图；不再重跑旧的严格分块提交校验。运行级 validation.json 仅报告产物导入情况，原技能校验见执行 Session 及原始报告，导入成功不代表业务或原技能校验全部通过。

审核报告保留原始产物中的问题和 `reviewHolds` 里的暂缓决定。经用户明确授权，可在 `candidateApprovals` 中登记项目 ID、候选 ID 和采用原因，允许该候选在产物检查通过后带着已记录的问题采用。比较结果会显示授权原因，采用时仍检查当前修订、影响清单及文件指纹。采用记录会保存授权原因。

材料、候选和采用分别保存；`.workbench/itemization/` 递增代次发布，`workbench-runs/<runId>/` 保留输入、报告和候选。候选不自动成为基线，采用前重新检查材料/产物指纹和当前影响清单。比较支持唯一原文编号、精确名称和显式一对一匹配，报告内容/关系变化及新增删除；拆分合并由人工确认未匹配项。整个候选原子采用，不混用多个候选的功能。最新状态损坏时明确失败，不自动回退旧基线。

插件 config 的 `itemization` 支持 `shellToolName`（默认 bash，Windows profile 配置 pwsh）、`subagentProvider`（spawn）、`maxSubagentDepth`（4）、`agentSkillAliases` 与 `reviewHolds`。`agentSkillAliases` 将原技能委派角色映射到 DSH 注册名。本机目标 profile 总时限为 3600000ms。旧配置中的 `originalSkillsDirectory`、`maxOutputBytes`、`maxCandidateSubmissions` 和 `maxSourceReadChars` 仅为兼容现有 profile 而接受。主技能不可用时任务在调用模型前失败，并提示在 DSH 中注册技能。

新增 run.operation 和候选索引中的可选读取路径，当前代码兼容读取既有记录，不改写历史 Session；旧构建降级读取新记录不作保证。更新后须重新构建插件、重启 Host 并刷新页面，不能只刷新浏览器。

受控模型和历史会话快照的适用范围见 [tests/expected/README.md](tests/expected/README.md)。后续接入和剩余工作见[阶段 4 执行记录](docs/阶段04-执行记录.md)。

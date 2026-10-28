# 右侧栏工作台插件

独立的 DeepSeek Harness Web 插件。在右侧栏“开始”页增加“我的工作台”入口，点击后显示原生 React 页面，提供点击计数和重置按钮。

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
  src/client/Workbench.tsx     工作台页面协调
  src/client/workbench-types.ts Slot 注入类型
  src/client/shell/            tab 定义、标题、导航与流程入口
  src/client/project/          项目信息与材料初始化表单
  src/client/models/           模型选择与预览
  src/client/runs/             运行、授权与产物展示
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

`pnpm pack` 打包已经验证的 `lib/`，不自动重跑验证。源码变更后请按上述顺序重建与检查，避免打包旧产物。Client 约 4 KB，加载时使用宿主的 React、JSX runtime 和 UI primitives。独立构建脚本实现当前 DSH 的模块 factory 协议；升级 DSH 后需要重新验证，`engines.dsh` 默认拒绝其他版本。

需要链接源码目录开发时，在 DSH checkout 运行：

```powershell
pnpm dsh plugin --profile sidebar-workbench-dev add E:/dsh-sidebar-workbench
```

然后在插件目录运行 `pnpm watch`。重建后重启开发 Host 并刷新网页。pnpm 可能提示 linked peer dependency；Cordis 的开发副本来自相邻 checkout，发布代码不携带自己的 Cordis 或 React 实例。

### 浏览器冒烟

自动化启动使用项目指定的目录选择器 overlay：

```powershell
Set-Location E:\deepseek-harness
pnpm dsh --profile sidebar-workbench-dev --patch apps/web/tests/pin-browse-picker.overlay.yml --port 3081 --no-open
```

在另一终端运行下列命令。`DSH_TEST_URL` 使用该次启动日志中的完整 URL；测试不调用模型。首次使用的 profile 需要先在 UI 选择工作区并进入一个空会话。

```powershell
Set-Location E:\dsh-sidebar-workbench
$env:DSH_TEST_URL = '<启动日志中的本地 URL>'
pnpm run test:browser
Remove-Item Env:DSH_TEST_URL
```

脚本优先使用本机已安装的 Edge 或 Chrome。非标准安装位置可通过 `DSH_BROWSER_PATH` 指定可执行文件。测试 profile 需要已有名为 `dsh-sidebar-workbench` 的工作区及默认工作区；脚本会创建空会话并切换它们，不发送消息。截图和结果位于忽略的 `artifacts/`，不进入 tarball。

## 页面行为与扩展

- 计数使用组件本地状态。切换 tab、切换会话、收起侧栏等操作若导致正文卸载，计数会归零；刷新与关闭重开也会归零。语言切换不重置已挂载页面的计数。
- 每个 pane 采用宿主默认的单页行为；分栏、浮动和关闭由宿主控制。插件不访问内部 dockkit 布局数据。
- `guide` 是入口数组；tab、正文和标题使用同一实现 id。业务入口通过 `ctx.sidebarRightTabs.register()` 注册，slot 使用 `ctx.slots.inject()` 等待宿主声明。
- 注册、字典和样式都随插件卸载释放。已保存布局中的工作台记录由宿主显示缺失实现提示；重装后可再次呈现。
- 添加业务功能时优先扩展本包组件和局部状态。跨重挂载状态需要 Slot store；涉及 Host 数据时再设计独立服务与 Remote API。

## 更新与卸载

更新前构建并验证新版本，再使用同一 `plugin add` 命令安装新 tarball，重启 Host 并刷新页面。回退时安装保留的旧 tarball；插件当前没有业务持久化数据迁移。

```powershell
Set-Location E:\deepseek-harness
pnpm dsh plugin --profile sidebar-workbench-dev remove dsh-plugin-sidebar-workbench
```

停止并重新启动该 profile 后，开始页不再显示工作台。卸载不删除其他插件、会话或工作区。

更新 `DSH_TEST_URL` 为重启后的地址，再运行 `pnpm run test:browser -- --uninstalled`，可检查中英文开始页均没有工作台入口，也没有残留的插件样式。

## 模型体验

无模型可见变化：不注册工具、不增加提示词、不追加 Session event，也不发起模型请求。计数仅存在于页面内存中。

## 工作台控件样式

工作台采用蓝白主色：蓝色主操作与选中导航、浅蓝内容背景、白色项目和流程卡片；暗色模式继续跟随宿主主题。三条流水线以编号步骤和连接线展示。控件复用宿主 Button、Input、Menu 与 SegmentedTabs，视觉覆盖限制在页面 CSS Modules 内，保留禁用行为与键盘操作。源码修改后执行 `pnpm run build` 和 `pnpm run build:check`，重启链接此目录的 Host 并刷新页面。

本次控件样式验证见 [样式验证记录](docs/控件样式验证记录.md)。

初始化表单支持逐字段错误定位；项目和运行状态使用辅助技术播报。非空修订草稿会启用浏览器离开提醒，草稿仍只保存在原有内存视图状态中；强制退出及不支持 beforeunload 的环境不能保证提醒。关闭侧边栏不会自动清空草稿。

## React 组件结构

`Workbench.tsx` 负责 Slot 数据接入、工作区视图选择和命令协调；各功能按 `shell`、`project`、`models`、`runs` 分组，数据和视图状态集中在 `state`。Slot 注入类型集中在 `workbench-types.ts`。逐文件职责、阅读顺序和修改位置见 [Client 代码导航](src/client/README.md)。

展示组件通过 props 接收数据，使用稳定回调与 `memo` 隔离无关草稿输入。产物列表和待授权运行只在对应页面中派生；草稿离开保护仅在草稿是否为空发生变化时更新。状态仍由原有 Slot store 和 WorkbenchData 持有，未改变状态字段、存储方式或执行授权。检查结果与人工核验步骤见 [React 结构优化记录](docs/React结构优化记录.md)。

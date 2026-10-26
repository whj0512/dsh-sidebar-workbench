# 验证记录

日期：2026-10-24。目标：DSH `0.2.1-rc.3`，Windows，Node `24.22.1`，pnpm `11.28.5`，Microsoft Edge `156.0.4314.42`，Playwright `1.64.1`。

## 已通过

| 检查 | 结果与证据 |
| --- | --- |
| Host/Client 构建 | `pnpm run build`，输出 ESM Host 与约 4 KB 的 Client factory |
| 类型检查 | 最新构建之后执行 `pnpm run build:check`，源码、构建配置和 TypeScript 测试通过 |
| 组件与生命周期 | 5 项测试通过；中英文 UI 快照 2 份；包含计数、重置、重挂载归零、语言切换、卸载清理及重新注册 |
| 产物协议 | 2 项测试通过；Host 可直接 ESM 导入，Client 仅请求宿主 React、JSX runtime 与 UI primitives，产物无本机绝对路径 |
| 链接安装 | `sidebar-workbench-dev` profile 的配置层能发现插件；真实右侧栏展示入口、正文和计数交互 |
| tarball 安装 | 隔离 DSH home 的全新 Web profile 中安装成功，仅增加 1 个包；安装目录包含发布文件，无插件开发依赖 |
| 浏览器自动化 | `pnpm run test:browser`；中英文、1440×1000 与 390×844、明暗主题、键盘、关闭重开、tab 切换和会话切换通过 |
| 页面健康 | tarball 安装版两个语言环境均无 pageerror 或 console error；无 Vite 错误覆盖层；窄屏无整页横向滚动 |
| 布局交互 | 真实 UI 手动自动化验证分栏和拖动浮出，工作台仍可呈现 |
| 卸载 | `plugin remove` 后配置中无插件层；重启后运行 `pnpm run test:browser -- --uninstalled`，中英文入口与样式均消失 |
| 主仓库 | `git status --short` 为空；未修改 DSH 仓库源文件 |

浏览器完整流程：选择测试工作区 → 展开右侧栏 → 点击工作台入口 → 计数／重置／键盘操作 → 关闭重开 → 切换 tab → 切换工作区会话 → 明暗主题 → 窄屏全屏页面。没有发送模型消息。

## 本地证据

- `artifacts/browser-results.json`：安装版可复跑浏览器结果。
- `artifacts/uninstalled-results.json`：卸载后的可复跑结果。
- `artifacts/zh-CN-light.png`、`artifacts/en-US-dark.png`：桌面页面截图。
- `artifacts/zh-CN-mobile-light.png`、`artifacts/en-US-mobile-dark.png`：窄屏截图。
- `tests/__snapshots__/workbench.spec.tsx.snap`：无需服务或模型密钥的 UI 文案快照。

`artifacts/` 和隔离 `.dsh-test-home/` 均被忽略，不打入安装包。安装包文件清单由 `pnpm pack` 检查；仅包含 Host/Client 构建产物、类型声明、patch、manifest、README 与许可证。

## 验证边界

- 仅验收 Web，未测试 Electron Desktop、Firefox、Safari 或其他 DSH 版本。
- 390px 验证使用宿主的右侧栏全屏模式；窄桌面 pane 另在分栏后检查。
- 生命周期单元测试使用真实 Cordis 与 tab registry，Slot/locale provider 使用记录夹具；真实 Slot 组合由 Web 测试覆盖。
- 首次链接版测试使用普通 DSH home，观察到一次宿主账号资料读取错误；隔离 home 的安装版和卸载版均无浏览器错误。插件没有账号请求。
- 未运行 DSH 全仓测试：主仓库未变更，本次证据覆盖独立插件及其真实 Host 加载路径。未验证模型服务，也未发布到 npm 或 GitHub。

## 本机开发入口

插件通过链接安装保留在普通 DSH home 的 `sidebar-workbench-dev` profile；隔离 `sidebar-workbench-packed` profile 已卸载插件。测试服务停止后可在新的 PowerShell 终端用以下命令启动开发版：

```powershell
# 本机默认 node 是 v22；以下调整只影响当前终端。
$env:PATH = 'C:\Users\whj0512\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
Set-Location E:\deepseek-harness
pnpm dsh --profile sidebar-workbench-dev --port 3081
```

源码和安装步骤见 [README](README.md)。

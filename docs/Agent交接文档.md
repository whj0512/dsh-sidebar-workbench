# dsh-sidebar-workbench Agent 交接文档

接续状态更新于 2026-11-14（Asia/Hong_Kong）。阶段 1–3 已通过人工审核。用户已确认阶段 4 主功能「条目化文档」完成，本轮归档了 V1 运行及产物。阶段 4 整体审核等待候选业务结论和 V2 比较，阶段 5 等待正式基线与用户放行。 [分阶段实施计划](剩余任务分阶段实施计划.md) · [阶段 4 验收记录](阶段验收/阶段04-P01-P02-P04.md)

## 1. 首先遵守的用户约束

- 修改范围限于 `E:/dsh-sidebar-workbench`。`E:/deepseek-harness` 只用于公共 API 核对和运行验证；不要直接修改 agent-loop 或内部 dockkit。发现公共扩展点缺口时，提交源码证据和最小扩展建议。
- 按分阶段计划中的页面顺序推进，每阶段完成页面、真实业务调用及产物核验后交付用户审核。原 T00–T05 保留为历史任务分类。
- 一个 DSH Workspace 对应一个建模项目。通过当前 Session 的工作区成员关系查找 `Workspace.path`；复用宿主工作区管理，不创建项目选择器或任意输出根目录。
- 已启动任务应固定工作区、项目、绑定修订号及目录快照；切换 Session 或 cd 不得改变任务目录。改名、移除、目录丢失、重新关联均须按验收矩阵核验，不能仅凭类型字段认定完成。
- 保留 tab id `dsh-plugin-sidebar-workbench`、kind `sidebar-workbench` 和现有插件安装方式。使用 DSH Slot、typed locale、CSS Modules 及公开 UI primitives。
- 保留现有状态数据。真实文档解析、DSL 生成/修订、测试生成、TTL 转换及 GraphDB 业务接入和必要实现纳入对应页面阶段。缺少真实能力的操作保持禁用；当前阶段必需能力缺失则阻塞，demo 与测试适配器均不能替代验收。
- 不把模拟结果称为真实业务通过，不因整理目录或重构覆盖已有项目、运行、草稿、用户改动或持久化数据。

## 2. 接手前必读

先读[分阶段实施计划](剩余任务分阶段实施计划.md)和[使用手册](使用手册.pdf)，再按下列资料定位实现要求。

1. [三条流水线集成方案](三条流水线集成方案.md)：总体方案和工作区规则。
2. [界面与交互规范](三条流水线-界面与交互规范.md)：页面及状态语义。
3. [Agent 实施任务书](三条流水线-Agent实施任务书.md)：实现约束、原任务分类和 A01–A28 验收矩阵。
4. [宿主接入核验](接入核验.md)：2026-10-26 的 API 核验，使用前复核当前源码。
5. [Client 代码导航](../src/client/README.md)：逐文件职责、数据流和修改入口。
6. [控件样式验证记录](控件样式验证记录.md)、[React 结构优化记录](React结构优化记录.md)：区分历史浏览器验证与后续单元检查。

继续修改前重新查找适用 AGENTS.md。用户提供的宿主规则也需遵守；涉及宿主 API 时读取相应公开契约及 defensive-patterns。React 重构使用此前指定的 `C:/Users/whj0512/.codex/skills/vercel-react-best-practices/SKILL.md`，不要把 Next.js 专用方案套到当前插件构建上。

## 3. 当前工作树与环境

- 插件：`E:/dsh-sidebar-workbench`；宿主：`E:/deepseek-harness`。环境为 Windows / PowerShell。
- package.json 声明插件版本 `0.1.0`，DSH 兼容目标 `0.2.1-rc.3`，Node `>=24.9.0`，packageManager `pnpm@11.28.5`。这些是声明值，不是本次重新核验的实际运行版本。
- 开发依赖通过 `link:../deepseek-harness/...` 使用相邻宿主。React、JSX runtime、store 和 UI primitives 由宿主共享；不要将 React 打包成另一份，也不要改用宿主私有深层路径导入。
- 2026-10-29 核对时插件已是 Git 仓库，HEAD 为 `e280da2 refactor: split sidebar workbench UI`。早期接入核验中“不是 Git checkout”的描述仅代表当时状态。
- 本轮开始时 `git status --short` 已显示 `src/client/Workbench.tsx`、`src/client/index.ts` 有未提交修改；diff 是新增注释。保留这些既有改动，不还原、不顺手提交。本轮新增交接文档及 README 链接也尚未提交。
- 不假定历史 3081/3082/3083 端口或 Host 进程仍有效；不要停止不属于当前任务的服务。启动 URL 可能含访问令牌，不写入交接或提交记录。

## 4. 阶段状态：代码产出不等于人工验收

阶段状态和新旧任务映射由实施计划维护。验收索引记录具体页面、场景和证据。 [实施计划](剩余任务分阶段实施计划.md#7-审核状态) · [验收证据索引](阶段验收/验收证据索引.md)

后续 Agent 应区分源码、模拟测试、真实 Host 和真实业务证据；没有明确人工通过记录时不得补写已验收。既有 UI 审核不代表 S01–S10 或 A01–A28 全部通过。

## 5. 代码地图与运行链路

```text
src/
  index.ts                    Host 入口、storage domain、Remote 注册
  host/project-service.ts     项目文件、材料、路径约束和绑定操作
  host/run-service.ts         持久化运行台账与恢复基础设施
  shared/project.ts           项目请求、结果、绑定和校验 schema
  shared/remote.ts            Remote 描述及 Client contribution
  shared/workflow.ts          demo 状态机、阶段和工作流类型
  client/index.ts             Client 注册、注入与释放
  client/app/Workbench.tsx        工作区视图读取、命令协调、页面组合
  client/app/workbench-types.ts   Slot 派生 props 和注入类型
  client/components/               tab 定义、标题、导航、流程入口
  client/features/project/             项目信息与材料表单
  client/features/models/              模型选择和只读预览
  client/features/runs/                运行卡片、产物、授权和运行查找
  client/state/               数据投影、视图 store、草稿保护
  client/i18n/                typed locale
  client/styles/              CSS Modules
```

打开侧栏的链路：Client `apply` 挂载 Remote contribution → 注入 `remote.workbench` 后执行 `install` → 创建 WorkbenchData、view store 和 DraftGuard → 注册语言、样式、tab、正文及标题 Slot。正文 Slot 按 Session 注入数据 source 和操作回调；source 被订阅时尝试 `inspect` 当前工作区项目。

工作区通过 `workspaces.list` 中 `sessionIds` 的精确成员关系确定。数据层区分 loading、unbound、ready、error、removed；项目响应按发起请求的工作区保存。未初始化时通过 ProjectPanel 进入 MaterialsForm，填写当前工作区内材料相对路径与版本，再发起项目命令。

项目命令链路：`WorkbenchData.project` → `ctx.remote.workbench.command` → Host `WorkbenchProjects.command` → `ProjectService.execute`。Host 对调用者做 owner 检查，非 owner 当前返回 permission；材料/目录操作由项目服务核验。项目清单位于工作区 `.workbench/project.json`，绑定与运行表存于 `sidebar_workbench` storage domain（version 1）。不要手动删除或重置这些数据。

真实条目化由 `ItemizationPanel` 调用 `workbench/itemization`，Host 的 `ItemizationService` 管理运行、候选审核和状态恢复。`DshItemizerRuntime` 从执行 preset 的 DSH 注册表读取用户注册的技能。运行存于 Host 的 `itemizations` 表，候选与正式基线存于工作区的 `.workbench/itemization/`，产物位于 `workbench-runs/<runId>/`。 [运行服务](../src/host/itemization-service.ts) · [部署与验证](阶段04-原始技能接入与验证交接.md)

演示模式的 `WorkbenchData.start/act` 使用内存 `DemoExecutor`。其他流水线的真实接入按各自阶段继续。

视图按 `${tab.id}:${workspaceId ?? 'unbound'}` 分桶，结合 Session scope 的 Slot store 保留页面选择、表单和草稿；无持久化草稿保证。DraftGuard 维护非空草稿的 beforeunload 监听，关闭侧栏不自动清空，浏览器原生提示仍依赖浏览器支持和用户激活。

## 6. 最近两轮已完成的整理

- 将 Workbench 的导航、项目、流程入口、模型和运行展示提取为组件；用 memo、稳定回调及更小的 props 减少无关草稿输入引起的渲染。菜单状态归 WorkbenchChrome；产物和待授权运行只在相应页面派生。
- 草稿保护 effect 依赖空/非空变化；新增测试验证输入不重复执行模型预览翻译、语言切换保留草稿和模型选择。
- 15 个文件归入上述功能目录，更新源码/测试导入、CSS inline 引用和文档链接。根入口和安装方式保留，未更改状态字段或算法。
- 之前的 UI 工作包括蓝白主题、按钮对比度、材料表单逐字段错误与聚焦、live region 和草稿离开保护。并非所有 Vercel 设计指南检查项都已修复，后续应按实际代码重新审查。

## 7. 已执行的验证与局限

最近一次目录整理完成于 2026-10-28，实际命令和结果如下；这些是历史执行证据，2026-10-29 本次交接没有重跑。

| 插件目录内命令 | 结果 |
| --- | --- |
| `pnpm run build` | 通过，Host 与 Client 构建成功 |
| `pnpm run build:check` | 通过 |
| `pnpm test` | 7 个文件、35 项测试通过 |
| `pnpm run test:artifact` | 2 项通过 |

测试覆盖数据、项目、运行台账、demo 编排、React 页面、可访问性及生命周期。artifact 检查覆盖 Client factory 的共享模块请求和 Host ESM 导出；React 替身已改为实际 React，支持模块加载时的 memo。

2026-10-26 UI 重设计记录包含真实 Host 中英/明暗/桌面与 390px 移动宽度的浏览器检查、初始化和 demo 取消流程；截图在 `artifacts/`，文件可能被后续运行覆盖，使用前核对。随后可访问性检查使用过独立 MaterialsForm 页面。2026-10-28 的 React 与目录整理没有重新进行真实 Host 浏览器检查；原生 beforeunload 弹框和真实屏幕阅读器朗读也未确认。

不宣称完整验收矩阵通过、真实业务通过或实测性能提高。最近 Client 产物约 57.44 kB；拆分组件不是包体积优化证明。

## 8. 安全复现与接续步骤

先检查 `git status --short`，阅读本文和必读资料，再对照当前用户请求开展工作。修改源码后通常执行：

```powershell
Set-Location E:\dsh-sidebar-workbench
pnpm run build
pnpm run build:check
pnpm test
pnpm run test:artifact
```

构建使用插件自己的脚本，不必默认运行宿主全量测试。只改交接文字时无需重跑业务测试。`pnpm pack` 不自动验证新源码，发布前先确认产物与源码一致；本次没有打包、安装、提交或推送。

需要真实 Host 验证时，先核对 profile 是否链接源码。已授权的开发安装方式是宿主目录执行 `pnpm dsh plugin --profile sidebar-workbench-dev add E:/dsh-sidebar-workbench`；若已链接则无需重复安装。通过 dsh profile 启动，浏览器自动化按宿主要求附加 `--patch apps/web/tests/pin-browse-picker.overlay.yml`，选择未占用端口并刷新页面。

`pnpm run test:browser` 不是只读脚本：当前源码会调用 workspace/create、创建会话并进行初始化。运行前检查脚本、选择隔离验证目录/profile，避免将其直接指向用户正在使用的真实项目。不要把执行成功等同于真实业务算法通过。

阶段 4 接续时，先补真实 V2 材料和可采用的上一版比较基线，按验收记录核对版本比较、采用与旧版访问。用户放行后从正式基线接入阶段 5 的单功能解析和 DSL 建模。 [接续步骤](阶段验收/阶段04-P01-P02-P04.md#v2-到位后的验收步骤)

阶段 5–10 的真实建模、测试和图谱业务按实施计划接入。远端资源授权随对应业务阶段验证。 [各阶段要求](剩余任务分阶段实施计划.md#4-各阶段实施要求)

维护提醒：根 README 部分段落仍残留旧计数器介绍、小体积和无业务持久化等早期措辞，不能当作当前事实；本交接没有扩大范围重写这些内容。目录迁移后 tsc 可能保留旧路径声明产物，正式打包前检查 lib/types 是否有遗留文件，再作限定范围清理。

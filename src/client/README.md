# Client 代码导航

本目录是插件的浏览器端代码。根目录保留入口、页面协调组件和 Slot 类型；子目录按功能分组。Host 服务在 `../host`，共享请求与工作流类型在 `../shared`，不在展示组件中实现业务算法。

## 先读哪些文件

按 [index.ts](index.ts) → [WorkbenchSeat.tsx](WorkbenchSeat.tsx) → [Workbench.tsx](Workbench.tsx) → 具体功能组件阅读页面流程。要了解项目数据从哪里来，再读 [state/data.ts](state/data.ts)；要了解切换页面、模型选择和草稿如何保留，读 [state/view-store.ts](state/view-store.ts)。

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 插件接入：挂载 Remote、创建数据对象及 store、注册 locale/样式/tab/Slot，并注册释放操作 |
| `WorkbenchSeat.tsx` | Session 侧栏适配：读取数据与 tab hooks，以 owner 值交给 root 子 Slot |
| `Workbench.tsx` | 页面协调：读取视图 store、选择 Session/tab/工作区分键、派发命令、组合功能组件 |
| `workbench-types.ts` | Slot 的运行时、语言、store 和命令注入类型 |
| `shell/definition.ts` | sidebar tab id/kind 和开始页入口定义 |
| `shell/WorkbenchTitle.tsx` | 宿主 tab 标题 Slot 的组件 |
| `shell/WorkbenchChrome.tsx` | 页面标题、工作区路径、demo 切换、更多菜单和主导航 |
| `shell/WorkflowOverview.tsx` | 三条流水线的概览入口 |
| `project/ProjectPanel.tsx` | 当前项目信息以及初始化、识别、刷新和重新关联入口 |
| `project/MaterialsForm.tsx` | 初始化材料字段、校验、错误定位和提交 |
| `project/MaterialPathInput.tsx` | 两个材料路径的 `@` 目录选择，使用宿主 Menu；版本号保留文本输入 |
| `project/file-lookup.ts` | 区分真实空目录、读取失败与宿主未加载文件查询协议；协议不匹配提示重启 DSH 并刷新页面 |
| `models/ModelsPanel.tsx` | 模型类型选择、只读预览、来源和相关命令入口 |
| `runs/RunCard.tsx` | 单个运行的状态、阶段与操作按钮 |
| `runs/RunViews.tsx` | 运行列表、产物列表和远程操作授权确认页面 |
| `runs/run-selection.ts` | 查找满足条件的最新运行，不修改原运行数组 |
| `state/data.ts` | Session 与工作区归属解析、项目请求与结果、demo 执行器和页面数据快照 |
| `state/view-store.ts` | 页面、选中项、草稿、表单字段等内存视图状态 |
| `state/draft-guard.ts` | 按键记录非空草稿并管理 beforeunload 监听 |
| `i18n/locales.ts` | 中英文 typed locale 字典及类型声明 |
| `styles/Workbench.module.css` | 工作台及各功能组件共享的局部样式 |

## 数据如何流动

`index.ts` 将宿主工作区数据和 Remote 命令交给 `WorkbenchData`，通过原生 Session 侧栏 Slot 将 hooks 和操作回调注入 `WorkbenchSeat`。它读取快照及 tab 信息，用 owner 值调用声明的 `sidebar.right.pane.tab.workbench` 子 Slot。该子 Slot 使用 root scope，让同一插件实例的视图 store 不随 Session 上下文释放；`Workbench` 通过框架 `useStore` 读取、通过 `actions` 修改，分键包含 Session、tab 和工作区。展示组件不自行创建宿主连接。

业务事实由 `state/data.ts` 提供，页面选择与草稿由 `state/view-store.ts` 保存，菜单开关由 `WorkbenchChrome` 局部管理。root store 只在当前插件实例内保留，不配置 localStorage 持久化；刷新、插件卸载和强制退出后不保证恢复。

## 修改时从哪里入手

- 改项目初始化界面：`project/`；改请求或工作区归属：`state/data.ts`。
- 改模型界面：`models/`；改运行卡片、授权或产物界面：`runs/`。
- 改导航或 tab：`shell/`；增加页面组合：`Workbench.tsx`。
- 改文案：`i18n/locales.ts`；改外观：`styles/Workbench.module.css`。
- 改注册或卸载行为：`index.ts`；改 Slot 注入字段：`workbench-types.ts` 及其注册方。

使用具体文件路径导入，不添加统一转导出入口。新增功能放进对应目录；跨功能的状态留在 `state`，不要因目录拆分复制数据源。仓库根目录 `tests/` 保留组件、数据、生命周期和构建产物检查。

草稿按 Session、tab 和工作区隔离；侧栏折叠、会话切换及组件重挂载保留内存草稿。`DraftGuard` 接收宿主 `tab.signal`，仅在标签页记录删除或插件卸载时释放对应离开保护；关闭单个标签页后新开的是另一份草稿。刷新及强制退出不提供持久化恢复。

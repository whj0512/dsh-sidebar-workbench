# Client 代码导航

本目录是插件的浏览器端代码。根目录保留插件入口；应用装配、通用界面、业务功能和共享状态分别放在子目录中。Host 服务在 `../host`，共享请求与工作流类型在 `../shared`，不在展示组件中实现业务算法。

## 先读哪些文件

按 [index.ts](index.ts) → [app/WorkbenchSeat.tsx](app/WorkbenchSeat.tsx) → [app/Workbench.tsx](app/Workbench.tsx) → 具体功能组件阅读页面流程。要了解项目数据从哪里来，再读 [state/data.ts](state/data.ts)；要了解切换页面、模型选择和草稿如何保留，读 [state/view-store.ts](state/view-store.ts)。

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 插件接入：挂载 Remote、创建数据对象及 store、注册 locale/样式/tab/Slot，并注册释放操作 |
| `app/WorkbenchSeat.tsx` | Session 侧栏适配：读取数据与 tab hooks，以 owner 值交给 root 子 Slot |
| `app/Workbench.tsx` | 页面协调：读取视图 store、选择 Session/tab/工作区分键、派发命令、组合功能组件 |
| `app/workbench-types.ts` | Slot 的运行时、语言、store 和命令注入类型 |
| `components/definition.ts` | sidebar tab id/kind 和开始页入口定义 |
| `components/WorkbenchTitle.tsx` | 宿主 tab 标题 Slot 的组件 |
| `components/WorkbenchChrome.tsx` | 页面标题、工作区路径、demo 切换、更多菜单和主导航 |
| `components/WorkflowOverview.tsx` | 三条流水线的概览入口 |
| `features/project/ProjectPanel.tsx` | 当前项目信息以及初始化、刷新和重新关联入口 |
| `features/project/ProjectSummary.tsx` | 真实项目版本、正式基线、资源状态与指纹，已登记文件的宿主预览入口 |
| `features/project/MaterialsForm.tsx` | 初始化材料字段、校验、错误定位和提交 |
| `features/project/MaterialPathInput.tsx` | 铺满可用宽度的材料路径输入、宿主 Menu 的 `@` 目录选择，以及使用聊天同款 ReferenceChip 的文件预览入口；版本号保留文本输入 |
| `features/project/file-lookup.ts` | 区分真实空目录、读取失败与宿主未加载文件查询协议；协议不匹配提示重启 DSH 并刷新页面 |
| `features/models/ModelsPanel.tsx` | 模型类型选择、只读预览、来源和相关命令入口 |
| `features/runs/RunCard.tsx` | 单个运行的状态、阶段与操作按钮 |
| `features/runs/RunViews.tsx` | 运行列表、产物列表和远程操作授权确认页面 |
| `features/runs/run-selection.ts` | 查找满足条件的最新运行，不修改原运行数组 |
| `state/data.ts` | Session 与工作区归属解析、项目请求与结果、demo 执行器和页面数据快照 |
| `state/view-store.ts` | 页面、选中项、草稿、表单字段等内存视图状态 |
| `state/draft-guard.ts` | 按键记录非空草稿并管理 beforeunload 监听 |
| `i18n/locales.ts` | 中英文 typed locale 字典及类型声明 |
| `styles/Workbench.module.css` | 工作台及各功能组件共享的局部样式 |

## 数据如何流动

材料文件引用使用 `sessionFileAddress` 和当前 tab 的 `actions.openResource` 打开宿主右侧资源预览，文件读取、格式支持和读取失败由宿主预览器负责。链接仅为有效的相对文件路径显示；点击不会提交初始化，导航失败可再次点击重试。

`index.ts` 将宿主工作区数据和 Remote 命令交给 `WorkbenchData`，通过原生 Session 侧栏 Slot 将 hooks 和操作回调注入 `WorkbenchSeat`。它读取快照及 tab 信息，用 owner 值调用声明的 `sidebar.right.pane.tab.workbench` 子 Slot。该子 Slot 使用 root scope，让同一插件实例的视图 store 不随 Session 上下文释放；`Workbench` 通过框架 `useStore` 读取、通过 `actions` 修改，分键包含 Session、tab 和工作区。展示组件不自行创建宿主连接。

业务事实由 `state/data.ts` 提供，页面选择与草稿由 `state/view-store.ts` 保存，菜单开关由 `WorkbenchChrome` 局部管理。root store 只在当前插件实例内保留，不配置 localStorage 持久化；刷新、插件卸载和强制退出后不保证恢复。

## 修改时从哪里入手

- 改项目初始化界面：`features/project/`；改请求或工作区归属：`state/data.ts`。
- 改模型界面：`features/models/`；改运行卡片、授权或产物界面：`features/runs/`。
- 改导航或 tab：`components/`；增加页面组合：`app/Workbench.tsx`。
- 改文案：`i18n/locales.ts`；改外观：`styles/Workbench.module.css`。
- 改注册或卸载行为：`index.ts`；改 Slot 注入字段：`app/workbench-types.ts` 及其注册方。

使用具体文件路径导入，不添加统一转导出入口。新增功能放进对应目录；跨功能的状态留在 `state`，不要因目录拆分复制数据源。仓库根目录 `tests/` 保留组件、数据、生命周期和构建产物检查。

草稿按 Session、tab 和工作区隔离；侧栏折叠、会话切换及组件重挂载保留内存草稿。`DraftGuard` 接收宿主 `tab.signal`，仅在标签页记录删除或插件卸载时释放对应离开保护；关闭单个标签页后新开的是另一份草稿。刷新及强制退出不提供持久化恢复。

新项目只通过材料表单初始化，不提供已有成果识别或采用命令。材料版本保存在 `materials.version`，顶层 `baseline` 在正式审核采用前保持 `null`。更新后重启 Host 并刷新页面，使前后端同时停用旧命令；已经存在的项目清单不会自动改写。

初始化成功后进入流程准备页；刷新重新检查已登记文件，不修改清单中的初始指纹。重新关联展示新旧目录与修订，勾选后提交预期修订号。工作区目录变化会隐藏旧目录的缓存结果，过期响应不能写入新目录状态。

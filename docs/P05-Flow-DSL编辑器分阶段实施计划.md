# P05 Flow / DSL 编辑器分阶段实施计划

## 目标与范围

将 [ModelPreview](../src/client/features/models/ModelingPanel.tsx) 接入 Flow 图和 DSL 代码双向编辑，覆盖 Environment、ExternalScenario、Statechart 和适用时的 DialogMap。交互参考相邻 BAIC checkout 的 `packages/webview/src/components/DimensionEditor/DimensionEditor.tsx`。保存时经本机 BAIC API 同步图文，将 `.dsl` 写入工作区内的新修订。通过校验的修订可由用户显式采用。需求与模型的关联来自 `requirement_dsl_map.json`。

按阶段执行检查并记录命令、样本、结果及问题。改动限于插件仓库，保留工作区已有改动。测试夹具和真实样本各自保留验证结论，真实样本的业务结论由用户审核。读取项目 [AGENTS.md](../AGENTS.md)、[README.md](../README.md) 和 [P05 现有验收记录](阶段验收/阶段05-P03-P04-P05.md) 后开始。

## 阶段 1　图文转换

1. 扩展 owner-only `workbench/modeling`，由 Host 核对会话、工作区、运行和登记文件。已结束的成功运行及含 DSL 的失败运行可读取、转换。
2. 从插件配置 `modelEditor.converterBaseUrl` 取 BAIC 本机地址，默认 `http://127.0.0.1:8000`。请求 `/dsl-to-rbg` 和 `/rbg-to-dsl`，按 Environment、ExternalScenario、Statechart、DialogMap 使用 `/IBD`、`/ESD`、无后缀、`/UI`。外部场景使用同一修订的 Environment DSL。
3. 使用运行登记的 textX grammar，比较往返后的声明、引用和追溯标记。区分服务不可用、无效响应、方言差异和往返损失。实测 ExternalScenario 的 grammar 差异。

检查四类模型各一次双向转换，并检查一次有语义或追溯损失的转换。核对损失分支中的原 DSL 指纹。

## 阶段 2　侧栏编辑器

1. 保留运行、类型与文件选择，复用蓝白主题和宿主控件。提供「Flow」和「DSL 代码」切换。Flow 使用 X6，支持缩放、定位、拖动布局和编辑常用节点、连线与属性。复杂表达式通过代码修改。
2. 以最后编辑的视图为草稿来源。切换时按需同步，保存时再次校验。转换失败保留发起转换的草稿。布局数据独立于 DSL。
3. 草稿沿用视图存储和离开保护，以会话、侧栏标签、工作区、运行、修订及文件隔离。异步响应只更新其发起的文件。

在常规宽度和窄侧栏各执行一次双向切换。验证失败后草稿可恢复、切换文件可找回草稿、折叠侧栏保留状态。

## 阶段 3　保存修订与显式采用

1. 保存到 `workbench-runs/<runId>/revisions/<revisionId>/model/`。登记来源运行、基线、父修订、文件指纹和布局。写入完成后才开放读取。重新打开时读取实际落盘版本，可切换回原运行产物。
2. 保存及采用时核对基线、绑定、源文件和预期修订。并发、外部文件变更或换版时保留草稿并报告冲突。失败运行的已有文件可保存。
3. 采用前检查整套必需 DSL、跨文件引用、需求映射和当前基线。在现有项目发布锁内提交模型与关系快照。发布失败时已有正式模型仍可查，修订仍可重新打开。

验证重启后重开、并发提交、失败运行修订、采用冲突和采用成功后的当前模型。

## 阶段 4　自动追溯与验收

1. 从 `requirement_dsl_map.json` 定位对应 DSL 文件及元素。按需求显示原文、章节、行号、断言和覆盖缺口，支持定位 Flow 节点、连线或 DSL 代码行。从选中的图形元素反查需求。
2. 保存后重新核对已有证据。改名、删除和确认证据失效后标为待复核。缺少映射时显示「暂无映射」。Host 仅凭已有且通过校验的建模证据生成映射。
3. 用四类 DSL 验证图文编辑、转换、保存、重新打开及追溯。复用「轮端扭矩限制」的现有中间 DSL 检查失败运行保存和暂无映射。
4. 运行 `pnpm run build`、`pnpm run build:check`、`pnpm test`、`pnpm run test:artifact`、`git diff --check`，重启独立 home/profile 的 Host 并做浏览器回归。

## 交付验收

提供用户操作步骤、实际修订路径、四类转换结果和失败分支证据。注明实测环境、夹具证据、真实样本证据及人工待核对事项。自动对齐与测试生成由后续阶段接入。

### 操作步骤

1. 启动本机 BAIC 转换服务。默认地址为 `http://127.0.0.1:8000`。服务使用其他端口时，在当前 DSH profile 的 `cordis.patch.yml` 配置实际地址，然后重启 Host。

   ```yaml
   - id: sidebar-workbench
     config:
       modelEditor:
         converterBaseUrl: http://127.0.0.1:8000
   ```

2. 在需求建模工作台打开「模型」，选择运行、模型类型、文件和模型修订。切换「Flow」或「DSL 代码」。在 Flow 中选择节点或连线后编辑可用的属性，拖动节点可调整布局。需要增删声明或修改复杂表达式时使用 DSL 代码。
3. 点「保存修订」并通过「模型修订」选择已保存的版本。「打开源文件」打开该版本的实际 DSL 文件。点「采用修订」会校验并发布整套模型。若另一处已保存或项目版本变化，重新打开对应修订后核对草稿，再决定是否应用修改。
4. 在「需求 ID」选择需求以查看原文、行号、断言及缺口。点映射定位到可确认的代码声明或 Flow 元素。选图中元素可反查关联需求。修改导致证据失效时，修订显示「映射待复核」。

### 实施验证记录

构建、类型检查、89 项单元测试、构建产物检查及 `git diff --check` 通过。服务测试覆盖并发保存、外部改动、基线切换、采用版本冲突及映射失效。隔离浏览器使用 DSH 0.2.1-rc.3，BAIC 转换服务监听本机 3297 端口。

| 样本 | 验证结果 |
| --- | --- |
| 真实「轮端扭矩限制」的 Environment | 5 个节点、8 条连线。浏览器确认双向编辑、无效 DSL 后可继续编辑、切换文件和折叠恢复草稿。验证了 247 px 的窄画布。 |
| 真实「轮端扭矩限制」的 ExternalScenario | 7 份场景全部往返通过。回转时调整条件括号附近的空白，再使用原 grammar 和解析后的语义核对。 |
| 历史「收音机播放状态机」 | Statechart 往返通过。 |
| 历史「收音机控制界面会话图」 | DialogMap 往返及控件改名通过。保留 DSL 文件头部的需求标记。人为加入内部标记后，BAIC 回转将其丢弃，Host 返回 `converter-loss`。 |
| 四类受控 DSL | 各类均通过真实 BAIC 编辑、保存和重新读取。浏览器验证需求定位到 DSL 声明及 Flow 连线反查。修改后映射进入待复核，整套模型通过采用校验。 |

「轮端扭矩限制」失败运行 `8e1f8a92-0c60-4152-87e7-5bc4b5450fef` 在隔离浏览器 Session `session-36f58570-a220-4f33-b693-3536281d4d3f` 保存了修订 `619d3ac3-7f3f-47f3-87b4-a7a813b9db0b`，重启 Host 后打开的内容与落盘一致。缺少 Statechart 的修订显示「暂无映射」，尝试采用时返回必需文件缺失。原 Environment 的 SHA-256 为 `185aee6e1b3c8e1044f977ef7a1a8eb5537cfd0ce13f7678afe0d12e201a0601`，与隔离副本保存后的原件相同。 [落盘的 Environment.dsl](../artifacts/p05-editor-be62d65d/wheel-workspace/workbench-runs/8e1f8a92-0c60-4152-87e7-5bc4b5450fef/revisions/619d3ac3-7f3f-47f3-87b4-a7a813b9db0b/model/Environment.dsl) · [浏览器记录](../artifacts/p05-editor-be62d65d/wheel-results.json)

受控运行 `6e3f81f5-da1c-462a-ae1d-0d0a644c29c1` 已采用修订 `8ff2b929-b0ff-452c-bb03-a5d1f1e8c0b9`。四类保存路径、待复核记录和转换时的源文件指纹可在本地证据中查看。 [受控修订记录](../artifacts/p05-editor-be62d65d/controlled-results.json) · [四类转换记录](../artifacts/p05-editor-be62d65d/converter-results.json)

真实业务验收待人工核对「轮端扭矩限制」的编辑后语义，以及「收音机」页面、控件、跳转和原文追溯。隔离 profile 中的采用结果属于受控夹具。

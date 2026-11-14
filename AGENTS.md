# 项目协作约定

本文件适用于整个 `dsh-sidebar-workbench` 项目。修改前先查看当前 Git diff，保留已有的未提交改动；只修改本次任务需要的文件，不顺带重构、升级依赖或整理全仓库格式。

## 项目定位与阅读入口

本项目是独立的 DeepSeek Harness Web 右侧栏插件，包名为 `dsh-plugin-sidebar-workbench`，通过宿主原生 tab、Slot、Remote 和 UI primitives 提供项目准备、条目化运行及候选审核界面。

- 先读根目录 `README.md`，客户端开发再读 `src/client/README.md`。
- 按阶段实施业务功能时，阅读 `docs/剩余任务分阶段实施计划.md`、对应阶段执行记录及验收文档。每阶段须经用户人工审核通过后才能继续，自动测试通过不等于业务验收通过。
- 开发环境以 `package.json` 为准：Node.js >= 24.9.0、pnpm 11.28.5，当前兼容 DSH 0.2.1-rc.3。
- 开发依赖通过 `link:../deepseek-harness/...` 链接相邻宿主 checkout。插件改动限制在本项目内；宿主目录用于公共 API 查阅和运行验证，不修改宿主内部实现来绕过插件边界。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | Host 入口、服务生命周期与 owner-only Remote 注册 |
| `src/host/` | 项目身份、材料检查、持久化运行、条目化执行与审核 |
| `src/shared/` | Host/Client 共用的 Zod schema、协议、类型与工作流规则 |
| `src/client/index.ts` | Client 注册、Slot 注入、locale、样式与卸载清理 |
| `src/client/app/` | 页面装配、Session 适配和注入类型 |
| `src/client/components/` | 工作台标题、导航、tab 定义与流程概览 |
| `src/client/features/` | `project`、`models`、`runs` 等业务组件 |
| `src/client/state/` | Host 数据投影、内存视图状态与草稿离开保护 |
| `src/client/i18n/` | 中英文 typed locale 字典 |
| `src/client/styles/`、`*.module.css` | 工作台共享样式及功能局部样式 |
| `tests/` | Vitest 组件与服务测试、构建产物检查 |
| `scripts/` | 浏览器冒烟、生命周期及条目化验证脚本 |
| `docs/` | 设计、实施计划、执行记录与验收证据索引 |

## 代码编写规范

- 使用 TypeScript、ES modules、单引号和两空格缩进，遵循周边代码的无分号风格。类型导入使用 `import type`，内部导入使用具体文件路径和现有 `.ts`/`.tsx` 后缀，不增加 barrel 入口。
- 展示组件通过 props 接收数据和操作；业务执行、文件读写、身份校验与持久化留在 Host，公共协议放在 `src/shared/`。
- 文案通过 `src/client/i18n/locales.ts` 的中英文键提供，控件优先复用宿主 UI primitives；样式使用 CSS Modules 与宿主语义变量。
- 保留必要的 `forwardRef`、稳定回调及已有 `memo` 边界，不为排版调整改变 hooks、事件、状态、React key 或 ref 传递。

### JSX 多行缩进

**返回 JSX 必须遵循传统的多行缩进嵌套格式。** 本规则适用于新增或修改的组件、渲染辅助函数、条件分支、列表回调，以及测试中的 JSX。

- 直接返回 JSX 时使用 `return (...)`；箭头函数隐式返回 JSX 时使用 `=> (...)`。禁止 `return <...>` 或 `=> <...>` 的压缩写法。
- 非自闭合元素和 Fragment 的开始标签、子节点、结束标签分别占行，子节点相对父节点缩进两空格；文本和表达式子节点也单独占行。
- 兄弟元素分别占行，不把多个标签、嵌套层级或整块组件压在一行。
- `&&` 条件渲染写为 `{condition && (...)}`，JSX 分支另起一行；三元表达式中的 JSX 分支同样用括号和多行嵌套表示。
- `.map()` 返回 JSX 时使用多行回调结构，并保留稳定的 `key`。
- 多属性标签逐行排列属性，`>` 或 `/>` 独占一行并与开始标签对齐；复杂属性表达式和事件处理器按其嵌套层级展开。
- 调整换行时保留可见文本与空格语义；相邻行内文本、表达式或元素需要空格时使用 `{' '}` 等显式写法，避免无意粘连。

示例：

```tsx
function RunList({ runs, visible }: RunListProps) {
  return (
    <section className={css.runs}>
      {visible && (
        <>
          <h2>
            {t('run')}
          </h2>
          {runs.map(run => (
            <RunCard
              key={run.id}
              run={run}
            />
          ))}
        </>
      )}
    </section>
  )
}
```

## 状态与执行边界

- 工作区归属依据宿主 Workspace/Session 数据，项目根目录继承绑定的工作区路径，不另建独立根目录选择逻辑。
- 页面选择、表单和草稿沿用 `state/view-store.ts`，以 Session、tab、workspace 分键；不擅自增加 localStorage 持久化或复制数据源。
- 项目清单为工作区 `.workbench/project.json`；条目化候选及采用状态由 `.workbench/itemization/` 管理，运行产物位于 `workbench-runs/`，Host 记录使用 `sidebar_workbench` 存储域。保留身份、修订与路径边界校验。
- 真实条目化运行由 Host 持有，关闭视图不自动取消任务。保留候选比较、影响确认、修订校验和原文冲突阻止采用的约束。
- 注册、监听、轮询、样式和其他资源必须沿现有生命周期清理。明确区分 demo、测试适配器与真实模型执行，不将模拟结果写成真实业务验收结论。

## 构建与验证

在项目根目录运行；已有依赖可直接执行检查，首次准备使用 `pnpm install --frozen-lockfile`。

```powershell
pnpm run build
pnpm run build:check
pnpm test
pnpm run test:artifact
git diff --check
```

- `build` 执行 `tsc -b && tsdown`，生成 `lib/`；`build:check` 检查源码、测试和构建配置。
- `test:artifact` 依赖最新的构建结果，必须在成功构建后运行；聚焦检查可使用 `pnpm exec vitest run tests/itemization-ui.spec.tsx` 等具体文件。
- 浏览器验证使用独立的 `DSH_HOME`/profile，并按 `README.md` 设置 `DSH_TEST_URL` 和独立的 `DSH_TEST_OUTPUT_DIR`。冒烟与生命周期脚本会创建夹具并修改测试语言，按顺序运行，不指向日常 profile。
- 源码链接开发时，重建后重启对应 Host 并刷新页面；刷新本身不能替代 Host 模块重载。真实模型任务另需 profile 服务及模型凭据，未经验证不能宣称已接通。
- 汇报实际执行的检查和结果，区分类型/单元/产物检查、浏览器验证及人工验收；未执行的检查如实说明。

## 变更交付

- 格式调整保持原有运行逻辑、UI 结构、文案、授权及状态行为，仅处理当前任务范围内的代码；不要为了符合新规范批量改写未涉及的历史文件。
- 提交前查看 diff，保留其他未提交工作；只暂存本次确认的路径。没有明确要求时不提交、不推送。
- 不提交 `.history/`、`node_modules/`、`lib/`、`*.tsbuildinfo`、`*.tgz`、`.dsh-test-home/`、`artifacts/`、模型凭据或本地访问令牌。

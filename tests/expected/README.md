# 条目化会话证据

`itemization-session.json` 来自 2026-11-01 的适配技能与专用提交工具流程，仅保留为历史证据。2026-11-02 切换到完整原技能后，该文件不再用于当前浏览器验收。

当前 `browser-itemization.mjs` 将原技能上下文、手册提示词和工具交互原样保存到本次输出目录的 `itemization-session-original-skills.json`，保留动态路径，便于审计。只有显式指定 `DSH_EXPECTED_ITEMIZATION_SESSION` 才执行与该文件的精确比较；重新记录需同时指定 `DSH_UPDATE_EXPECTED=1`，并使用尚不存在的新文件路径。原始捕获不等于跨工作区稳定重放证据。

本次实现按用户要求未运行验证，也未生成或宣称通过新的预期快照。受控模型仅写入固定格式产物，覆盖 Agent、原生文件工具别名和审核通道；原技能脚本、语义判断、子 Agent 与真实文档需另行验证。

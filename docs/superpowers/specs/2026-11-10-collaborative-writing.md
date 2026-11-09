# 流畅协作写作

目标：修复行内提及，删除抢占输入空间的格式工具栏，自动识别 Markdown 和数学公式，在连续文档左侧显示作者身份；使 Agent 回复由工作区持久化规则控制，而不是由某个浏览器自行判断。

## 已批准的关系

草稿仅留在本机 → 明确提交 → 共享正文 → 内核按权限与工作区模式决定是否调用 Agent。Enter 换行，Cmd/Ctrl+Enter 提交。多人默认仅 @agent；可手动设为自动。多人后不因离线切回单人模式。保持连续文档，不做聊天气泡，不改 vision.md，不重启用户当前 Host。

## 原生契约

- Snapshot 增加带兼容默认值的 collaboration：reply_mode（auto / mentions_only）、mode_explicit、participants（唯一成员 ID）。加入工作区是明确的 JoinWorkspace 命令，重复加入不产生事件；Viewer 也能加入。第二个不同用户加入且模式未手动指定时，追加持久化的 mentions_only 模式事件；离线无对应删除事件。
- SetReplyMode 仅 Owner/Executor 可用，避免 Editor 替其他执行者打开自动执行。显式选择跨重启保留。
- SubmitMessage 是新增的明确提交命令；携带 id、text、after、quotes、backend。它发表文字，再按模式和有效提及启动 Agent。已有 PublishText 保持文档发布/修改语义，不因升级隐式增加模型费用；旧 SDK 无须迁移。修改旧文档、重播、加入和草稿都不触发 Agent。
- 自动或显式提及仍须提交者有执行权限。Editor 可以发表并提及，但不能借 @agent 绕过执行授权。
- 提及以公开 Markdown 链接 `[@name](delta-user:id)` / `[@agent](delta-agent:backend)` 保存，Entry 返回解析后的 Mention 数据。正文普通文本 @agent 也可唤起；代码、引用、公式、转义和普通 URL 内的相同字样不可唤起。人名不是身份键。
- 自动回复的 Agent content 带 source_entry，关联已发表的人类内容，浏览器不重复画一份问题。Agent ID 由提交 ID 派生，重试不能重复执行。
- 模型/启动失败不得让已发表文字变成看似未发表的私有草稿；失败在共享执行记录中可见。

## 编辑与外观

@users 只替换光标位置的提及触发词，继续在同一段输入；不调用插入独立条目命令，不发布草稿。@agent 使用同一行内入口。@terminal 保持执行型块行为。

移除全部格式按钮；Markdown 输入规则和快捷键继续可用，源模式仅通过 Cmd/Ctrl+Shift+M 进入。Markdown 粘贴也须得到真正富文本，而不是原始字符串。

数学支持 $...$、$$...$$ 及模型常用的反斜杠括号形式；源码仍以 Markdown 存储，草稿/共享正文/Agent 输出都渲染，代码块不渲染公式。公式可点击修改源码。错误公式显示可修复状态；KaTeX 不允许 HTML、外链或危险宏。

Delta 后台截图确认的外观参考：左侧小头像与正文首行对齐、正文连续、无格式工具栏、次要执行控件收于底部。先沿用现有色彩变量；不借机重排全站。无照片成员使用本地姓名头像，不请求第三方头像服务；Agent 用独立 AI 身份。

## 验证边界

所有常规测试使用临时数据和确定性后端，不触发真实模型。回归用 Host 可配置的新工作区默认 mentions_only 来隔离无关自动回复，专门测试另行验证 auto 默认和多人切换。真实 Pi 测试只在显式 live 入口运行，不能把 fixture 响应称为真实推理。后台截图不激活前台。最终需独立只读审查。

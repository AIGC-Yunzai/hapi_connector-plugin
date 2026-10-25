![](https://socialify.git.ci/AIGC-Yunzai/hapi_connector-plugin/image?font=KoHo&forks=1&issues=1&language=1&name=1&owner=1&pattern=Circuit+Board&pulls=1&stargazers=1&theme=Auto)

<div align="center">

# HAPI Connector for TRSS-Yunzai

_把 Claude Code / Codex / Cursor / Grok / Kimi / OpenCode / Pi 会话搬进聊天窗口。_

<img decoding="async" align=right src="resources/readme/girl.webp" width="35%">

</div>

## 这是什么

`hapi_connector-plugin` 是云崽 / TRSS-Yunzai 版的 HAPI 遥控器：连接 [HAPI](https://github.com/tiann/hapi) 后端，在聊天窗口里查看、切换、创建、管理 AI 编码会话，并接收 SSE 实时通知。

离开电脑后继续推进任务、在手机上审批工具权限、按聊天窗口隔离多个项目的通知——都在聊天里完成。

### 预览

<img decoding="async" width="150" align=right src="https://github.com/user-attachments/assets/130bf2fd-e116-4b89-aaa4-884dad5bf21c">

<img width="230" alt="image" src="https://github.com/user-attachments/assets/f01e4ca9-176d-4812-8177-3d63623d13d7" />

<img width="230" alt="image" src="https://github.com/user-attachments/assets/8dfaf13d-d1a4-40c9-9d2b-91abaa071f1c" />

## QQ 官方机器人

插件内置 QQ 开放平台官方机器人适配器。官方 bot 是云崽里与 OneBot 账号并列的一等账号，所有插件都能直接用它收发消息。

```text
#hapi qqbot login                       扫码添加机器人
#hapi qqbot login <AppID> <AppSecret>   手动填写凭证
#hapi qqbot list                        列出全部机器人及状态
#hapi qqbot status <AppID>              查看连接状态
#hapi qqbot logout <AppID>              退出登录（保留凭证）
#hapi qqbot remove <AppID>              删除机器人（抹掉凭证）
#hapi qqbot markdown <AppID> on|off     切换文本发送格式
```

> [!IMPORTANT]
> `#hapi qqbot` 全部子命令仅云崽主人可用。

账号与通道设置在锅巴的「官方机器人」标签页里也能改：

| 区块 | 内容 |
| --- | --- |
| 账号 | 备注、AppID（只读）、在线状态（只读）、启用开关 |
| 通道设置 | 推送级别、输出方式、摘要固定走 Markdown |

AppSecret 不展示也不提交；新增机器人只能靠 `#hapi qqbot login`。能力边界与限制见 [docs/qqbot-adapter.md](docs/qqbot-adapter.md)。

## 安装插件

第一次使用请先看详细教程：[HAPI 安装与锅巴配置教程](docs/hapi-install-guoba.md)。

#### 1. 克隆仓库

请在 TRSS-Yunzai 根目录执行：

```bash
git clone https://github.com/AIGC-Yunzai/hapi_connector-plugin.git ./plugins/hapi_connector-plugin
```

> [!NOTE]
> 如果你的网络环境较差，无法连接到 Github，可以使用 [GitHub Proxy](https://ghproxy.link/) 提供的文件代理加速下载服务：
>
> ```bash
> git clone https://ghfast.top/https://github.com/AIGC-Yunzai/hapi_connector-plugin.git ./plugins/hapi_connector-plugin
> ```
>
> 如果已经下载过本插件，需要修改代理加速下载服务地址，在插件根目录使用：
>
> ```bash
> git remote set-url origin https://ghfast.top/https://github.com/AIGC-Yunzai/hapi_connector-plugin.git
> ```

#### 2. 安装依赖

请在 TRSS-Yunzai 根目录执行：

```bash
pnpm install --filter=hapi_connector-plugin
```

## 插件配置

> [!WARNING]
> 非常不建议手动修改配置文件。本插件已兼容 [Guoba-plugin](https://github.com/guoba-yunzai/guoba-plugin)，请优先使用锅巴插件对配置项进行修改。

锅巴里至少填写：

```yaml
hapi_endpoint: "http://127.0.0.1:3006"
access_token: "your-token"
```

## 指令

> [!IMPORTANT]
> 所有 `#hapi` 指令仅对云崽主人权限生效；`/hapi` 与 `#hapi` 等价。

### 必备

```text
#hapi help                  查看帮助
#hapi帮助                   同上
#hapi更新                   更新插件
```

### 会话查看

```text
#hapi list                 查看当前窗口可见 session
#hapi list all             查看全部 session
#hapi sw <序号|ID前缀>      切换当前 session
#hapi s                    查看当前 session 状态
#hapi msg [条数]           查看最近消息
#hapi diff                 以 Markdown 图片查看当前工作区未暂存变更
```

### 消息发送

```text
#hapi to <序号> <内容>      发送到指定 session
> 内容                      快捷发送到当前 session
>{N} 内容                   快捷发送到第 N 个 session
> 上传附件3张 [内容]         等待 3 个附件后发送到当前 session
> {3} 上传附件5份 [内容]     等待 5 个附件后发送到第 3 个 session
```

### Session 管理

```text
#hapi machines                                  查看在线机器
#hapi create <machineId> <目录> <agent> [...]    创建 session
#hapi abort [序号|ID前缀]                        中断 session
#hapi 取消重试 [序号|ID前缀|all]                 取消自动 continue 重试（别名 cancelretry）
#hapi 重试等待时间 [分钟]                        查看/修改自动 continue 重试等待时间（别名 retrydelay）
#hapi archive                                   归档当前 session
#hapi resume [序号|ID前缀]                       恢复 inactive session
#hapi rename <新标题>                            重命名当前 session
#hapi delete [序号|ID前缀]                       删除 session
#hapi trim <数量>                               删除倒数 N 个已关闭会话
#hapi clean [路径前缀]                          删除已关闭会话（交互选择）
```

`#hapi create` 不带完整参数时进入分步向导 _（新手推荐）_。完整格式：

```text
#hapi create <machineId> <目录> <claude|codex|cursor|grok|kimi|opencode|pi> [simple|worktree] [模型] [推理强度] [权限模式] [yolo]

#hapi create my-pc E:/myrepo/project codex simple yolo high
#hapi create my-pc E:/myrepo/project claude simple opus high bypassPermissions
```

### 权限审批

```text
#hapi pending             查看待审批
#hapi a                   批准全部普通请求
#hapi approve             批准全部普通请求
#hapi allow <序号>        批准单个普通请求
#hapi as <序号>           本会话允许单个普通请求
#hapi answer <序号> <答案> 回答 question 请求
#hapi deny [序号]         拒绝全部或单个请求
戳一戳机器人              批准全部普通请求
```

`#hapi answer` 只回答 agent 发起的 question 请求；普通对话用 `#hapi to` 或快捷发送。

### 文件操作

```text
#hapi files [路径]        浏览远端目录
#hapi files -l [路径]     浏览目录并显示大小
#hapi find <关键词>       搜索远端文件
#hapi read <路径>         读取远端小文本文件
#hapi download <路径>     下载远端文件到聊天
#hapi upload [附件]       上传聊天附件到当前 session
#hapi upload cancel       删除当前 session 已上传 blob
```

### 模式与通知

```text
#hapi perm [模式]         查看/切换权限模式
#hapi model [模式]        查看/切换模型
#hapi effort [值]         查看/切换推理强度
#hapi plan                切换 Plan 模式
#hapi output [级别]       查看/切换 SSE 推送级别
#hapi bind                设置当前聊天为默认通知窗口
#hapi bind status         查看 session 推送路由
#hapi bind reset          清除当前窗口绑定
#hapi bind clean          清除默认通知窗口
```

## 致谢

- [astrbot_plugin_hapi_connector](https://github.com/LiJinHao999/astrbot_plugin_hapi_connector)：参考了该插件的命令设计和 Hapi 配置帮助说明
- [siliconflow-plugin](https://github.com/AIGC-Yunzai/siliconflow-plugin)：借鉴了该插件的 Markdown 渲染实现

---

<div align="center">

### 🎨 让AI自己打工！✨

**[📚 查看插件主页](/) | [💬 加入交流群1](https://qm.qq.com/q/unjAw930RO) [💬 加入交流群2](https://qm.qq.com/q/tEqFnH0kTe) | [⭐ 给个Star](/)**

</div>

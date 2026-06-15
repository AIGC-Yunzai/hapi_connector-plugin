![](https://socialify.git.ci/AIGC-Yunzai/hapi_connector-plugin/image?font=KoHo&forks=1&issues=1&language=1&name=1&owner=1&pattern=Circuit+Board&pulls=1&stargazers=1&theme=Auto)

<div align="center">

# HAPI Connector for TRSS-Yunzai

_把 Claude Code / Codex / Gemini / OpenCode 会话搬进聊天窗口。_

<img decoding="async" align=right src="resources/readme/girl.webp" width="35%">

</div>

## 这是什么

`hapi_connector-plugin` 是云崽 / TRSS-Yunzai 版的 HAPI 遥控器。它连接 [HAPI](https://github.com/tiann/hapi) 后端，通过 QQ/微信等聊天窗口远程查看、切换、创建和管理 AI 编码会话，并接收 SSE 实时通知。

适合这些场景：

- 离开电脑后继续推进 Claude Code / Codex 任务
- 在手机上审批工具权限请求
- 多个项目、多种代理并行运行时按聊天窗口隔离通知
- 从聊天窗口查看远端目录、搜索文件、下载/上传小文件

### 预览

<img decoding="async" width="150" align=right src="https://github.com/user-attachments/assets/130bf2fd-e116-4b89-aaa4-884dad5bf21c">

- 示例中连接的是 Claude Code
- 支持 Markdown 图片回复

<img width="230" alt="image" src="https://github.com/user-attachments/assets/f01e4ca9-176d-4812-8177-3d63623d13d7" />

<img width="230" alt="image" src="https://github.com/user-attachments/assets/8dfaf13d-d1a4-40c9-9d2b-91abaa071f1c" />


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

改完连接配置后重启云崽，让 SSE 监听和运行时缓存完整生效。

## 指令前缀

所有 HAPI 指令同时支持 `/hapi` 和 `#hapi`：

```text
/hapi list
#hapi list
#hapi help
#hapi帮助
```

快捷发送默认使用 `>`：

```text
> 继续刚才的任务
```

> [!IMPORTANT]
> 所有 `#hapi` 指令仅对云崽主人权限生效，普通用户无法使用任何 HAPI 指令

## 常用命令

### 会话查看

```text
#hapi list                 查看当前窗口可见 session
#hapi list all             查看全部 session
#hapi sw <序号|ID前缀>      切换当前 session
#hapi s                    查看当前 session 状态
#hapi msg [条数]           查看最近消息
```

### 消息发送

```text
#hapi chat <内容>          发送到当前 session
#hapi chatN <内容>         发送到第 N 个 session，例如 #hapi chat2 继续
#hapi to <序号> <内容>      发送到指定 session
> 内容                     快捷发送到当前 session
>{N} 内容                    快捷发送到第 N 个 session
> 上传附件3张 [内容]         等待 3 个附件后发送到当前 session
> {N} 上传附件5份 [内容]     等待 5 个附件后发送到第 N 个 session
```

快捷发送、`#hapi chat`、`#hapi chatN`、`#hapi to` 支持同一条消息附带图片/视频/文件等附件，插件会先上传附件到 HAPI，再把附件引用随消息发送。`> 上传附件3张` 会进入等待模式，按提示继续发送附件即可。

### Session 管理

```text
#hapi machines                                  查看在线机器
#hapi create <machineId> <目录> <agent> [...]    创建 session
#hapi abort [序号|ID前缀]                        中断 session
#hapi remote                                    切到 remote 托管模式
#hapi archive                                   归档当前 session
#hapi resume [序号|ID前缀]                       恢复 inactive session
#hapi rename <新标题>                            重命名当前 session
#hapi delete [序号|ID前缀]                       删除 session
#hapi clean [路径前缀] confirm                   清理 inactive sessions
```

`#hapi create` 不带完整参数时会进入分步向导模式。

`create` 的完整格式：

```text
#hapi create <machineId> <目录> <claude|codex|gemini|opencode> [simple|worktree] [模型] [推理强度] [权限模式] [yolo]
```

示例：

```text
#hapi create my-pc E:/myrepo/project codex simple yolo high
#hapi create my-pc E:/myrepo/project claude simple opus high bypassPermissions
```

### 权限审批

```text
#hapi pending             查看待审批
#hapi a                   批准全部普通请求
#hapi approve             批准全部普通请求
#hapi allow <序号>        批准单个普通请求
#hapi answer <序号> <答案> 回答 question 请求
#hapi deny [序号]         拒绝全部或单个请求
戳一戳机器人              批准全部普通请求
```

`#hapi answer` 只用于回答 HAPI agent 发起的 question 请求，不会把内容当作普通聊天消息发送。普通对话请使用 `#hapi chat <内容>`、`#hapi chatN <内容>`、`#hapi to <序号> <内容>` 或快捷发送。

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
#hapi bind codex          设置 Codex 默认通知窗口
#hapi bind status         查看路由
#hapi bind reset          清除当前窗口绑定
#hapi routes              查看 session 推送路由
```

SSE 推送级别：

```text
silence / simple / summary / detail
```

插件维护：

```text
#hapi更新
```

## TODO

- [x] 云崽不同适配器对文件发送/接收能力有差异，文件上传与下载采用尽量通用的实现；如果某个适配器不支持发送文件，图片仍会优先以图片消息发送，普通文件会回退到 `segment.file`。

## 致谢

- [astrbot_plugin_hapi_connector](https://github.com/LiJinHao999/astrbot_plugin_hapi_connector)：参考了该插件的命令设计和 Hapi 配置帮助说明
- [siliconflow-plugin](https://github.com/AIGC-Yunzai/siliconflow-plugin)：借鉴了该插件的 Markdown 渲染实现

---

<div align="center">

### 🎨 让AI自己打工！✨

**[📚 查看插件主页](/) | [💬 加入交流群1](https://qm.qq.com/q/unjAw930RO) [💬 加入交流群2](https://qm.qq.com/q/tEqFnH0kTe) | [⭐ 给个Star](/)**

</div>

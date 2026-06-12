<div align="center">

# HAPI Connector for TRSS-Yunzai

_把 Claude Code / Codex / Gemini / OpenCode 会话搬进聊天窗口。_

</div>

## 这是什么

`hapi_connector-plugin` 是云崽 / TRSS-Yunzai 版的 HAPI 遥控器。它连接 [HAPI](https://github.com/tiann/hapi) 后端，通过 QQ/微信等聊天窗口远程查看、切换、创建和管理 AI 编码会话，并接收 SSE 实时通知。

适合这些场景：

- 离开电脑后继续推进 Claude Code / Codex 任务
- 在手机上审批工具权限请求
- 多个项目、多种代理并行运行时按聊天窗口隔离通知
- 从聊天窗口查看远端目录、搜索文件、下载/上传小文件

## 安装与配置

第一次使用请先看详细教程：[HAPI 安装与锅巴配置教程](docs/hapi-install-guoba.md)。

将插件放到：

```text
TRSS-Yunzai/plugins/hapi_connector-plugin
```

首次启动会自动生成：

```text
plugins/hapi_connector-plugin/config/config/hapi.yaml
```

至少填写：

```yaml
hapi_endpoint: "http://127.0.0.1:3006"
access_token: "your-token"
```

也可以在锅巴配置页修改。改完连接配置后建议重启云崽。

## 指令前缀

所有 HAPI 指令同时支持 `/hapi` 和 `#hapi`：

```text
/hapi list
#hapi list
#hapi帮助
```

快捷发送默认使用 `>`：

```text
> 继续刚才的任务
>2 帮我看一下报错
```

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
#hapi to <序号> <内容>      发送到指定 session
> 内容                     快捷发送到当前 session
>N 内容                    快捷发送到第 N 个 session
> 上传附件3张 [内容]         等待 3 个附件后发送到当前 session
> N 上传附件5份 [内容]       等待 5 个附件后发送到第 N 个 session
```

快捷发送、`#hapi to` 支持同一条消息附带图片/视频/文件等附件，插件会先上传附件到 HAPI，再把附件引用随消息发送。`> 上传附件3张` 会进入等待模式，按提示继续发送附件即可。

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

`create` 的完整格式：

```text
#hapi create <machineId> <目录> <claude|codex|gemini|opencode> [simple|worktree] [yolo] [reasoning]
```

示例：

```text
#hapi create my-pc E:/myrepo/project codex simple yolo high
```

### 权限审批

```text
#hapi pending             查看待审批
#hapi a                   批准全部普通请求
#hapi allow <序号>        批准单个普通请求
#hapi answer <序号> <答案> 回答 question 请求
#hapi deny [序号]         拒绝全部或单个请求
戳一戳机器人              批准全部普通请求
```

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

## 插件维护

参考云崽插件常见习惯，提供更新命令：

```text
#hapi更新
#hapi强制更新
#hapi更新 main
#hapi强制更新 dev
```

更新完成后会自动重启云崽以生效。

## 配置项

| 配置项 | 说明 | 默认值 |
| --- | --- | --- |
| `hapi_endpoint` | HAPI 服务地址 | 空 |
| `access_token` | HAPI Access Token，支持 `token:namespace` | 空 |
| `proxy_url` | HTTP/HTTPS 代理地址 | 空 |
| `cf_access_client_id` | Cloudflare Access Client ID | 空 |
| `cf_access_client_secret` | Cloudflare Access Client Secret | 空 |
| `jwt_lifetime` | JWT 有效期秒数 | `900` |
| `refresh_before_expiry` | 提前刷新秒数 | `180` |
| `output_level` | SSE 推送级别 | `simple` |
| `summary_msg_count` | summary 推送消息条数 | `5` |
| `quick_prefix` | 快捷发送前缀 | `>` |
| `remind_pending` | 待审批提醒 | `true` |
| `remind_interval` | 待审批提醒间隔 | `180` |
| `auto_approve_enabled` | 忙时托管审批 | `false` |
| `auto_approve_start` | 托管开始时间 | `23:00` |
| `auto_approve_end` | 托管结束时间 | `07:00` |
| `max_reconnect_attempts` | SSE 最大连续重连次数 | `30` |
| `enable_sse` | 启动 SSE 监听 | `true` |

## 文件结构

```text
hapi_connector-plugin/
├── apps/
│   ├── HapiConnector.js
│   ├── PokeApprove.js
│   └── Update.js
├── components/
│   ├── Config.js
│   ├── FileOps.js
│   ├── HapiClient.js
│   ├── SessionOps.js
│   ├── SseListener.js
│   └── State.js
├── config/
│   ├── hapi_default.yaml
│   └── config/hapi.yaml
├── model/path.js
├── utils/formatters.js
├── guoba.support.js
└── index.js
```

## 说明

本插件参考了 AstrBot 版 `astrbot_plugin_hapi_connector` 的命令设计，并按 TRSS-Yunzai 的插件规范重新实现。云崽不同适配器对文件发送/接收能力有差异，文件上传与下载采用尽量通用的实现；如果某个适配器不支持发送文件，图片仍会优先以图片消息发送，普通文件会回退到 `segment.file`。

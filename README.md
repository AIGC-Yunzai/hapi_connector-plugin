# hapi_connector-plugin

云崽 / TRSS-Yunzai 版 HAPI Connector，用聊天命令远程管理 HAPI 中的 Claude Code、Codex、Gemini、OpenCode 会话。

## 配置

首次启动会生成：

```text
plugins/hapi_connector-plugin/config/config/hapi.yaml
```

至少填写：

```yaml
hapi_endpoint: "http://127.0.0.1:3006"
access_token: "your-token"
```

也可以通过锅巴配置页修改。

## 常用命令

```text
/hapi help
/hapi list
/hapi sw <序号或ID前缀>
/hapi s
/hapi msg [条数]
/hapi to <序号> <内容>
> 内容
>2 内容
/hapi pending
/hapi a
/hapi deny [序号]
/hapi bind [claude|codex|gemini|opencode]
```

更多命令：

```text
/hapi help 全部
```

## 已实现

- HAPI JWT 自动获取与刷新
- `/hapi` 常用会话管理、消息发送、审批、模式切换
- `>` 快捷发送
- SSE 后台通知与按聊天窗口绑定路由
- 远端目录浏览、文件搜索、小文件读取
- 锅巴配置支持

文件上传/下载到聊天窗口在不同云崽适配器上差异较大，本版先提供远端目录、搜索和读取能力。

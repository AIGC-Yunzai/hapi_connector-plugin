# HAPI 安装与锅巴配置教程

这份教程用于把 HAPI Hub 接到 `hapi_connector-plugin`，然后在 TRSS-Yunzai 的锅巴面板里完成配置。

## 你需要准备什么

- 一台能运行 HAPI Hub 的机器，通常就是运行 TRSS-Yunzai 的服务器。
- Node.js / pnpm 或 npm。
- 已安装并能登录的 Claude Code / Codex / Gemini / OpenCode 之一。
- 已安装本插件：`TRSS-Yunzai/plugins/hapi_connector-plugin`。

## 方式一：使用 Yunzai-Bot-Shell 菜单安装（仅限 Ubuntu）

如果你使用 `Yunzai-Bot-Shell`，推荐直接走脚本菜单。

```sh
bash <(curl -sL https://github.com/misaka20002/Bot-Install-Shell/raw/master/Manage/SYS_Manage.sh)
```


进入系统管理脚本后选择：

```text
9. Hapi / Claude Code
```

常用菜单项：

```text
1. 安装/更新 Claude Code
2. 配置 Claude Code
3. 安装/更新 Hapi
4. 设置/运行 Hapi runner 工作目录
5. 设置 Hapi CLI
6. 运行 Hapi hub
7. 停止 Hapi
8. 卸载
```

推荐流程：

1. 先选 `3. 安装/更新 Hapi`。
   脚本会执行类似下面的命令：

   ```bash
   pnpm add -g @twsxtd/hapi
   hapi --version
   ```

2. 如果要远程创建 session，选 `4. 设置/运行 Hapi runner 工作目录`。
   建议至少加入你的 TRSS-Yunzai 或常用代码目录。Runner 是全局单实例，新设置会覆盖当前 runner 的 workspace-root。

3. 选 `5. 设置 Hapi CLI`。
   这里可以设置 `listenHost` / `listenPort`，也可以查看或设置 `cliApiToken`。

4. 选 `6. 运行 Hapi hub`。
   脚本会用 tmux 后台运行：

   ```bash
   hapi hub --relay
   ```

   启动成功后会尝试提取 Hub URL。注意：脚本输出的 URL 可能带 token，不要发给别人。

5. 在 `5. 设置 Hapi CLI` 里选择插件配置帮助，脚本会根据当前端口和 token 提示你应该填什么。

## 方式二：手动安装 HAPI

### 1. 安装 HAPI CLI

任选一种：

```bash
npm install -g @twsxtd/hapi
```

或：

```bash
pnpm add -g @twsxtd/hapi
```

安装后确认：

```bash
hapi --version
```

### 2. 启动 HAPI Hub

Hub 是核心服务，负责会话、权限请求、文件上传和 SSE 推送。

同一台机器运行 TRSS-Yunzai 和 HAPI：

```bash
hapi hub --no-relay
```

使用官方中继，适合外网访问或 NAT 环境：

```bash
hapi hub --relay
```

不带参数的 `hapi hub` 通常等同于中继模式。启动后终端会显示访问 URL。

Docker 或局域网访问时，需要让 Hub 监听所有网卡。编辑 `~/.hapi/settings.json`：

```json
{
  "listenHost": "0.0.0.0",
  "listenPort": 3006
}
```

然后重启 Hub。

### 3. 可选：后台运行

简单方式：

```bash
nohup hapi hub --relay > ~/.hapi/hub.log 2>&1 &
```

如果使用 pm2：

```bash
pm2 start "hapi hub --relay" --name hapi-hub
pm2 save
```

Linux systemd 用户也可以写 user service。配置后记得确认 Hub 真的在运行：

```bash
curl http://127.0.0.1:3006
```

返回内容不重要，能连接上即可。

### 4. 可选：启动 Runner

Runner 用于从聊天窗口远程创建 session。如果不启动 Runner，你仍然可以管理已有 session，但不能方便地让 HAPI 在指定机器上新建任务。

```bash
hapi runner start --workspace-root /root/TRSS-Yunzai
hapi runner status
```

多个工作目录可以重复传 `--workspace-root`。

## 获取 Access Token

首次启动 Hub 后，HAPI 会生成 `~/.hapi/settings.json`。

查看：

```bash
cat ~/.hapi/settings.json
```

找到：

```json
{
  "cliApiToken": "这里就是 access_token"
}
```

`cliApiToken` 就是锅巴里要填写的 `access_token`。

这个 token 是敏感凭据，不要发到群里，也不要贴到公开 issue。

## 锅巴配置

进入锅巴管理面板，找到：

```text
hapi_connector-plugin / HAPI Connector
```

至少填写：

```yaml
hapi_endpoint: "http://127.0.0.1:3006"
access_token: "你的 cliApiToken"
```

常见 `hapi_endpoint` 填法：

| 场景 | 填写值 |
| --- | --- |
| TRSS-Yunzai 与 HAPI 在同一宿主机，非 Docker | `http://127.0.0.1:3006` 或 `http://localhost:3006` |
| TRSS-Yunzai 在 Docker，HAPI 在 Linux 宿主机 | `http://172.17.0.1:3006` |
| TRSS-Yunzai 在 Docker，HAPI 在 Windows/macOS 宿主机 | `http://host.docker.internal:3006` |
| 同一局域网或 Tailscale | `http://<HAPI机器IP>:3006` |
| 自建域名 / 反向代理 / Cloudflare Tunnel | `https://你的域名` |
| HAPI 官方中继 | 使用 Hub 输出的可访问地址 |

Docker、局域网、Tailscale 场景通常需要先设置：

```json
{
  "listenHost": "0.0.0.0"
}
```

否则 HAPI 只监听 `127.0.0.1`，容器或其他机器访问不到。

### 推荐打开的配置

```yaml
enable_sse: true
output_level: "simple"
quick_send_enabled: true
quick_prefix: ">"
quick_group_at_bot_only: false
remind_pending: true
enable_poke_approve: true
```

如果你走了 Cloudflare Access，再填写：

```yaml
cf_access_client_id: ""
cf_access_client_secret: ""
```

详细步骤见：[Cloudflare Zero Trust Access 配置指南](cf-access-guide.md)。

如果服务器访问 HAPI 要走 HTTP/HTTPS 代理，再填写：

```yaml
proxy_url: "http://127.0.0.1:7890"
```

保存锅巴配置后，建议重启 TRSS-Yunzai，让连接和 SSE 监听完整生效。

## 验证是否成功

在主人账号发送：

```text
#hapi list
```

正常情况：

- 控制台出现 `SSE 连接成功`。
- 聊天窗口返回 session 列表，或提示当前没有 session。

继续验证 runner：

```text
#hapi machines
```

如果能看到机器，说明 runner 已接入。

创建一个 Codex session 示例：

```text
#hapi create my-pc /root/TRSS-Yunzai codex simple yolo high
```

实际的 `machineId` 请以 `#hapi machines` 返回为准。

## 常见问题

### `#hapi list` 提示连接失败

检查：

- `hapi hub` 是否正在运行。
- 锅巴里的 `hapi_endpoint` 是否能从 TRSS-Yunzai 所在环境访问。
- Docker 场景是否已经设置 `listenHost: "0.0.0.0"`。
- `access_token` 是否等于 `~/.hapi/settings.json` 里的 `cliApiToken`。

### SSE 连接不上

检查：

- `enable_sse` 是否开启。
- 反向代理是否支持 SSE。
- 如果使用 Cloudflare Tunnel，不要使用临时 Quick Tunnel，建议使用 Named Tunnel。
- 代理或防火墙是否中断长连接。

### 锅巴保存后没生效

重启 TRSS-Yunzai。连接配置、SSE 监听和部分运行时缓存重启后最稳。

### Docker 内访问宿主机失败

Linux Docker 默认可尝试：

```text
http://172.17.0.1:3006
```

Windows/macOS Docker 可尝试：

```text
http://host.docker.internal:3006
```

同时确认 HAPI 的 `listenHost` 是 `0.0.0.0`。

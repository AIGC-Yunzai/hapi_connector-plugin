# Cloudflare Zero Trust Access 配置指南

这份文档用于把 HAPI Hub 放在 Cloudflare Zero Trust Access 后面，并让 `hapi_connector-plugin` 通过 Service Token 访问它。

适用场景：

- HAPI Hub 通过 Cloudflare Tunnel 或反向代理暴露为 `https://hapi.example.com`
- 浏览器访问 HAPI 域名时希望继续走 Cloudflare Access 登录
- TRSS-Yunzai 插件需要后台免交互访问 HAPI API 和 SSE

> 参考：Cloudflare 官方文档的 [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) 和 [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)；本文按本插件的配置项整理。

## 工作原理

Cloudflare Access 会拦截受保护域名的请求。插件无法像浏览器一样完成邮箱或 SSO 登录，所以需要使用 Cloudflare 的 Service Token。

本插件会在请求 HAPI 时自动附加这两个请求头：

```http
CF-Access-Client-Id: <Client ID>
CF-Access-Client-Secret: <Client Secret>
```

它们只负责通过 Cloudflare Access。通过 Cloudflare 之后，插件仍然会用 HAPI 自己的 `access_token` 换取 JWT，因此你需要同时配置：

- `hapi_endpoint`：Cloudflare Access 保护的 HAPI 域名
- `access_token`：HAPI 的 `cliApiToken`
- `cf_access_client_id`：Cloudflare Service Token 的 Client ID
- `cf_access_client_secret`：Cloudflare Service Token 的 Client Secret

## 前置条件

你需要先完成这些事情：

1. HAPI Hub 已经能在内网或本机访问，例如 `http://127.0.0.1:3006`。
2. 已经有一个可用域名，例如 `hapi.example.com`。
3. HAPI 域名已经通过 Cloudflare Tunnel、反向代理或其它方式接入 Cloudflare。
4. Cloudflare Zero Trust 中已经创建了一个保护该域名的 Access Application。

如果你还没配置 Cloudflare Tunnel，建议优先使用 Named Tunnel，不建议长期使用临时 Quick Tunnel。临时地址会变化，也更容易导致 SSE 连接不稳定。

## 步骤一：创建 Service Token

1. 打开 [Cloudflare Zero Trust 控制台](https://one.dash.cloudflare.com/)。
2. 进入 `Access controls` -> `Service credentials` -> `Service Tokens`。
3. 点击 `Create Service Token`。
4. 填写名称，例如 `yunzai-hapi`。
5. 选择有效期。建议根据自己的维护周期设置，并记录到期时间。
6. 点击生成后，立即复制并保存：
   - Client ID
   - Client Secret

> Client Secret 只会在创建时显示一次。关闭页面后无法再次查看；如果丢失，只能重新生成或轮换 Service Token。

## 步骤二：给 HAPI Access Application 添加 Service Auth 策略

只有创建 Service Token 还不够，还要让 HAPI 的 Access Application 接受这个 token。

1. 在 Zero Trust 控制台进入 `Access controls` -> `Applications`。
2. 找到 HAPI 域名对应的 Access Application，例如 `hapi.example.com`。
3. 进入应用详情或编辑页面，找到 `Policies`。
4. 新建或添加一条策略：

```text
Policy name: hapi-service-auth
Action: Service Auth
Include:
  Selector: Service Token
  Value: yunzai-hapi
```

5. 保存策略，并确认它已经关联到 HAPI 这个 Application。

`Service Auth` 策略用于非浏览器后台程序认证。你可以同时保留原来的 `Allow` 策略，这样浏览器访问仍然走邮箱、SSO 或其它登录方式，插件请求则用 Service Token 通过。

## 步骤三：填写锅巴配置

进入锅巴：

```text
hapi_connector-plugin / HAPI Connector
```

填写：

```yaml
hapi_endpoint: "https://hapi.example.com"
access_token: "你的 HAPI cliApiToken"
cf_access_client_id: "你的 Cloudflare Client ID"
cf_access_client_secret: "你的 Cloudflare Client Secret"
```

也可以直接写 Cloudflare 页面提示的完整 header 值，本插件会自动去掉前缀：

```yaml
cf_access_client_id: "cf-access-client-id: xxxxx.access"
cf_access_client_secret: "cf-access-client-secret: yyyyy"
```

推荐同时开启：

```yaml
enable_sse: true
output_level: "simple"
```

保存锅巴配置后，建议重启 TRSS-Yunzai，让连接、JWT 缓存和 SSE 监听完整刷新。

## 步骤四：验证连通性

### 在聊天里验证

主人账号发送：

```text
#hapi list
```

正常情况：

- 机器人返回 session 列表，或提示没有 session。
- 控制台出现类似 `SSE 连接成功: https://hapi.example.com`。

继续验证 SSE 和权限推送：

```text
#hapi pending
```

如果 HAPI 有待审批请求，插件应能正常拉取并回复。

### 用 curl 验证 Cloudflare Access

在 TRSS-Yunzai 所在机器上测试：

```bash
curl -i \
  -H "CF-Access-Client-Id: <Client ID>" \
  -H "CF-Access-Client-Secret: <Client Secret>" \
  https://hapi.example.com/api/auth
```

这里没有带 HAPI `access_token`，所以 HAPI 可能返回业务层错误；重点看是否已经不再返回 Cloudflare Access 的登录页。如果返回 HTML 登录页，说明 Service Token 没有通过 Access。

## 常见问题

### `#hapi list` 返回 403 或 Cloudflare 登录页

检查：

- `cf_access_client_id` 和 `cf_access_client_secret` 是否填反。
- Client Secret 是否完整复制，没有多余空格。
- Access Application 是否添加了 `Service Auth` 策略。
- Include 规则是否选择了正确的 `Service Token`。
- `hapi_endpoint` 是否正好是该 Access Application 保护的域名。

### 提示获取 JWT 失败

Cloudflare 已经可能放行，但 HAPI 自己的认证失败。检查：

- `access_token` 是否等于 HAPI `~/.hapi/settings.json` 里的 `cliApiToken`。
- `hapi_endpoint` 是否没有多余路径，例如不要写成 `https://hapi.example.com/api`。
- HAPI Hub 是否仍在运行。

### SSE 连接失败或返回非 `text/event-stream`

检查：

- Cloudflare Tunnel 或反向代理是否支持长连接和流式响应。
- 不要让代理缓存 `/api/events`。
- 尽量使用 Named Tunnel。
- 锅巴里 `enable_sse` 是否开启。

### 浏览器能打开，但插件不能连接

浏览器登录通过的是用户身份策略；插件使用的是 Service Token。浏览器能打开不代表 Service Token 策略已生效。按“用 curl 验证 Cloudflare Access”一节单独测试 Service Token。

### Service Token 过期

Service Token 到期后插件会被 Cloudflare Access 拦截。你需要在 Cloudflare Zero Trust 中续期、轮换或重新创建 token，并更新锅巴里的 `cf_access_client_id` / `cf_access_client_secret`。

## 安全建议

- 不要把 Client Secret 发到群里、日志、公开 issue 或截图中。
- 建议给 Service Token 起一个容易识别的名字，例如 `yunzai-hapi-prod`。
- 给 token 设置合理有效期，并提前记录轮换时间。
- 不要为了省事使用 Bypass 放行整个 HAPI 域名；需要后台免登录时优先使用 Service Auth。
- HAPI 的 `access_token` 和 Cloudflare Service Token 是两层不同凭据，都要妥善保管。

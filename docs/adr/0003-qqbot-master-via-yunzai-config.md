# 机器人主人写进 Yunzai 的 master 配置，而不是插件自建白名单

官方机器人的 `self_id` 是 AppID、`user_id` 是 openid，都不在 `masterQQ` 里，所以 `e.isMaster` 对它恒为 `false`——这导致官方机器人既发不出 `#hapi` 指令，也用不了快捷发送。

决定：把「谁是主人」这件事交回 Yunzai，用原生 `#设置主人` 写入 `config/config/other.yaml` 的 `master` 列表（`<appid>:<openid>`）。插件不维护任何 openid 白名单。

## 为什么不自己记

自建白名单意味着要再造一套「谁能管理这个 bot」的判定，并且和 Yunzai 的权限体系并行两套。后果是所有 `permission: 'master'` 的插件行为都要单独适配，而 `e.isMaster` 依旧为 false——等于把问题挪个地方，没解决。

写进 `master` 之后，`e.isMaster` 真的变 true，现有代码（`quickSend` 的 `if (!e.isMaster) return false`、`hapi()` 的第一行）一行都不用改。这条路在微信 OC 适配器上已经被验证过（`master: - weixin_personal_001:wx_…@im.wechat`）。

## 为什么不自动认领

「登录后第一个私聊的人自动成为主人」能省一步操作，但把「谁先发消息谁接管」这个攻击面重新引回来了，而它省下的只是复制一次验证码。`#设置主人` 的验证码打在服务器控制台，这个门槛是有意义的。

## 后果

- 登录那一刻拿不到 openid（扫码只返回 AppID/AppSecret），所以绑定必须发生在登录之后，由用户私聊机器人完成。
- 配置写入后约 5 秒才被 chokidar 重载，不是即时的。
- 成为主人意味着这个 openid 可以通过该机器人调用**所有** `permission: 'master'` 的插件，不止 hapi。这是「机器人主人」的应有之义，但要写进文档。

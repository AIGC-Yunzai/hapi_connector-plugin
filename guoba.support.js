import Config from './components/Config.js'

export function supportGuoba() {
  // 只读「帮助」标签页：label 写功能标题，只读 input 内容(defaultValue)写指令。
  // 这些 help_* 字段仅用于展示，不会写入配置（见 setConfigData 过滤）。
  const helpDivider = (label) => ({
    component: 'Divider',
    label,
    componentProps: { orientation: 'left', plain: true },
  })
  const helpItem = (key, title, command) => ({
    field: `help_${key}`,
    label: title,
    component: 'Input',
    componentProps: { readonly: true, defaultValue: command },
  })
  const helpSchemas = [
    helpDivider('会话与对话'),
    helpItem('list', '查看 session 列表（当前聊天 / 全部）', '#hapi list [all]'),
    helpItem('sw', '切换当前 session', '#hapi sw <序号|ID前缀>'),
    helpItem('s', '查看当前 session 状态', '#hapi s'),
    helpItem('msg', '查看最近消息', '#hapi msg [条数]'),
    helpItem('chat', '发消息到当前 session', '#hapi chat <内容>'),
    helpItem('chatn', '发消息到第 N 个 session', '#hapi chatN <内容>（如 #hapi chat2 继续）'),
    helpItem('to', '发消息到指定 session', '#hapi to <序号> <内容>'),
    helpItem('quick', '快捷发送到当前 / 第 N 个 session（可带附件）', '> 内容  /  >{N} 内容  /  > 上传附件3张 [内容]'),
    helpDivider('权限审批'),
    helpItem('pending', '查看待审批', '#hapi pending'),
    helpItem('a', '批准全部普通请求', '#hapi a'),
    helpItem('allow', '批准单个普通请求', '#hapi allow <序号>'),
    helpItem('answer', '回答 question 请求（不是普通聊天，普通对话用 #hapi chat）', '#hapi answer <序号> <答案>'),
    helpItem('deny', '拒绝全部或单个请求', '#hapi deny [序号]'),
    helpItem('poke', '批准全部普通请求（需开启「戳一戳审核」）', '戳一戳机器人'),
    helpDivider('Session 管理'),
    helpItem('machines', '查看在线机器', '#hapi machines'),
    helpItem('create', '创建 session（不带完整参数进入分步向导）', '#hapi create <machineId> <目录> <agent> [simple|worktree] [模型] [推理强度] [权限模式] [yolo]'),
    helpItem('abort', '中断 session', '#hapi abort [目标]'),
    helpItem('remote', '切到 remote 托管模式', '#hapi remote'),
    helpItem('archive', '归档当前 session', '#hapi archive'),
    helpItem('resume', '恢复 inactive session', '#hapi resume [目标]'),
    helpItem('rename', '重命名当前 session', '#hapi rename <新标题>'),
    helpItem('delete', '删除 session', '#hapi delete [目标]'),
    helpItem('clean', '清理 inactive sessions', '#hapi clean [路径] confirm'),
    helpDivider('文件操作'),
    helpItem('files', '浏览远端目录（-l 同时显示大小）', '#hapi files [路径]  /  #hapi files -l [路径]'),
    helpItem('find', '搜索远端文件', '#hapi find <关键词>'),
    helpItem('read', '读取远端小文本文件', '#hapi read <路径>'),
    helpItem('download', '下载远端文件到聊天', '#hapi download <路径>'),
    helpItem('upload', '上传聊天附件到当前 session', '#hapi upload [附件]'),
    helpItem('uploadcancel', '删除当前 session 已上传 blob', '#hapi upload cancel'),
    helpDivider('模式与通知'),
    helpItem('perm', '查看 / 切换权限模式', '#hapi perm [模式]'),
    helpItem('model', '查看 / 切换模型（支持 opus[1m]）', '#hapi model [模式]'),
    helpItem('effort', '查看 / 切换推理强度', '#hapi effort [值]'),
    helpItem('plan', '切换 Plan 模式', '#hapi plan'),
    helpItem('output', '查看 / 切换 SSE 推送级别（不带值会等待下一条消息）', '#hapi output [级别]'),
    helpItem('bind', '设置 / 查看 / 清除默认通知窗口', '#hapi bind [flavor]  /  status  /  reset'),
    helpItem('routes', '查看 session 推送路由', '#hapi routes'),
    helpItem('help', '查看完整帮助', '#hapi help（等同 #hapi帮助）'),
    helpItem('update', '更新 / 强制更新插件', '#hapi更新  /  #hapi强制更新'),
  ]

  return {
    pluginInfo: {
      name: 'hapi_connector-plugin',
      title: 'HAPI Connector',
      author: ['@misaka20002', '@127Wzc'],
      authorLink: ['https://github.com/misaka20002', 'https://github.com/127Wzc'],
      link: 'https://github.com/AIGC-Yunzai/hapi_connector-plugin',
      isV3: true,
      isV2: false,
      showInMenu: true,
      description: '通过云崽聊天窗口远程管理 HAPI / Claude Code / Codex / Gemini 会话',
      icon: 'mdi:console-network-outline',
      iconColor: '#2f855a',
    },
    configInfo: {
      schemas: [
        {
          label: '配置',
          component: 'SOFT_GROUP_BEGIN',
        },
        {
          component: 'Divider',
          label: '连接设置',
          componentProps: { orientation: 'left', plain: true },
        },
        {
          field: 'hapi_endpoint',
          label: 'HAPI 服务地址',
          component: 'Input',
          bottomHelpMessage: '例如 http://127.0.0.1:3006',
        },
        {
          field: 'access_token',
          label: 'Access Token',
          component: 'InputPassword',
          bottomHelpMessage: '支持 token:namespace 格式；修改后重启生效',
        },
        {
          field: 'proxy_url',
          label: '代理地址',
          component: 'Input',
          bottomHelpMessage: '可选，支持 http:// 与 https:// 代理',
        },
        {
          field: 'cf_access_client_id',
          label: 'CF Access Client ID',
          component: 'InputPassword',
          bottomHelpMessage: '可选，当需要使用 Cloudflare Zero Trust Service 隧道时填写；详细步骤见 docs/cf-access-guide.md',
        },
        {
          field: 'cf_access_client_secret',
          label: 'CF Access Client Secret',
          component: 'InputPassword',
          bottomHelpMessage: '同上',
        },
        {
          component: 'Divider',
          label: '触发设置',
          componentProps: { orientation: 'left', plain: true },
        },
        {
          field: 'quick_send_enabled',
          label: '启用快捷发送',
          component: 'Switch',
          bottomHelpMessage: '关闭后不响应 quickSend，例如 "> 内容" 或自定义快捷前缀消息',
        },
        {
          field: 'quick_prefix',
          label: '快捷前缀',
          component: 'Input',
          bottomHelpMessage: '默认 >；例如 "> 内容" 发到当前 session，">{2} 内容" 发到第 2 个 session。留空会关闭 quickSend；默认 > 时兼容全角 ＞',
        },
        {
          field: 'quick_group_at_bot_only',
          label: '群聊快捷发送需 @Bot',
          component: 'Switch',
          bottomHelpMessage: '仅影响 quickSend。开启后，群聊只响应主人且 @Bot 的快捷发送消息',
        },
        {
          component: 'Divider',
          label: '推送设置',
          componentProps: { orientation: 'left', plain: true },
        },
        {
          field: 'enable_sse',
          label: '启用 SSE',
          component: 'Switch',
          bottomHelpMessage: '开启后能实时推送 hapi 对话消息',
        },
        {
          field: 'output_level',
          label: '推送级别',
          component: 'Select',
          componentProps: {
            options: [
              { label: 'silence', value: 'silence' },
              { label: 'simple', value: 'simple' },
              { label: 'summary', value: 'summary' },
              { label: 'detail', value: 'detail' },
            ],
          },
        },
        {
          field: 'markdown_image',
          label: '同时输出 Markdown 图片',
          component: 'Switch',
          bottomHelpMessage: '开启后，推送 AI 回复（SSE 推送与 #hapi msg）时额外渲染一张 markdown 图片一起发出',
        },
        {
          field: 'merge_forward_single_node',
          label: '合并为单节点转发',
          component: 'Switch',
          bottomHelpMessage: '开启后，多条消息合并为单个节点的合并转发（仍按字数上限约 6800 自动分隔）。用于微信 OC 等不支持合并转发、会降级为逐条发送且单周期消息条数有限的适配器',
        },
        {
          component: 'Divider',
          label: '审批设置',
          componentProps: { orientation: 'left', plain: true },
        },
        {
          field: 'remind_pending',
          label: '待审批提醒',
          component: 'Switch',
          bottomHelpMessage: 'hapi 遇到需要审批的任务时推送提醒',
        },
        {
          field: 'remind_interval',
          label: '提醒间隔秒',
          component: 'InputNumber',
          componentProps: { min: 30, step: 10 },
        },
        {
          field: 'enable_poke_approve',
          label: '开启戳一戳审核',
          component: 'Switch',
          bottomHelpMessage: '开启后，主人戳机器人会批准 HAPI 普通权限请求',
        },
        {
          field: 'auto_approve_enabled',
          label: '忙时托管审批',
          component: 'Switch',
          bottomHelpMessage: '危险功能：开启后自动通过所有需要审批的内容；但对于AskUserQuestion / ask_user_question / request_user_input 这类 question 请求无法自动审批',
        },
        {
          field: 'auto_approve_start',
          label: '托管开始',
          component: 'Input',
          bottomHelpMessage: '填写24进制时间，如 23:00',
        },
        {
          field: 'auto_approve_end',
          label: '托管结束',
          component: 'Input',
          bottomHelpMessage: '填写24进制时间，如 07:00',
        },
        {
          label: '帮助',
          component: 'SOFT_GROUP_BEGIN',
        },
        ...helpSchemas,
      ],
      getConfigData() {
        return Config.getConfig()
      },
      setConfigData(data, { Result }) {
        try {
          const config = Config.getConfig()
          for (const [key, value] of Object.entries(data)) {
            if (key.startsWith('help_')) continue
            config[key] = value
          }
          config.hapi_endpoint = String(config.hapi_endpoint || '').replace(/\/+$/, '')
          Config.setConfig(config)
          return Result.ok({}, '保存成功，重启云崽后完整生效')
        } catch (err) {
          return Result.error(`保存失败：${err.message || err}`)
        }
      },
    },
  }
}

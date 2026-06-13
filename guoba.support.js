import Config from './components/Config.js'

export function supportGuoba() {
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
        },
        {
          field: 'cf_access_client_secret',
          label: 'CF Access Client Secret',
          component: 'InputPassword',
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
          component: 'Divider',
          label: '审批设置',
          componentProps: { orientation: 'left', plain: true },
        },
        {
          field: 'remind_pending',
          label: '待审批提醒',
          component: 'Switch',
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
        },
        {
          field: 'auto_approve_start',
          label: '托管开始',
          component: 'Input',
        },
        {
          field: 'auto_approve_end',
          label: '托管结束',
          component: 'Input',
        },
      ],
      getConfigData() {
        return Config.getConfig()
      },
      setConfigData(data, { Result }) {
        try {
          const config = Config.getConfig()
          for (const [key, value] of Object.entries(data)) config[key] = value
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

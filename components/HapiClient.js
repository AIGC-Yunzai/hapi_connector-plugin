async function getFetch(proxyUrl = '') {
  if (proxyUrl) {
    const mod = await import('node-fetch')
    return mod.default
  }
  if (globalThis.fetch) return globalThis.fetch.bind(globalThis)
  const mod = await import('node-fetch')
  return mod.default
}

function cleanCfValue(value, prefix) {
  const text = String(value || '').trim()
  if (text.toLowerCase().startsWith(prefix)) return text.split(':').slice(1).join(':').trim()
  return text
}

export class HapiContentTypeError extends Error {
  constructor(message, contentType = '', snippet = '') {
    super(message)
    this.contentType = contentType
    this.snippet = snippet
  }
}

export class HapiClient {
  constructor(config) {
    this.configure(config)
    this.jwt = ''
    this.obtainedAt = 0
    this.authing = null
  }

  configure(config) {
    this.endpoint = String(config.hapi_endpoint || '').replace(/\/+$/, '')
    this.accessToken = String(config.access_token || '')
    this.jwtLifetime = Number(config.jwt_lifetime || 900)
    this.refreshBefore = Number(config.refresh_before_expiry || 180)
    this.proxyUrl = String(config.proxy_url || '').trim()
    this.cfClientId = cleanCfValue(config.cf_access_client_id, 'cf-access-client-id:')
    this.cfClientSecret = cleanCfValue(config.cf_access_client_secret, 'cf-access-client-secret:')
  }

  isConfigured() {
    return Boolean(this.endpoint && this.accessToken)
  }

  cfHeaders() {
    if (!this.cfClientId || !this.cfClientSecret) return {}
    return {
      'CF-Access-Client-Id': this.cfClientId,
      'CF-Access-Client-Secret': this.cfClientSecret,
    }
  }

  shouldRefresh() {
    if (!this.jwt) return true
    return Date.now() - this.obtainedAt >= (this.jwtLifetime - this.refreshBefore) * 1000
  }

  async proxyOptions() {
    if (!this.proxyUrl) return {}
    if (!/^https?:\/\//i.test(this.proxyUrl)) {
      logger.warn('[hapi-connector] 当前仅支持 HTTP/HTTPS proxy_url，已忽略 SOCKS 或未知代理')
      return {}
    }
    const { HttpsProxyAgent } = await import('https-proxy-agent')
    return { agent: new HttpsProxyAgent(this.proxyUrl) }
  }

  async getToken(force = false) {
    if (!force && !this.shouldRefresh()) return this.jwt
    if (!this.authing) {
      this.authing = this.auth().finally(() => {
        this.authing = null
      })
    }
    return this.authing
  }

  async auth() {
    const fetch = await getFetch(this.proxyUrl)
    const proxyOptions = await this.proxyOptions()
    const res = await fetch(`${this.endpoint}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.cfHeaders() },
      body: JSON.stringify({ accessToken: this.accessToken }),
      ...proxyOptions,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`获取 JWT 失败: ${res.status} ${body.slice(0, 200)}`)
    }
    const data = await res.json()
    this.jwt = data.token
    this.obtainedAt = Date.now()
    return this.jwt
  }

  async request(method, route, { json, params, auth = true, retry = true } = {}) {
    if (!this.endpoint) throw new Error('未配置 hapi_endpoint')
    const fetch = await getFetch(this.proxyUrl)
    const proxyOptions = await this.proxyOptions()
    const url = new URL(`${this.endpoint}${route}`)
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }

    const headers = { ...this.cfHeaders() }
    if (json !== undefined) headers['Content-Type'] = 'application/json'
    if (auth) headers.Authorization = `Bearer ${await this.getToken()}`

    let res = await fetch(url, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
      ...proxyOptions,
    })

    if (res.status === 401 && auth && retry) {
      headers.Authorization = `Bearer ${await this.getToken(true)}`
      res = await fetch(url, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
        ...proxyOptions,
      })
    }
    return res
  }

  async requestJson(method, route, opts = {}) {
    const res = await this.request(method, route, opts)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`)
    }
    return res.json()
  }

  get(route, opts) {
    return this.request('GET', route, opts)
  }

  post(route, opts) {
    return this.request('POST', route, opts)
  }

  patch(route, opts) {
    return this.request('PATCH', route, opts)
  }

  delete(route, opts) {
    return this.request('DELETE', route, opts)
  }

  async subscribeEvents({ signal } = {}) {
    const fetch = await getFetch(this.proxyUrl)
    const proxyOptions = await this.proxyOptions()
    const token = await this.getToken()
    const url = new URL(`${this.endpoint}/api/events`)
    url.searchParams.set('all', '1')
    url.searchParams.set('token', token)
    const res = await fetch(url, { headers: this.cfHeaders(), signal, ...proxyOptions })
    if (!res.ok) throw new Error(`SSE 连接失败: ${res.status} ${await res.text().catch(() => '')}`)
    const ct = res.headers.get('content-type') || ''
    if (!ct.includes('text/event-stream')) {
      const snippet = await res.text().catch(() => '')
      throw new HapiContentTypeError(`SSE 返回了非预期 Content-Type: ${ct}`, ct, snippet.slice(0, 200))
    }
    return res
  }
}

// 零依赖的 JSON HTTP：插件不引任何第三方包，出问题也少一层背锅的。
// 两个函数都做了超时兜底（Node 原生 http 没有默认超时）。
import http from 'node:http'
import https from 'node:https'

/** One JSON POST over node:http(s) — dependency-free and timeout-bounded. */
export function postJson(url, body, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch {
      reject(new Error(`invalid url: ${url}`))
      return
    }
    const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8')
    // node:http refuses https URLs outright, so pick the transport by scheme.
    const client = target.protocol === 'https:' ? https : http
    const req = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          ...headers,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          if (!raw) return resolve({ statusCode: res.statusCode, body: null })
          try {
            resolve({ statusCode: res.statusCode, body: JSON.parse(raw) })
          } catch {
            resolve({ statusCode: res.statusCode, body: raw })
          }
        })
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(payload)
  })
}

/** One JSON GET over node:http — used to ask LM Studio what it serves. */
export function getJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch {
      reject(new Error(`invalid url: ${url}`))
      return
    }
    const client = target.protocol === 'https:' ? https : http
    const req = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: 'GET',
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          if (!raw) return resolve({ statusCode: res.statusCode, body: null })
          try {
            resolve({ statusCode: res.statusCode, body: JSON.parse(raw) })
          } catch {
            resolve({ statusCode: res.statusCode, body: raw })
          }
        })
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

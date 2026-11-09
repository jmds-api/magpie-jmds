// A real local HTTP server supplies responses unavailable deterministically from a gateway.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../index.mjs'

const cache = mkdtempSync(join(tmpdir(), 'mpjmds-http-cache-'))
process.env.XDG_CACHE_HOME = cache
after(() => rmSync(cache, { recursive: true, force: true }))

const reset = new Date(Date.now() + 3600_000).toISOString()
const status = {
  group: { billing_mode: 'subscription' }, key: {},
  subscription: { status: 'active', windows: [
    { window: 'daily', used_usd: 5, limit_usd: 5, reset_at: reset },
    { window: 'weekly', used_usd: 20, limit_usd: 20, reset_at: new Date(Date.now() + 86400_000).toISOString() },
  ], extra_usage: {} }, models: [],
}

test('prices: one complete observed account price, balance first, lowest multiplier, stable order, null omitted', async () => {
  assert.equal(typeof plugin.JmdsPlugin, 'function')
  const prices = new Map([
    ['sub', { mode: 'subscription', rate: 0.1, pricing: { input: 1, output: 2, cache_read: 3, cache_write: 4 } }],
    ['balance', { mode: 'balance', rate: 2, pricing: { input: 8, output: 4, cache_read: 6, cache_write: 2 } }],
    ['lower', { mode: 'balance', rate: 1, pricing: { input: 10, output: 3, cache_read: 9, cache_write: 1 } }],
    ['tie', { mode: 'balance', rate: 1, pricing: { input: 7, output: 7, cache_read: 7, cache_write: 7 } }],
  ])
  const server = createServer((req, res) => {
    const row = prices.get(req.headers.authorization?.replace('Bearer ', ''))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url === '/v1/sub2api/key-status' ? {
      key: {}, group: { billing_mode: row.mode, rate_multiplier: row.rate },
      models: [{ id: 'plain-model', pricing: row.pricing }, { id: 'unpriced', pricing: null }],
      balance: { amount_usd: 10 }, subscription: { status: 'active', windows: [], extra_usage: {} },
    } : { models: [] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const h = await plugin.JmdsPlugin({}, { baseURL: `http://127.0.0.1:${server.address().port}` })
  const real = globalThis.fetch
  globalThis.fetch = (url, init) => String(url) === 'https://models.dev/api.json' ? Promise.resolve(new Response('{}')) : real(url, init)
  const auth = key => ({ type: 'api', key })
  const list = key => h.provider.models({ models: {} }, { auth: auth(key) })
  const cost = row => ({ input: row.input, output: row.output, cache: { read: row.cache_read, write: row.cache_write } })
  try {
    let got = await list('sub')
    assert.deepEqual(got['plain-model'].cost, cost(prices.get('sub').pricing))
    await h.auth.usage(async () => auth('balance'))
    got = await list('sub')
    assert.deepEqual(got['plain-model'].cost, cost(prices.get('balance').pricing))
    await h.auth.usage(async () => auth('lower'))
    await h.auth.usage(async () => auth('tie'))
    got = await list('sub')
    assert.deepEqual(got['plain-model'].cost, cost(prices.get('lower').pricing), 'whole price, not a fieldwise minimum')
    assert.equal(got.unpriced.cost, undefined)
    prices.get('lower').pricing = null
    await h.auth.usage(async () => auth('lower'))
    got = await list('sub')
    assert.deepEqual(got['plain-model'].cost, cost(prices.get('tie').pricing))
  } finally {
    globalThis.fetch = real
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
})

test('single provider, no exported helpers or routing policy, default URL and optional name', async () => {
  assert.deepEqual(Object.keys(plugin), ['JmdsPlugin'])
  const h = await plugin.JmdsPlugin()
  assert.equal(h.auth.provider, 'jmds')
  assert.deepEqual(h.auth.methods[0].prompts.map(p => p.key), ['name'])
  assert.equal(h.routing, undefined)
  const opts = await h.auth.loader(async () => ({ type: 'api', key: 'sk-test-key' }))
  assert.equal(opts.baseURL, 'https://api.jmds.dev/v1')
  assert.equal(typeof opts.fetch, 'function')
  const cfg = {}; h.config(cfg)
  assert.equal(cfg.provider.jmds.name, 'jmds')
})

test('loader fetch classifies supplied HTTP errors without changing success or unknown responses', async () => {
  assert.equal(typeof plugin.JmdsPlugin, 'function')
  let reply = { code: 'session_rate_limited', message: 'session usage limit exceeded' }
  let code = 429
  let snapshot = structuredClone(status)
  const server = createServer((req, res) => {
    if (req.url === '/v1/sub2api/key-status') {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(snapshot)); return
    }
    res.writeHead(code, { 'content-type': 'application/json', 'retry-after': '13', 'x-request-id': 'fixture' })
    res.end(JSON.stringify(reply))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${server.address().port}`
  const h = await plugin.JmdsPlugin({}, { baseURL })
  const auth = { type: 'api', key: 'sk-one' }
  const other = { type: 'api', key: 'sk-two' }
  const load = await h.auth.loader(async () => auth)
  const out = []
  async function request() {
    const res = await load.fetch(baseURL + '/v1/messages', { method: 'POST', body: '{}' })
    const text = await res.text()
    const row = { status: res.status, headers: Object.fromEntries(res.headers), body: JSON.parse(text) }
    delete row.headers.date; delete row.headers.connection; delete row.headers['keep-alive']
    out.push(row)
    assert.equal(res.headers.get('x-request-id'), 'fixture')
    return { res, body: row.body }
  }
  try {
    // Empty cache: nothing is inferred, even errors independent of billing mode.
    let got = await request()
    assert.deepEqual(got.body, reply)
    await h.auth.usage(async () => other)
    got = await request(); assert.deepEqual(got.body, reply, 'another account does not populate this account')
    await h.auth.usage(async () => auth)
    for (const shape of [c => ({ code: c }), c => ({ error: { code: c } }), c => ({ error: { type: c } })]) {
      for (const c of ['session_rate_limited', 'user_session_limit_exceeded']) {
        reply = { ...shape(c), message: 'usage limit exceeded for this session' }
        got = await request()
        assert.equal(got.res.status, 429)
        assert.match(got.body.error.message, /rate limit/i)
        assert.doesNotMatch(JSON.stringify(got.body), /quota|usage.?limit|exceeded.*limit|daily|weekly|monthly/i)
        assert.equal(got.res.headers.get('retry-after'), c === 'session_rate_limited' ? '13' : '60')
      }
    }
    reply = { error: { type: 'billing_error', message: 'billing blocked' } }; code = 403
    got = await request()
    assert.equal(got.res.status, 429)
    assert.match(got.body.error.message, /usage limit/i)
    assert.equal(got.body.error.resets_at, Math.floor(Date.parse(reset) / 1000))
    assert.doesNotMatch(JSON.stringify(got.body), /billing|credit|balance/i)
    for (const window of ['daily', 'weekly', 'monthly']) {
      reply = { code: 'USAGE_LIMIT_EXCEEDED', message: `${window} usage limit exceeded` }; code = 429
      got = await request()
      assert.equal(got.res.status, 429)
      assert.equal(got.body.error?.resets_at, window === 'monthly' ? undefined : Math.floor(Date.parse(snapshot.subscription.windows.find(w => w.window === window).reset_at) / 1000))
    }
    reply = { code: 'API_KEY_EXPIRED', message: 'expired' }; code = 403
    got = await request(); assert.equal(got.res.headers.get('x-magpie-sign-in'), 'expired')
    assert.equal(got.res.status, 403)
    for (const c of ['SUBSCRIPTION_INVALID', 'SUBSCRIPTION_NOT_FOUND']) {
      reply = { code: c, message: '套餐 usage limit quota' }
      got = await request()
      assert.equal(got.res.status, 402)
      assert.doesNotMatch(JSON.stringify(got.body), /quota|usage.?limit|套餐|用量|上限/i)
    }
    snapshot = { group: { billing_mode: 'balance' }, balance: { amount_usd: 0 }, key: {} }
    await h.auth.usage(async () => auth)
    reply = { error: { type: 'billing_error', message: 'Insufficient balance' } }; code = 403
    got = await request(); assert.equal(got.res.status, 403); assert.deepEqual(got.body, reply)
    reply = { code: 'unknown', message: 'unchanged' }; code = 503
    got = await request(); assert.equal(got.res.status, 503); assert.deepEqual(got.body, reply)
    reply = { code: 'session_rate_limited', message: 'success is not an error' }; code = 200
    got = await request(); assert.deepEqual(got.body, reply)
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    const dir = fileURLToPath(new URL(`./artifacts/${process.env.SUB2API_IMAGE_TAG ?? 'local'}/`, import.meta.url))
    mkdirSync(dir, { recursive: true }); writeFileSync(dir + 'http-errors.json', JSON.stringify(out, null, 2) + '\n')
  }
})

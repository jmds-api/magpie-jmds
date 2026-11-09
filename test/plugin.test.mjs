// Hooks called as magpie calls them, against the real disposable gateway.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import * as plugin from '../index.mjs'
const here = dirname(fileURLToPath(import.meta.url))
const state = JSON.parse(readFileSync(process.env.STATE, 'utf8'))
const tag = process.env.SUB2API_IMAGE_TAG
const out = join(here, 'artifacts', tag)
mkdirSync(out, { recursive: true })
const DAY = 86400
const host = new URL(state.base).host
const authOf = mode => ({ type: 'api', key: state.keys[mode], metadata: {} })
const client = () => ({ sets: [], auth: { async set(req) { this.owner.sets.push(req) } } })
function fakeClient() { const c = client(); c.auth.owner = c; return c }
const make = c => plugin.JmdsPlugin({ client: c ?? fakeClient() }, { baseURL: state.base })
const dump = (name, body) => writeFileSync(join(out, `${name}.json`), JSON.stringify(body, null, 2) + '\n')
let hooks
const cache = mkdtempSync(join(tmpdir(), 'mpjmds-cache-'))
process.env.XDG_CACHE_HOME = cache
after(() => rmSync(cache, { recursive: true, force: true }))
const fixture = JSON.parse(readFileSync(join(here, 'models-dev.json'), 'utf8'))
let catalogue = fixture, asked = 0
const realFetch = globalThis.fetch
globalThis.fetch = (url, init) => {
  if (String(url) !== 'https://models.dev/api.json') return realFetch(url, init)
  asked++
  if (catalogue === 'down') throw new TypeError('offline')
  if (catalogue === 'hang') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
  return Promise.resolve(new Response(JSON.stringify(catalogue), { headers: { 'content-type': 'application/json' } }))
}
const endpoint = state.fork ? '/v1/sub2api/key-status' : '/v1/usage'
async function raw(mode) { const r = await fetch(state.base + endpoint, { headers: { authorization: `Bearer ${state.keys[mode]}` } }); assert.equal(r.status, 200); return r.json() }
async function read(mode, h = hooks, suffix = mode) {
  const usage = await h.auth.usage(async () => authOf(mode))
  const upstream = await raw(mode)
  dump(suffix, { image: process.env.SUB2API_IMAGE, usage, upstream })
  return { usage, upstream }
}
before(async () => { hooks = await make() })

test('single provider, loader and optional account naming', async () => {
  assert.deepEqual(Object.keys(plugin), ['JmdsPlugin'])
  const c = fakeClient(), h = await make(c)
  const auth = { ...authOf('subscription'), metadata: { name: '  work key  ' } }
  assert.deepEqual(h.auth.methods[0].prompts.map(p => p.key), ['name'])
  const got = await h.auth.loader(async () => auth)
  assert.equal(got.baseURL, state.base + '/v1')
  assert.equal(got.apiKey, auth.key)
  assert.equal(typeof got.fetch, 'function')
  assert.equal(c.sets[0].body.accountId, 'work key')
  assert.equal(c.sets[0].path.id, 'jmds')
  await h.auth.loader(async () => c.sets[0].body)
  assert.equal(c.sets.length, 1)
  assert.equal((await h.auth.usage(async () => auth)).user, 'work key')
  dump('loader', { baseURL: got.baseURL, fetch: typeof got.fetch, accountId: c.sets[0].body.accountId, provider: h.auth.provider })
})

test('subscription: three windows, reset times, plan and expiry, no wallet', async () => {
  const { usage: u, upstream: r } = await read('subscription')
  assert.equal(u.error, undefined)
  assert.equal(u.user, `${host} …${state.keys.subscription.slice(-4)}`)
  assert.equal(u.plan, state.groups.subscription)
  assert.equal(u.until, r.subscription.expires_at)
  assert.equal(u.balance, undefined)
  assert.deepEqual(u.windows.map(w => [w.name, w.span]), [['24 hours', DAY], ['7 days', 7 * DAY], ['30 days', 30 * DAY]])
  const source = state.fork ? r.subscription.windows : [
    { used_usd: r.subscription.daily_usage_usd, limit_usd: r.subscription.daily_limit_usd, reset_at: r.subscription.daily_reset_at },
    { used_usd: r.subscription.weekly_usage_usd, limit_usd: r.subscription.weekly_limit_usd, reset_at: r.subscription.weekly_reset_at ?? new Date(Date.parse(r.subscription.weekly_window_start) + 7 * DAY * 1000).toISOString() },
    { used_usd: r.subscription.monthly_usage_usd, limit_usd: r.subscription.monthly_limit_usd, reset_at: r.subscription.monthly_reset_at },
  ]
  for (let i = 0; i < 3; i++) {
    const w = u.windows[i], s = source[i]
    assert.ok(w.used > 0)
    assert.equal(w.used, 100 * s.used_usd / s.limit_usd)
    assert.equal(w.resetsAt, s.reset_at ?? undefined)
    if (state.fork) {
      assert.equal(w.amount, s.used_usd); assert.equal(w.limit, s.limit_usd); assert.equal(w.unit, 'USD')
      assert.ok(Date.parse(w.resetsAt) > Date.now(), 'real reset time')
    }
  }
})

test('balance: wallet reading for new endpoint, unchanged legacy fallback', async () => {
  const { usage: u, upstream: r } = await read('balance')
  assert.equal(u.error, undefined)
  const amount = state.fork ? r.balance.amount_usd : r.balance
  assert.equal(u.balance, '$' + amount.toFixed(2))
  assert.ok(amount < state.limits.topup)
  if (state.fork) {
    assert.equal(u.plan, '按量付费')
    assert.deepEqual(u.windows, [{ name: '余额', balance: amount, unit: 'USD' }])
  } else { assert.equal(u.windows, undefined); assert.equal(u.plan, r.planName) }
})

test('key quota and rate limits coexist with subscription on key-status', async () => {
  const { usage: u, upstream: r } = await read('quota')
  assert.equal(u.error, undefined)
  const key = state.fork ? r.key : r
  assert.deepEqual(u.windows.slice(0, 4).map(w => [w.name, w.span]), [[state.fork ? 'Key 总额度' : 'Key quota', undefined], ['5 hours', 18000], ['24 hours', DAY], ['7 days', 7 * DAY]])
  assert.equal(u.windows[0].used, 100 * key.quota.used / key.quota.limit)
  for (let i = 0; i < 3; i++) {
    assert.ok(u.windows[i + 1].used > 0)
    assert.equal(u.windows[i + 1].resetsAt, key.rate_limits[i].reset_at)
  }
  if (state.fork) {
    assert.equal(u.windows.length, 7)
    assert.equal(u.plan, state.groups.subscription)
    assert.deepEqual(u.windows.slice(4).map(w => w.name), ['24 hours', '7 days', '30 days'])
  } else assert.equal(u.plan, 'API key limits')
})

test('401 usage and models mark sign-in expired', async () => {
  const auth = { type: 'api', key: 'sk-not-a-key-0000' }
  const u = await hooks.auth.usage(async () => auth)
  assert.equal(u.signIn, 'expired'); assert.match(u.error, /^401 /); assert.deepEqual(u.windows, [])
  await assert.rejects(hooks.provider.models({ models: {} }, { auth }), e => e.signIn === 'expired')
  dump('invalid-key', u)
})

test('models: real key list, endpoint SDK, manifest reasoning and token cost', async () => {
  const models = await hooks.provider.models({ models: {} }, { auth: authOf('subscription') })
  const r = await raw('subscription')
  const manifest = await (await fetch(state.base + '/backend-api/codex/models', { headers: { authorization: `Bearer ${state.keys.subscription}` } })).json()
  assert.ok(Object.keys(models).length > 0)
  if (state.fork) assert.deepEqual(Object.keys(models), r.models.map(m => m.id))
  const prices = state.fork ? new Map(r.models.map(m => [m.id, m.pricing])) : new Map()
  for (const [id, m] of Object.entries(models)) {
    assert.equal(m.providerID, 'jmds'); assert.equal(m.api.url, state.base + '/v1')
    if (id.startsWith('claude-')) assert.equal(m.api.npm, '@ai-sdk/anthropic')
    const told = manifest.models?.find(x => x.slug === id)?.supported_reasoning_levels?.map(x => x.effort ?? x)
    if (told?.some(x => x !== 'none')) assert.deepEqual(Object.keys(m.variants), told)
    if (m.capabilities.reasoning) assert.ok(Object.keys(m.variants).length > 0)
    if (state.fork) {
      const p = prices.get(id)
      if (p) assert.deepEqual(m.cost, { input: p.input, output: p.output, cache: { read: p.cache_read, write: p.cache_write } })
      else assert.equal(m.cost, undefined)
    }
  }
  dump('models', { models, manifest })
})

// Real HTTP observations with controlled catalogue/manifest failures preserve the fallback behavior.
async function withReplies(rewrites, fn) {
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const change = rewrites[new URL(String(url)).pathname]
    if (change === undefined) return previous(url, init)
    if (typeof change === 'number') return new Response('unavailable', { status: change })
    const r = await previous(url, init)
    return new Response(JSON.stringify(change(await r.json())), { status: r.status })
  }
  try { return await fn() } finally { globalThis.fetch = previous }
}
let loads = 0
async function fresh(restart = false) {
  if (!restart) rmSync(cache, { recursive: true, force: true })
  const mod = await import(`../index.mjs?test=${++loads}`)
  return mod.JmdsPlugin({}, { baseURL: state.base })
}
const others = body => state.fork ? { ...body, models: [...body.models, { id: 'deepseek-flash', pricing: null }, { id: 'glm-4.6', pricing: null }] } : { ...body, data: [...body.data, { id: 'deepseek-flash' }, { id: 'glm-4.6' }] }
const modelPath = state.fork ? endpoint : '/v1/models'

test('models.dev official reasoning, interleaving, limits, single-flight and disk cache', async () => {
  const h = await fresh(), was = asked
  const list = () => h.provider.models({ models: {} }, { auth: authOf('subscription') })
  const [a, b] = await withReplies({ [modelPath]: others }, () => Promise.all([list(), list()]))
  assert.equal(asked - was, 1)
  assert.deepEqual(b, a)
  const ds = a['deepseek-flash']
  assert.equal(ds.capabilities.reasoning, true)
  assert.deepEqual(Object.keys(ds.variants), ['low', 'high', 'max'])
  assert.deepEqual(ds.capabilities.interleaved, { field: 'reasoning_content' })
  assert.deepEqual(ds.limit, { context: 1000000, output: 393216 })
  assert.equal(a['glm-4.6'].capabilities.reasoning, false)
  const restart = await fresh(true)
  const again = await withReplies({ [modelPath]: others }, () => restart.provider.models({ models: {} }, { auth: authOf('subscription') }))
  assert.equal(asked - was, 1); assert.deepEqual(again, a)
  dump('models-dev', a)
})

test('models.dev unavailable, invalid or slow never prevents a model list; retained variants survive', async () => {
  const auth = authOf('subscription')
  for (const c of ['down', [], 'invalid', 'hang']) {
    catalogue = c
    try {
      const h = await fresh()
      const start = Date.now()
      const models = await withReplies({ '/backend-api/codex/models': 500 }, () => h.provider.models({ models: { [state.model]: { variants: { custom: {} } } } }, { auth }))
      assert.ok(Object.keys(models).length > 0)
      assert.deepEqual(models[state.model].variants, { custom: {} })
      assert.ok(Date.now() - start < 10_000)
    } finally { catalogue = fixture }
  }
})

function dc(args, input) {
  return execFileSync('docker', ['compose', '-p', process.env.TEST_COMPOSE_PROJECT, '-f', join(here, 'compose.yml'), ...args], { input, encoding: 'utf8' })
}
async function sql(statement) {
  dc(['exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'sub2api', '-d', 'sub2api'], statement)
  dc(['exec', '-T', 'redis', 'redis-cli', 'FLUSHDB'])
  await new Promise(resolve => setTimeout(resolve, 1500))
}
const subWhere = `user_id=${state.userId} AND group_id=${state.subGroupId}`
const requestBody = JSON.stringify({ model: state.model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
async function refused(mode, expected, suffix) {
  const auth = authOf(mode)
  const usage = await hooks.auth.usage(async () => auth)
  const options = { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': auth.key, 'anthropic-version': '2023-06-01' }, body: requestBody }
  const original = await fetch(state.base + '/v1/messages', options)
  const loader = await hooks.auth.loader(async () => auth)
  const rewritten = await loader.fetch(state.base + '/v1/messages', options)
  const originalBody = await original.json(), body = await rewritten.json()
  dump(suffix, { usage, original: { status: original.status, body: originalBody }, rewritten: { status: rewritten.status, headers: Object.fromEntries(rewritten.headers), body } })
  assert.equal(rewritten.status, expected)
  return { original, originalBody, rewritten, body }
}

test('fork extra pool: display-only, routing pool when full, full pool depleted, and real quota errors', { skip: !state.fork }, async () => {
  try {
    await sql(`UPDATE user_subscriptions SET extra_usage=8, extra_usage_granted_total=10 WHERE ${subWhere};`)
    let { usage: u } = await read('subscription', hooks, 'extra-not-full')
    assert.equal(u.windows.at(-1).aside, true); assert.equal(u.windows.at(-1).name, '额外用量')
    assert.equal(u.windows.at(-1).amount, 2); assert.equal(u.windows.at(-1).limit, 10)
    assert.ok(u.windows.slice(0, 3).every(w => w.aside === undefined))
    await sql(`UPDATE user_subscriptions SET daily_usage_usd=5 WHERE ${subWhere};`)
    ;({ usage: u } = await read('subscription', hooks, 'extra-full'))
    assert.equal(u.windows[0].aside, true)
    assert.equal(u.windows[1].aside, undefined)
    assert.equal(u.windows.at(-1).aside, undefined)
    assert.equal(u.windows.at(-1).used, 20)
    await sql(`UPDATE user_subscriptions SET extra_usage=0 WHERE ${subWhere};`)
    ;({ usage: u } = await read('subscription', hooks, 'extra-depleted'))
    assert.equal(u.windows[0].aside, undefined); assert.equal(u.windows.at(-1).aside, true)
    const got = await refused('subscription', 429, 'quota-error')
    assert.match(JSON.stringify(got.originalBody), /USAGE_LIMIT_EXCEEDED|billing_error/)
    assert.equal(got.body.error.resets_at, Math.floor(Date.parse(u.windows[0].resetsAt) / 1000))
    assert.match(JSON.stringify(got.body), /usage.?limit/i)
    assert.doesNotMatch(JSON.stringify(got.body), /billing_error/i)
  } finally { await sql(`UPDATE user_subscriptions SET daily_usage_usd=1, extra_usage=0, extra_usage_granted_total=0 WHERE ${subWhere};`) }
})

test('fork: real expired key, missing/expired subscription and empty balance errors', { skip: !state.fork }, async () => {
  try {
    await sql(`UPDATE api_keys SET expires_at=NOW()-interval '1 day' WHERE key='${state.keys.quota}';`)
    let got = await refused('quota', 403, 'expired-key')
    assert.match(JSON.stringify(got.originalBody), /API_KEY_EXPIRED/)
    assert.equal(got.rewritten.headers.get('x-magpie-sign-in'), 'expired')
    await sql(`UPDATE api_keys SET expires_at=NOW()+interval '1 day' WHERE key='${state.keys.quota}'; UPDATE user_subscriptions SET status='expired', expires_at=NOW()-interval '1 day', current_term_expires_at=NOW()-interval '1 day' WHERE ${subWhere};`)
    let u = (await read('subscription', hooks, 'expired-subscription')).usage
    assert.equal(u.error, '订阅已过期')
    got = await refused('subscription', 402, 'expired-subscription-error')
    assert.match(JSON.stringify(got.originalBody), /SUBSCRIPTION_INVALID|SUBSCRIPTION_NOT_FOUND/)
    assert.doesNotMatch(JSON.stringify(got.body), /quota|usage.?limit|套餐/i)
    await sql(`UPDATE user_subscriptions SET deleted_at=NOW() WHERE ${subWhere};`)
    u = (await read('subscription', hooks, 'missing-subscription')).usage
    assert.equal(u.error, '无订阅')
    got = await refused('subscription', 402, 'missing-subscription-error')
    assert.match(JSON.stringify(got.originalBody), /SUBSCRIPTION_NOT_FOUND/)
    await sql(`UPDATE users SET balance=0 WHERE id=${state.userId};`)
    got = await refused('balance', 403, 'empty-balance')
    assert.match(JSON.stringify(got.originalBody), /balance/i)
    assert.deepEqual(got.body, got.originalBody)
  } finally {
    await sql(`UPDATE user_subscriptions SET deleted_at=NULL, status='active', expires_at=NOW()+interval '30 days', current_term_expires_at=NOW()+interval '30 days' WHERE ${subWhere}; UPDATE users SET balance=10 WHERE id=${state.userId};`)
  }
})

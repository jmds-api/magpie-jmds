// Bootstraps a fresh upstream sub2api (the one compose.yml starts) through
// its admin API, as a site operator would, and prints what the test needs
// as JSON on stdout:
//   - a subscription group (daily/weekly/monthly limits), a user subscribed
//     to it, and a key on it                             → keys.subscription
//   - a standard (balance) group, the user's wallet topped up, a key on it
//                                                        → keys.balance
//   - a key on the standard group with its own quota and 5h/1d/7d rate
//     limits ("quota_limited" in /v1/usage)              → keys.quota
// then sends one request on each key through the fake Anthropic upstream,
// and waits until /v1/usage shows it, so every window the test reads is
// past zero.
//   node test/setup.mjs http://127.0.0.1:PORT > state.json

const base = (process.argv[2] ?? process.env.SUB2API_URL ?? "").replace(/\/+$/, "")
if (!base) throw new Error("usage: node test/setup.mjs <sub2api base URL>")

const ADMIN = { email: "admin@example.com", password: "AdminPass123!" }
const USER = { email: "u1@example.com", password: "UserPass123", username: "u1" }
const MODEL = "claude-sonnet-4-5-20250929"
const log = (...a) => console.error("[setup]", ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function call(method, path, { token, apiKey, body } = {}) {
  const headers = { "content-type": "application/json", accept: "application/json" }
  if (token) headers.authorization = `Bearer ${token}`
  if (apiKey) Object.assign(headers, { "x-api-key": apiKey, "anthropic-version": "2023-06-01" })
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {}
  if (!res.ok || (json && typeof json.code === "number" && json.code !== 0)) {
    throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 400)}`)
  }
  return json
}

// /api/v1 wraps its answers in {code, message, data}
const data = (j) => j?.data ?? j

async function until(what, fn, { tries = 60, every = 1000 } = {}) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    await sleep(every)
  }
  throw new Error(`timed out waiting for ${what}${last ? ": " + last.message : ""}`)
}

await until("sub2api /health", async () => (await fetch(base + "/health")).ok, { tries: 120 })
const adminToken = await until("the admin's sign-in (AUTO_SETUP)", async () =>
  data(await call("POST", "/api/v1/auth/login", { body: ADMIN }))?.access_token,
)

// sub2api refuses the admin API until the operator accepts its deployment
// compliance commitment. This is done here ONLY because this is a
// throwaway instance that lives for one CI test run; a real deployment's
// operator must read and accept it themselves.
await call("POST", "/api/v1/admin/compliance/accept", {
  token: adminToken,
  body: {
    phrase: "I have read, understood, and agree to the Sub2API Deployment and Operation Compliance Commitment",
    language: "en",
  },
})

// The operator JWT is supported by both versions; recent upstream no longer
// creates legacy admin API keys. This is test provisioning, not plugin auth.
const admin = (method, path, body) => call(method, path, { token: adminToken, body }).then(data)

const PRICING = [{ platform: 'anthropic', models: [MODEL], billing_mode: 'token', input_price: 0.000003, output_price: 0.000015, cache_read_price: 0.0000003, cache_write_price: 0.00000375 }]
const LIMITS = { daily_limit_usd: 5, weekly_limit_usd: 20, monthly_limit_usd: 50 }
const subGroup = await admin("POST", "/api/v1/admin/groups", {
  name: "Test Subscription",
  platform: "anthropic",
  subscription_type: "subscription",
  daily_quota_coefficient: 0.25,
  weekly_quota_coefficient: 0.4,
  rate_multiplier: 1,
  default_validity_days: 30,
  model_pricing: PRICING,
  ...LIMITS,
})
const stdGroup = await admin("POST", "/api/v1/admin/groups", {
  name: "Test Balance",
  platform: "anthropic",
  subscription_type: "standard",
  rate_multiplier: 1,
  default_validity_days: 30,
  model_pricing: PRICING,
})
const ccGroup = await admin("POST", "/api/v1/admin/groups", {
  name: "Test Claude Code", platform: "anthropic", subscription_type: "standard",
  rate_multiplier: 1, default_validity_days: 30, model_pricing: PRICING, claude_code_only: true,
})
if (ccGroup.claude_code_only !== true) throw new Error('Claude Code group restriction not enabled')
log("groups", subGroup.id, stdGroup.id, ccGroup.id)

const account = await admin("POST", "/api/v1/admin/accounts", {
  name: "fake-anthropic",
  platform: "anthropic",
  type: "apikey",
  credentials: { api_key: "sk-ant-fake", base_url: "http://fakeup:8000" },
  concurrency: 10,
  priority: 1,
  group_ids: [subGroup.id, stdGroup.id],
})
log("account", account.id)

const user = await admin("POST", "/api/v1/admin/users", { ...USER, balance: 0, concurrency: 5 })
const TOPUP = 10
await admin("POST", `/api/v1/admin/users/${user.id}/balance`, { balance: TOPUP, operation: "add", notes: "e2e" })
await admin("POST", "/api/v1/admin/subscriptions/assign", { user_id: user.id, group_id: subGroup.id, validity_days: 30 })
log("user", user.id)

// keys are made by the user, with the user's own sign-in
const userToken = data(await call("POST", "/api/v1/auth/login", { body: USER }))?.access_token
const mkKey = async (body) => data(await call("POST", "/api/v1/keys", { token: userToken, body }))?.key
const QUOTA = { quota: 10, rate_limit_5h: 5, rate_limit_1d: 8, rate_limit_7d: 20 }
const subscriptionKey = await mkKey({ name: 'e2e-subscription', group_id: subGroup.id })
const probe = await fetch(base + '/v1/sub2api/key-status', { headers: { authorization: `Bearer ${subscriptionKey}` } })
if (probe.status !== 200 && probe.status !== 404) throw new Error(`key-status detection: ${probe.status} ${await probe.text()}`)
const fork = probe.status === 200
const expected = !process.env.SUB2API_IMAGE?.startsWith('weishaw/sub2api:')
if (fork !== expected) throw new Error(`key-status contract: expected ${expected ? '200' : '404'}, got ${probe.status}`)
log('key-status supported', fork)
const keys = {
  subscription: subscriptionKey,
  balance: await mkKey({ name: 'e2e-balance', group_id: stdGroup.id }),
  quota: await mkKey({ name: 'e2e-quota', group_id: fork ? subGroup.id : stdGroup.id, ...QUOTA, expires_in_days: 30 }),
}
for (const [k, v] of Object.entries(keys)) if (!v) throw new Error(`no ${k} key`)

for (const [mode, key] of Object.entries(keys)) {
  const r = await call("POST", "/v1/messages", {
    apiKey: key,
    body: { model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
  })
  log("request", mode, r?.usage ? JSON.stringify(r.usage) : "")
}

// what shows a request was counted, per mode
const counted = {
  subscription: (u) => u?.subscription?.daily_usage_usd > 0,
  balance: (u) => typeof u?.balance === "number" && u.balance < TOPUP,
  quota: (u) => u?.mode === "quota_limited" && u.quota?.used > 0 && (u.rate_limits ?? []).every((r) => r.used > 0),
}
const waited = {}
for (const [mode, key] of Object.entries(keys)) {
  const t0 = Date.now()
  await until(`/v1/usage to count the ${mode} key's request`, async () => {
    const res = await fetch(base + "/v1/usage", { headers: { authorization: `Bearer ${key}` } })
    return res.ok && counted[mode](await res.json())
  }, { tries: 90 })
  waited[mode] = Date.now() - t0
}
log("usage counted after (ms)", JSON.stringify(waited))
// Keep this restricted group without upstream accounts: passing client validation
// reaches a scheduling error, while other clients must still get the CC-only 403.
keys.claudeCode = await mkKey({ name: 'e2e-claude-code', group_id: ccGroup.id })
if (!keys.claudeCode) throw new Error('no Claude Code key')

process.stdout.write(
  JSON.stringify({ base, keys, fork, userId: user.id, subGroupId: subGroup.id, model: MODEL, limits: { subscription: LIMITS, quota: QUOTA, topup: TOPUP }, groups: { subscription: subGroup.name, balance: stdGroup.name }, waited }, null, 2) + "\n",
)

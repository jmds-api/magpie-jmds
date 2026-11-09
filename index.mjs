// jmds facts for magpie. Only plugin functions may be exported.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const ID = "jmds"
const DEFAULT_BASE = "https://api.jmds.dev"
const CHAT = "@ai-sdk/openai-compatible"
const MESSAGES = "@ai-sdk/anthropic"
const RESPONSES = "@ai-sdk/openai"
const TIMEOUT = 15_000

const HOUR = 3600
const DAY = 24 * HOUR
const SPANS = { "5h": ["5 hours", 5 * HOUR], "1d": ["24 hours", DAY], "7d": ["7 days", 7 * DAY] }

// ---- the site -----------------------------------------------------------------

// root is the site's address as typed, without the /v1 an OpenAI client's
// base URL would have, nor a trailing slash.
function root(url) {
  return String(url ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

function checkURL(value) {
  try {
    const u = new URL(root(value))
    if (u.protocol !== "https:" && u.protocol !== "http:") return "The address starts with https://"
  } catch {
    return "An address such as https://api.example.com"
  }
}

function hostOf(base) {
  try {
    return new URL(base).host
  } catch {
    return base
  }
}

// label is how magpie names the account: the name given at sign-in, else
// the host and the end of the key, so multiple keys tell apart.
// magpie keys an account's own settings (its
// models, its share) by this name, so it stays as it was given.
function label(auth, base) {
  const given = typeof auth?.metadata?.name === "string" ? auth.metadata.name.trim().slice(0, 60) : ""
  if (given) return given
  const key = typeof auth?.key === "string" ? auth.key : ""
  const tail = key.length >= 8 ? " …" + key.slice(-4) : ""
  return base ? hostOf(base) + tail : ""
}

// named saves the label on the account, where magpie reads an account's
// name (accountId, else metadata.email). magpie's API-key sign-in keeps
// only {type, key, metadata} and hands a method's authorize no key, so the
// name is written the first time the account is used, in its own scope
// (client.auth.set replaces the account's sign-in, so it is kept whole).
async function named(client, id, auth, base) {
  const name = label(auth, base)
  if (!name || auth.accountId === name || typeof client?.auth?.set !== "function") return
  try {
    await client.auth.set({ path: { id }, body: { ...auth, accountId: name } })
  } catch {}
}

async function get(base, path, key) {
  const res = await fetch(base + path, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {}
  if (!res.ok) {
    // the gateway's own errors, {error:{message}}, and its middleware's, {code, message}
    const why = body?.error?.message ?? body?.message ?? body?.code ?? (text.trim().slice(0, 200) || res.statusText)
    const err = new Error(`${res.status} ${why}`)
    err.status = res.status
    if (res.status === 401) err.signIn = "expired"
    throw err
  }
  if (body === undefined) throw new Error(`${path}: not JSON`)
  return body
}

// ---- models -------------------------------------------------------------------

// npmOf is the AI SDK package, and so the endpoint, a model is spoken to
// on: Claude on /v1/messages, OpenAI's on /v1/responses, the rest (Gemini,
// Grok, a composite group's others) on /v1/chat/completions.
function npmOf(id) {
  const s = id.toLowerCase()
  if (/^claude-/.test(s) || s.startsWith("anthropic/")) return MESSAGES
  if (/^(gpt-|o\d|codex-|chatgpt-)/.test(s)) return RESPONSES
  return CHAT
}

// LEVELS are a thinking model's reasoning levels when nothing tells them.
const LEVELS = ["low", "medium", "high"]

const variantsOf = (levels) => Object.fromEntries(levels.map((l) => [l, {}]))

// runtimeModel is magpie's model. Whether it thinks, and its variants (its
// reasoning levels: magpie offers a thinking model's variants' keys as its
// efforts), are the first to tell of: the levels the site tells (told),
// the model's official models.dev entry (known), the variants magpie
// already has for the model (was: models.dev's, the config's), the
// endpoint and the name. A thinking model nothing gives levels for gets
// LEVELS. Whether it wants its thinking passed back (interleaved) and its
// limits are known's alone.
function runtimeModel(m, url, providerID, told, was, known) {
  const npm = npmOf(m.id)
  const kept = was?.variants && typeof was.variants === "object" && Object.keys(was.variants).length ? was.variants : undefined
  const reasoning = told?.length ? true : known ? known.reasoning : !!kept || npm !== CHAT || /think|reason/i.test(m.id)
  const levels = told?.length ? told : known?.levels.length ? known.levels : undefined
  return {
    id: m.id,
    providerID,
    name: m.name,
    api: { id: m.id, url, npm },
    status: "active",
    headers: {},
    options: {},
    limit: known ? { ...known.limit } : { context: 0, output: 0 },
    capabilities: {
      temperature: true,
      reasoning,
      attachment: npm !== CHAT,
      toolcall: true,
      input: { text: true, image: npm !== CHAT, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: typeof known?.interleaved === "object" ? { ...known.interleaved } : (known?.interleaved ?? false),
    },
    release_date: "",
    variants: !reasoning ? {} : levels ? variantsOf(levels) : known ? variantsOf(LEVELS) : (kept ?? variantsOf(LEVELS)),
  }
}

// MODELS_DEV is models.dev's catalogue: {provider id: {models: {model id:
// {reasoning, reasoning_options, interleaved, canonical_model_id, limit,
// …}}}}, some 6 MB. It is asked once a day (KNOWN_FOR), every caller
// waiting on the one request, and what it tells is kept on disk (keptFile),
// not in memory, so a magpie that restarts (as it does when the plugin's
// options change) doesn't ask again; a failed ask is tried again after
// KNOWN_RETRY, the last good entries standing meanwhile. It is only a help,
// asked next to the site and given up sooner than the site (KNOWN_TIMEOUT <
// TIMEOUT), so it never fails or holds up the list.
const MODELS_DEV = "https://models.dev/api.json"
const KNOWN_TIMEOUT = 5_000
const KNOWN_FOR = DAY * 1000
const KNOWN_RETRY = 10 * 60 * 1000

let asking

// keptFile is where models.dev's official entries are kept: the user's
// cache directory ($XDG_CACHE_HOME, else the platform's own).
function keptFile() {
  const home = homedir()
  const dir = process.env.XDG_CACHE_HOME || (process.platform === "darwin" ? join(home, "Library", "Caches") : join(home, ".cache"))
  return join(dir, "magpie-jmds", "models-dev.json")
}

// kept is what keptFile has: {at, ok, models: {model id: knownOf(…)}};
// nothing yet, or a file that can't be read, is an ask long ago.
async function kept() {
  try {
    const k = JSON.parse(await readFile(keptFile(), "utf8"))
    if (Number.isFinite(k?.at) && k.models && typeof k.models === "object") return { at: k.at, ok: k.ok === true, models: k.models }
  } catch {}
  return { at: 0, ok: false, models: {} }
}

// keep writes k to keptFile whole (another magpie may be reading it); a
// cache that can't be written is only asked again.
async function keep(k) {
  const file = keptFile()
  try {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(k))
    await rename(tmp, file)
  } catch {}
}

// knownOf is what models.dev's entry m tells of a model: whether it thinks;
// its levels, the values of its reasoning_options of type "effort" (one
// that thinks by a toggle or a budget_tokens alone tells none); its
// interleaved ({field: "reasoning_content"}: its thinking goes back in that
// field), and its limits.
function knownOf(m) {
  const levels = []
  for (const o of Array.isArray(m.reasoning_options) ? m.reasoning_options : []) {
    if (o?.type !== "effort" || !Array.isArray(o.values)) continue
    for (const v of o.values) if (typeof v === "string" && v.trim() && !levels.includes(v.trim())) levels.push(v.trim())
  }
  const il = m.interleaved
  const size = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)
  return {
    reasoning: m.reasoning === true,
    levels,
    interleaved: il === true ? true : typeof il?.field === "string" && il.field ? { field: il.field } : false,
    limit: { context: size(m.limit?.context), output: size(m.limit?.output) },
  }
}

// officialOf is the catalogue's official entries, by model id: a model is
// known only by the entry under the provider its canonical_model_id is of
// (deepseek's deepseek-flash, canonical "deepseek/…"). A reseller's entry
// for the same id is no word on it, and a model with none is not known.
function officialOf(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("models.dev: not a catalogue")
  const out = {}
  for (const [pid, p] of Object.entries(body)) {
    const models = p?.models && typeof p.models === "object" ? p.models : {}
    for (const [id, m] of Object.entries(models)) {
      if (Object.hasOwn(out, id) || typeof m?.canonical_model_id !== "string") continue
      if (m.canonical_model_id.split("/")[0] === pid) out[id] = knownOf(m)
    }
  }
  return out
}

// knownModels is the official entries models.dev has, by model id; none
// when it can't be asked.
async function knownModels() {
  const k = await kept()
  if (Date.now() - k.at < (k.ok ? KNOWN_FOR : KNOWN_RETRY)) return new Map(Object.entries(k.models))
  asking ??= (async () => {
    let next
    try {
      const res = await fetch(MODELS_DEV, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(KNOWN_TIMEOUT) })
      if (!res.ok) throw new Error(`models.dev: ${res.status}`)
      next = { at: Date.now(), ok: true, models: officialOf(await res.json()) }
    } catch {
      next = { ...k, at: Date.now(), ok: false }
    }
    await keep(next)
    return new Map(Object.entries(next.models))
  })().finally(() => {
    asking = undefined
  })
  return asking
}

// efforts are each model's reasoning levels, by id, as the site's Codex
// models manifest tells them ({models: [{slug, supported_reasoning_levels:
// [{effort}, …] or ["low", …]}]}); the plain /v1/models never tells them.
// The manifest is asked without a client_version, so the site asks its
// upstream as the Codex version it keeps. Only a help: a site that can't
// tell is no levels. sub2api lists a model it knows nothing of as ["none"]
// alone, which tells no levels either; "none" next to others is one.
async function efforts(base, key) {
  let body
  try {
    body = await get(base, "/backend-api/codex/models", key)
  } catch {
    return {}
  }
  const out = {}
  for (const m of Array.isArray(body?.models) ? body.models : []) {
    if (typeof m?.slug !== "string" || !Array.isArray(m.supported_reasoning_levels)) continue
    const levels = []
    for (const l of m.supported_reasoning_levels) {
      const e = typeof l === "string" ? l : l?.effort
      if (typeof e === "string" && e.trim() && !levels.includes(e.trim())) levels.push(e.trim())
    }
    if (levels.some((l) => l !== "none")) out[m.slug] = levels
  }
  return out
}

// Model IDs/prices come from key-status; only a 404 uses /v1/models.
// was is the models magpie already has. The site's manifest and models.dev
// are asked at the same time, preserving their reasoning/capability hints.
async function models(id, base, auth, was, facts) {
  const [status, told, official] = await Promise.all([facts.read(auth), efforts(base, auth.key), knownModels()])
  const body = status ? { data: status.models } : await get(base, "/v1/models", auth.key)
  // magpie lists accounts concurrently. Let their outstanding observations
  // settle before selecting one account's whole price; never splice prices.
  await facts.settle()
  const out = {}
  for (const m of body?.data ?? []) {
    if (typeof m?.id !== "string" || !m.id) continue
    const name = typeof m.display_name === "string" && m.display_name ? m.display_name : m.id
    out[m.id] = runtimeModel({ id: m.id, name }, base + "/v1", id, told[m.id], was?.[m.id], official.get(m.id))
    const cost = status && facts.price(m.id)
    if (cost) out[m.id].cost = cost
  }
  if (!Object.keys(out).length) throw new Error("/v1/models: an empty list")
  return out
}

// ---- usage --------------------------------------------------------------------

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const money = (v) => "$" + (Math.round(v * 100) / 100).toFixed(2)
const pct = (used, limit) => (limit > 0 ? (100 * used) / limit : used > 0 ? 100 : 0)
const after = (iso, secs) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? new Date(t + secs * 1000).toISOString() : undefined
}

function win(name, used, limit, extra = {}) {
  return { name, used: pct(used, limit), display: money(used) + " / " + money(limit), ...extra }
}

// fromUsage is magpie's usage from /v1/usage's reply, one of three:
//   - "quota_limited": the key has its own quota or rate limits; sub2api
//     then tells those and hides the subscription and the wallet;
//   - a subscription group: its day, week and month, each a window when
//     the group limits it;
//   - a balance group: the wallet, shown but not a window, since a balance
//     has no span to route by.
function fromUsage(u) {
  if (u?.mode === "quota_limited") {
    const out = { plan: "API key limits", windows: [] }
    const q = u.quota
    if (q && num(q.limit) > 0) out.windows.push(win("Key quota", num(q.used) ?? 0, q.limit))
    for (const r of Array.isArray(u.rate_limits) ? u.rate_limits : []) {
      const limit = num(r?.limit)
      if (!(limit > 0)) continue
      const [name, span] = SPANS[r.window] ?? [String(r.window ?? "Window"), undefined]
      out.windows.push(win(name, num(r.used) ?? 0, limit, { ...(r.reset_at ? { resetsAt: r.reset_at } : {}), ...(span ? { span } : {}) }))
    }
    if (u.expires_at) out.until = u.expires_at
    if (u.status === "quota_exhausted") out.error = "The key's quota is used up"
    else if (u.status === "expired") out.error = "The key has expired"
    return out
  }

  const plan = typeof u?.planName === "string" && u.planName ? u.planName : undefined
  const s = u?.subscription
  if (s && typeof s === "object") {
    const out = { plan, windows: [] }
    // A window's reset time is the one sub2api tells (daily_reset_at /
    // weekly_reset_at / monthly_reset_at, RFC 3339; being added upstream,
    // absent on 0.2.14). It isn't worked out from the window starts: the
    // day resets at the next midnight in the server's time zone, and the
    // day's and the month's windows roll over only when next used, so a
    // start + 24 hours or + 30 days would be a wrong guess. Without a told
    // reset time the day and the month have a span but no reset time. The
    // week is a rolling 7 days from its start upstream, so its start
    // + 7 days stands in until weekly_reset_at is told.
    const told = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : undefined)
    const rows = [
      ["24 hours", s.daily_usage_usd, s.daily_limit_usd, DAY, told(s.daily_reset_at)],
      ["7 days", s.weekly_usage_usd, s.weekly_limit_usd, 7 * DAY, told(s.weekly_reset_at) ?? after(s.weekly_window_start, 7 * DAY)],
      ["30 days", s.monthly_usage_usd, s.monthly_limit_usd, 30 * DAY, told(s.monthly_reset_at)],
    ]
    for (const [name, used, limit, span, resetsAt] of rows) {
      if (!(num(limit) > 0)) continue // null or 0: no limit on this window
      out.windows.push(win(name, num(used) ?? 0, limit, { span, ...(resetsAt ? { resetsAt } : {}) }))
    }
    if (s.expires_at) {
      out.until = s.expires_at
      if (Date.parse(s.expires_at) <= Date.now()) out.error = "The subscription has expired"
    }
    if (!out.windows.length) out.balance = "Unlimited"
    return out
  }
  if (num(u?.balance) !== undefined) return { plan, balance: money(u.balance) }
  // a subscription group the user has no subscription to (or one gone):
  // the gateway lets the request through to fail, and tells no usage
  return { plan, error: "No active subscription for this key's group", windows: [] }
}

// ---- key-status facts --------------------------------------------------------

const SUB_SPANS = { daily: ["24 hours", DAY], weekly: ["7 days", 7 * DAY], monthly: ["30 days", 30 * DAY] }
const usdWin = (name, amount, limit, extra = {}) => ({ ...win(name, amount, limit), amount, limit, unit: "USD", ...extra })

function fromStatus(s) {
  const out = { windows: [] }
  const key = s.key
  if (num(key?.quota?.limit) > 0) out.windows.push(usdWin("Key 总额度", key.quota.used, key.quota.limit))
  for (const r of key?.rate_limits ?? []) {
    const pair = SPANS[r.window]
    if (!pair || !(num(r.limit) > 0)) continue
    out.windows.push(usdWin(pair[0], r.used, r.limit, { span: pair[1], ...(r.reset_at ? { resetsAt: r.reset_at } : {}) }))
  }
  if (s.group?.billing_mode === "subscription") {
    const sub = s.subscription
    out.plan = sub?.plan_name
    if (sub?.expires_at) out.until = sub.expires_at
    if (sub?.status === "none") out.error = "无订阅"
    else if (sub?.status === "expired") out.error = "订阅已过期"
    const rows = (sub?.windows ?? []).filter(w => SUB_SPANS[w.window] && num(w.limit_usd) > 0)
    const extra = sub?.extra_usage
    const spendingPool = num(extra?.remaining_usd) > 0 && rows.some(w => w.used_usd >= w.limit_usd)
    for (const w of rows) {
      const [name, span] = SUB_SPANS[w.window]
      out.windows.push(usdWin(name, w.used_usd, w.limit_usd, {
        span, ...(w.reset_at ? { resetsAt: w.reset_at } : {}),
        ...(spendingPool && w.used_usd >= w.limit_usd ? { aside: true } : {}),
      }))
    }
    if (spendingPool || num(extra?.granted_total_usd) > 0) {
      out.windows.push(usdWin("额外用量", extra.used_usd, extra.granted_total_usd, spendingPool ? {} : { aside: true }))
    }
  } else if (s.group?.billing_mode === "balance") {
    out.plan = "按量付费"
    if (num(s.balance?.amount_usd) !== undefined) {
      out.balance = money(s.balance.amount_usd)
      out.windows.push({ name: "余额", balance: s.balance.amount_usd, unit: "USD" })
    }
  }
  return out
}

// In-memory facts are private to this plugin instance/base URL, keyed by API
// key, not display name. Register before any IO so concurrent replies cannot
// reorder accounts. magpie invokes the hooks in its stored account order.
function observations(base) {
  const accounts = new Map()
  const pending = new Map()
  const readings = new Map()
  function touch(auth) {
    if (!accounts.has(auth.key)) accounts.set(auth.key, undefined)
  }
  async function read(auth) {
    touch(auth)
    if (pending.has(auth.key)) return pending.get(auth.key)
    const job = (async () => {
      try {
        const s = await get(base, "/v1/sub2api/key-status", auth.key)
        accounts.set(auth.key, s)
        return s
      } catch (e) {
        if (e.status === 404 || e.signIn) {
          accounts.set(auth.key, undefined)
          readings.delete(auth.key)
        }
        if (e.status === 404) return undefined
        throw e
      } finally {
        pending.delete(auth.key)
      }
    })()
    pending.set(auth.key, job)
    return job
  }
  function price(id) {
    let best
    for (const s of accounts.values()) {
      const mode = s?.group?.billing_mode
      const rate = num(s?.group?.rate_multiplier)
      const p = s?.models?.find(m => m.id === id)?.pricing
      if (!p || rate === undefined || (mode !== "balance" && mode !== "subscription")) continue
      if (!best || (mode === "balance" && best.mode !== "balance") || (mode === best.mode && rate < best.rate)) best = { mode, rate, p }
    }
    if (!best) return undefined
    const p = best.p
    return { input: p.input, output: p.output, cache: { read: p.cache_read, write: p.cache_write } }
  }
  return { touch, read, price, readings, async settle() { await Promise.allSettled([...pending.values()]) } }
}

// Only error responses are inspected. The original Response (and headers/body)
// is returned untouched unless a listed error can be stated more precisely.
// snapshot is the account's last key-status reading, or undefined before the
// first one: only the two quota rewrites need it (billing mode, reset time);
// the others are stated from the response alone.
async function rewrite(res, snapshot) {
  if (res.ok) return res
  let body
  try { body = await res.clone().json() } catch { return res }
  const codes = [body?.code, body?.error?.code, body?.error?.type, body?.type]
  const has = c => codes.includes(c)
  const message = body?.error?.message ?? body?.message ?? ""
  let status = res.status
  const headers = new Headers(res.headers)
  let next
  const at = value => {
    const t = Date.parse(value)
    return Number.isFinite(t) ? Math.floor(t / 1000) : undefined
  }
  const quota = reset => ({ error: { type: "usage_limit_reached", message: "Usage limit exceeded", ...(reset !== undefined ? { resets_at: reset } : {}) } })
  if (status === 403 && has("API_KEY_EXPIRED")) {
    headers.set("X-Magpie-Sign-In", "expired")
    return new Response(res.body, { status, statusText: res.statusText, headers })
  }
  if (status === 429 && has("USAGE_LIMIT_EXCEEDED")) {
    const window = ["daily", "weekly", "monthly"].find(w => new RegExp(`\\b${w}\\b`, "i").test(message))
    const reset = window && at(snapshot?.subscription?.windows?.find(w => w.window === window)?.reset_at)
    if (reset === undefined || !window) return res
    next = { ...body, error: { ...(typeof body.error === "object" ? body.error : {}), resets_at: reset } }
  } else if (status === 403 && has("billing_error") && snapshot?.group?.billing_mode === "subscription") {
    const resets = (snapshot.subscription?.windows ?? []).filter(w => w.used_usd >= w.limit_usd && w.limit_usd > 0).map(w => at(w.reset_at)).filter(t => t !== undefined)
    status = 429
    next = quota(resets.length ? Math.min(...resets) : undefined)
  } else if (status === 403 && (has("SUBSCRIPTION_INVALID") || has("SUBSCRIPTION_NOT_FOUND"))) {
    status = 402
    next = { error: { type: "payment_required", message: "Subscription unavailable" } }
  } else if (status === 429 && (has("session_rate_limited") || has("user_session_limit_exceeded"))) {
    next = { error: { type: "rate_limit_error", message: "Rate limit: too many requests" } }
    if (has("user_session_limit_exceeded")) headers.set("Retry-After", "60")
  } else return res
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.set("content-type", "application/json")
  return new Response(JSON.stringify(next), { status, headers })
}

export async function JmdsPlugin({ client } = {}, options = {}) {
  const base = root(options.baseURL ?? DEFAULT_BASE)
  const bad = checkURL(base)
  if (bad) throw new Error(`magpie-jmds: baseURL: ${bad}`)
  const facts = observations(base)
  return {
    auth: {
      provider: ID,
      methods: [{ type: "api", label: "jmds API key", placeholder: "sk-…", prompts: [{ type: "text", key: "name", message: "账号名（可留空）", placeholder: "" }] }],
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        facts.touch(auth)
        await named(client, ID, auth, base)
        return {
          baseURL: base + "/v1", apiKey: auth.key,
          fetch: async (input, init) => rewrite(await fetch(input, init), facts.readings.get(auth.key)),
        }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return { error: "not signed in" }
        await named(client, ID, auth, base)
        const user = label(auth, base)
        try {
          const s = await facts.read(auth)
          if (s) {
            facts.readings.set(auth.key, s)
            return { user, ...fromStatus(s) }
          }
          return { user, ...fromUsage(await get(base, "/v1/usage", auth.key)) }
        } catch (e) {
          return { user, error: String(e?.message ?? e), windows: [], ...(e?.signIn ? { signIn: e.signIn } : {}) }
        }
      },
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models
        try { return await models(ID, base, auth, provider.models, facts) }
        catch (e) { if (e?.signIn) throw e; return provider.models }
      },
    },
    config(cfg) {
      cfg.provider ??= {}
      cfg.provider[ID] = { ...cfg.provider[ID], name: cfg.provider[ID]?.name ?? "jmds" }
    },
  }
}

// Public loader.fetch boundary: a real HTTP receiver records bytes and headers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { JmdsPlugin } from '../index.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/claude-code.json', import.meta.url), 'utf8'))
const body = JSON.stringify(fixture.body)

test('Claude Code identity survives forwarding without changing request bytes', async t => {
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ headers: req.headers, body: Buffer.concat(chunks).toString() }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const hooks = await JmdsPlugin({}, { baseURL: base })
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'local-test' }))
  const headers = { 'user-agent': 'magpie/test', 'x-magpie-session': 'session-a', 'x-preserve': 'unchanged', 'content-type': 'application/json' }
  const send = async (data = body, extra = {}, path = '/v1/messages') => (await loader.fetch(base + path, { method: 'POST', headers, body: data, ...extra })).json()
  const marked = received => {
    assert.equal(received.headers['user-agent'], fixture.headers['user-agent'])
    assert.equal(received.headers['x-app'], fixture.headers['x-app'])
    assert.equal(received.headers['x-preserve'], 'unchanged')
    assert.equal(received.body, body)
  }
  for (const data of [body, new TextEncoder().encode(body), new TextEncoder().encode(body).buffer]) marked(await send(data))
  const request = new Request(base + '/prefix/v1/messages', { method: 'POST', headers, body })
  marked(await (await loader.fetch(request)).json())
  const override = new Request(base + '/v1/messages', { method: 'POST', headers, body: '{}' })
  marked(await (await loader.fetch(override, { body })).json())
  assert.equal(await override.text(), '{}', 'overridden Request body is not consumed')
  const originalUA = 'claude-cli/9.8.7 (external, cli)'
  const existing = await send(body, { headers: { ...headers, 'user-agent': originalUA, 'x-app': 'keep' } })
  assert.equal(existing.headers['user-agent'], originalUA)
  assert.equal(existing.headers['x-app'], 'keep')
  for (const data of ['{bad json', '{}', JSON.stringify({ ...fixture.body, metadata: {} }), JSON.stringify({ ...fixture.body, metadata: { user_id: ' ' } }), JSON.stringify({ ...fixture.body, system: fixture.body.system.slice(1) })]) {
    const received = await send(data)
    assert.equal(received.headers['user-agent'], headers['user-agent'])
    assert.equal(received.headers['x-app'], undefined)
    assert.equal(received.body, data)
  }
  for (const [method, path] of [['PUT', '/v1/messages'], ['POST', '/v1/messages/other'], ['POST', '/v1/chat/completions']]) {
    const received = await send(body, { method }, path)
    assert.equal(received.headers['user-agent'], headers['user-agent'])
    assert.equal(received.body, body)
  }
  const count = JSON.stringify({ messages: fixture.body.messages })
  const known = await send(count, {}, '/v1/messages/count_tokens')
  assert.equal(known.headers['user-agent'], fixture.headers['user-agent'])
  assert.equal(known.body, count)
  const unknown = await send(count, { headers: { ...headers, 'x-magpie-session': 'unknown' } }, '/v1/messages/count_tokens')
  assert.equal(unknown.headers['user-agent'], headers['user-agent'])
  // An already identified request must not prime the session cache.
  await send(body, { headers: { ...headers, 'user-agent': originalUA, 'x-magpie-session': 'bypass' } })
  const bypass = await send(count, { headers: { ...headers, 'x-magpie-session': 'bypass' } }, '/v1/messages/count_tokens')
  assert.equal(bypass.headers['user-agent'], headers['user-agent'])
  for (let i = 0; i < 1000; i++) await send(body, { headers: { ...headers, 'x-magpie-session': `bounded-${i}` } })
  const evicted = await send(count, {}, '/v1/messages/count_tokens')
  assert.equal(evicted.headers['user-agent'], headers['user-agent'])
  const newest = await send(count, { headers: { ...headers, 'x-magpie-session': 'bounded-999' } }, '/v1/messages/count_tokens')
  assert.equal(newest.headers['user-agent'], fixture.headers['user-agent'])
})

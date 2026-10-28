/**
 * Offline check for the settings routes of `dsh-plugin-message-notify`.
 *
 * Runs the Host half against a fake context and fake HTTP streams, so a broken
 * route or a bad validation rule shows up without a running DSH.
 *
 * Usage (from the plugin directory):
 *   node .test/settings.mjs
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `index.js` reads DSH_HOME while it is being imported, so point the Home at a
// scratch directory first, then import it dynamically.
const scratch = await mkdtemp(join(tmpdir(), 'dsh-message-notify-settings-'))
process.env.DSH_HOME = scratch
const { apply } = await import('../index.js')

const routes = new Map()
const disposers = []

const ctx = {
  get(service) {
    if (service !== 'webServer') return undefined
    return {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    }
  },
  on() {
    return () => {}
  },
  effect(setup) {
    const dispose = setup()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
}

/** Minimal stand-in for an incoming request. */
function request(method, body) {
  const handlers = new Map()
  const req = {
    method,
    setEncoding() {},
    on(event, callback) {
      const list = handlers.get(event) ?? []
      list.push(callback)
      handlers.set(event, list)
      return req
    },
    destroy() {},
  }
  process.nextTick(() => {
    if (body !== undefined) for (const callback of handlers.get('data') ?? []) callback(body)
    for (const callback of handlers.get('end') ?? []) callback()
  })
  return req
}

/** Minimal stand-in for a server response. */
function makeResponse() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
      return this
    },
    end(body) {
      this.body = body ?? ''
    },
    destroy() {},
  }
}

/** Fire one route and wait for its response. */
async function hit(path, method, body) {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error(`route ${path} is not registered`)
  const res = makeResponse()
  handler(request(method, body === undefined ? undefined : JSON.stringify(body)), res)
  // The settings route touches the disk before it answers, so poll instead of
  // assuming one tick is enough.
  for (let attempt = 0; attempt < 500 && res.body === ''; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return { status: res.status, body: res.body === '' ? null : JSON.parse(res.body) }
}

apply(ctx, { tracePath: '' })

const failures = []
function check(name, condition, detail) {
  if (condition) return
  failures.push(`${name}${detail === undefined ? '' : ` (${detail})`}`)
}

const settingsRoute = '/plugins-local/dsh-message-notify-settings'
const testRoute = '/plugins-local/dsh-message-notify-test'

check('settings route registered', routes.has(settingsRoute))
check('test route registered', routes.has(testRoute))

const initial = await hit(settingsRoute, 'GET')
check(
  'GET defaults',
  initial.status === 200 && initial.body.settings.timeoutSeconds === 15 && initial.body.settings.focusedTimeoutSeconds === 15 && initial.body.settings.dotColor === '' && initial.body.settings.enabled === undefined,
  JSON.stringify(initial.body),
)

const badTimeout = await hit(settingsRoute, 'POST', { timeoutSeconds: 7201 })
check('rejects an out-of-range timeout', badTimeout.status === 400, JSON.stringify(badTimeout.body))

const badLowTimeout = await hit(settingsRoute, 'POST', { timeoutSeconds: 4 })
const badFocused = await hit(settingsRoute, 'POST', { focusedTimeoutSeconds: 7201 })
check('rejects an out-of-range focused timeout', badFocused.status === 400, JSON.stringify(badFocused.body))
check('rejects a timeout below the floor', badLowTimeout.status === 400, JSON.stringify(badLowTimeout.body))

const badTheme = await hit(settingsRoute, 'POST', { themeMode: 'sepia' })
check('rejects an unknown theme', badTheme.status === 400, JSON.stringify(badTheme.body))

const badDot = await hit(settingsRoute, 'POST', { dotColor: 'red' })
check('rejects a bad dot color', badDot.status === 400, JSON.stringify(badDot.body))

const saved = await hit(settingsRoute, 'POST', { timeoutSeconds: 30, focusedTimeoutSeconds: 20, awayOnly: false, themeMode: 'dark', dotColor: '#FF3B30' })
check(
  'saves valid settings',
  saved.status === 200 && saved.body.settings.timeoutSeconds === 30 && saved.body.settings.focusedTimeoutSeconds === 20 && saved.body.settings.themeMode === 'dark' && saved.body.settings.dotColor === '#ff3b30',
  JSON.stringify(saved.body),
)

const onDisk = JSON.parse(await readFile(join(scratch, 'plugin-data', 'dsh-message-notify', 'settings.json'), 'utf8'))
check('persists to disk', onDisk.timeoutSeconds === 30 && onDisk.focusedTimeoutSeconds === 20 && onDisk.awayOnly === false, JSON.stringify(onDisk))

const reread = await hit(settingsRoute, 'GET')
check(
  'reads the stored settings back',
  reread.body.settings.timeoutSeconds === 30 && reread.body.settings.focusedTimeoutSeconds === 20 && reread.body.settings.awayOnly === false,
  JSON.stringify(reread.body),
)

const getOnTest = await hit(testRoute, 'GET')
check('test route only accepts POST', getOnTest.status === 405, JSON.stringify(getOnTest.body))

// A short timeout keeps the demo card from sitting on screen for half a minute.
await hit(settingsRoute, 'POST', { timeoutSeconds: 15 })
const fired = await hit(testRoute, 'POST')
check('test card is queued', fired.status === 200 && fired.body.ok === true, JSON.stringify(fired.body))

await rm(scratch, { recursive: true, force: true }).catch(() => {})
for (const dispose of disposers) dispose()

if (failures.length > 0) {
  console.error(`FAILED\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('settings routes OK')
process.exit(0)

/**
 * Offline driver for the Host half.
 *
 * It fakes just enough `ctx` to call `apply`, replays the session events of one
 * finished turn, and leaves the real popup helper to run on its own. It also
 * exercises the theme route the Client half calls, so the palette hand-off can
 * be checked without an installed bundle. Not shipped (lives outside `files`).
 */
import { EventEmitter } from 'node:events'
import { apply } from '../index.js'

/** Routes the Host half registered, keyed by path. */
const routes = new Map()
const handlers = []

const ctx = {
  get: (key) => {
    if (key === 'logger') return { warn: (line) => console.log(`LOG ${line}`) }
    if (key === 'webServer') {
      return {
        register: (route) => {
          routes.set(route.path, route)
          console.log(`registered route ${route.path}`)
          return () => routes.delete(route.path)
        },
      }
    }
    return undefined
  },
  on: (event, handler) => {
    handlers.push([event, handler])
    return () => {}
  },
  effect: (factory) => factory(),
}

const stamp = () => new Date().toISOString().slice(11, 23)

apply(ctx, {
  focusProcess: process.env.FOCUS_PROCESS ?? 'NoSuchProcessXYZ',
  timeoutSeconds: Number(process.env.POPUP_TIMEOUT ?? '3'),
  themeMode: process.env.THEME_MODE ?? 'auto',
  tracePath: process.env.TRACE_PATH ?? '',
})

/** POST a JSON body to one registered route, the way a page would. */
function post(path, body) {
  const route = routes.get(path)
  if (route === undefined) {
    console.log(`no route for ${path}`)
    return
  }
  const req = new EventEmitter()
  req.method = 'POST'
  req.setEncoding = () => {}
  let status = 0
  let text = ''
  const res = {
    writeHead: (code) => {
      status = code
    },
    end: (value) => {
      text = String(value ?? '')
    },
    destroy: () => {},
  }
  route.handler(req, res)
  req.emit('data', JSON.stringify(body))
  req.emit('end')
  console.log(`${stamp()} ${path} -> ${status} ${text}`)
}

const reportedScheme = process.env.THEME_POST ?? ''
if (reportedScheme !== '') post('/plugins-local/dsh-message-notify-theme', { dark: reportedScheme === 'dark' })

const session = {
  id: 'session-offline-test',
  header: { cwd: process.cwd() },
}

const emit = (type, data) => {
  for (const [event, handler] of handlers) {
    if (event === 'session/event') handler(session, { type, data })
  }
}

/**
 * Fire one waterfall request the way the runtime does, and report whether this
 * half handed it on (it must, or a real turn would hang).
 */
const emitRequest = (event, request) => {
  let forwarded = false
  const next = () => {
    forwarded = true
    return Promise.resolve({ kind: 'approved' })
  }
  for (const [name, handler] of handlers) {
    if (name === event) handler(request, next)
  }
  console.log(`${stamp()} ${event} forwarded=${forwarded}`)
}

const text = (value) => [{ type: 'text', text: value }]
const scenario = process.env.SCENARIO ?? 'reply'

if (scenario === 'reply') {
  console.log(`${stamp()} turn replayed`)
  emit('user/message', { content: text('帮我给插件加一个右下角提醒') })
  emit('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: text('弹窗已经加好了：Host 监听轮次结束事件，前台不是 DSH 时才显示，15 秒不操作自动关闭。') },
  })
  emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  console.log(`${stamp()} events emitted`)
}

if (scenario === 'approval') {
  emitRequest('approval/request', {
    agent: { session },
    toolName: 'bash',
    callId: 'call-offline-approval',
    displayReason: {
      en: 'Run `pnpm install` to install the bundle dependencies.',
      zh: '需要运行 `pnpm install` 安装这个插件的依赖。',
    },
  })
}

if (scenario === 'question') {
  emitRequest('user-questions/request', {
    agent: { session },
    questions: [
      {
        id: 'offline-question',
        header: '选择实现方式',
        question: '这个提醒插件用哪种方式实现？',
        options: [{ label: 'Host 插件 + 原生弹窗' }, { label: '页面内浮层' }],
      },
    ],
  })
}

if (scenario === 'plan') {
  emitRequest('user-questions/request', {
    agent: { session },
    questions: [
      {
        id: 'offline-plan',
        header: '计划待确认',
        question: '是否按这个计划执行？',
        options: [{ label: '继续执行' }, { label: '继续规划' }],
        intent: { kind: 'plan-review', approve: '继续执行' },
      },
    ],
  })
}

setTimeout(() => {
  console.log(`${stamp()} driver done`)
  process.exit(0)
}, Number(process.env.DRIVE_LIFETIME_MS ?? '6000'))

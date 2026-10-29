/**
 * Host half of `dsh-plugin-message-notify`.
 *
 * What it solves: a reply that lands while the user is looking at another app
 * should be visible at a glance. The DSH desktop shell exposes no window or
 * notification bridge to plugins, and a page cannot draw outside its own
 * window, so the only honest place for that reminder is a real top-level window
 * owned by another process.
 *
 * Shape of the bundle:
 *  1. watch `session/event` on the Host and remember each session's title and
 *     latest assistant text;
 *  2. when a turn ends with an actual reply, hand one JSON payload to
 *     `popup.ps1` (PowerShell + WPF) as a detached child process;
 *  3. that helper decides for itself whether the DSH window is in front — if it
 *     is, it exits without drawing anything, so in-app turns never flash a
 *     window — otherwise it shows a bottom-right card for a while.
 *
 * One popup is shown at a time; later replies wait in a small FIFO queue.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { renameSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This file's directory, used to locate the helper script beside it. */
const here = dirname(fileURLToPath(import.meta.url))

/** The WPF helper that actually draws the card. */
const POPUP_SCRIPT = join(here, 'popup.ps1')

/**
 * Private same-origin route the Client half posts the active DSH palette to.
 * Prefixed to stay clear of shipped routes.
 */
const THEME_ROUTE = '/plugins-local/dsh-message-notify-theme'

/**
 * Private same-origin routes behind the settings page in the plugin detail
 * page: one for reading and writing the settings, one for a test card.
 */
const SETTINGS_ROUTE = '/plugins-local/dsh-message-notify-settings'
const TEST_ROUTE = '/plugins-local/dsh-message-notify-test'

/**
 * How long a reported palette stays authoritative. DSH keeps its preference in
 * the page, not on disk, so the Host only knows the last value a page told it;
 * a stale hint must not dress the card in the wrong palette forever.
 */
const THEME_HINT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Stable Loader plugin name, matching `cordis.patch.yml`. */
export const name = 'dsh-message-notify'

/**
 * All three private routes are served by the web server, so wait for it. The
 * loader applies a plugin before its services exist otherwise, `ctx.get` comes
 * back empty and the routes are silently never registered.
 */
export const inject = ['webServer']

/** How long the card stays when the user does nothing. */
const DEFAULT_TIMEOUT_SECONDS = 15

/** Process whose main window means "the user is in DSH"; click View restores it. */
const DEFAULT_FOCUS_PROCESS = 'DeepSeek Harness'

/** The running app binary; only used to relaunch DSH when it is not running. */
const FOCUS_EXE = process.execPath

/** Small caps that name what a card is about. */
const KICKER_REPLY = 'DSH 新回复'
const KICKER_APPROVAL = 'DSH 等待授权'
const KICKER_QUESTION = 'DSH 需要你的回答'
const KICKER_PLAN = 'DSH 计划待确认'

/** Caps that keep the card readable. */
const TITLE_LIMIT = 60
// The card body is ~4 lines at the base height and gets ~2.7 extra lines from
// the 30% height boost; 260 chars keeps the taller body filled instead of
// leaving it blank after a 160-char cut.
const SUMMARY_LIMIT = 260

/** Test-card body when no 测试正文 is configured. */
const DEFAULT_TEST_SUMMARY = '看到这张卡片就说明提醒正常：点「查看」回到 DSH，点「关闭」立即收起。'

/** Soft cap on remembered session state. */
const SESSION_CACHE_LIMIT = 400

/** Upper bound of queued popups; older replies are dropped first. */
const QUEUE_LIMIT = 6

/** Safety valve so a stuck helper can never block the queue forever. */
const HELPER_WATCHDOG_MS = 120_000

/**
 * Where the settings page keeps its choices. It lives under the DSH home so it
 * follows the profile rather than the workspace of whichever session happens to
 * be running.
 */
const SETTINGS_FILE = join(
  process.env.DSH_HOME ?? join(homedir(), '.dsh'),
  'plugin-data',
  'dsh-message-notify',
  'settings.json',
)

/**
 * What the card does before anyone opens the settings page.
 *
 * `timeoutSeconds` is the delay while the person is away from DSH;
 * `focusedTimeoutSeconds` is the shorter delay used when DSH is in the
 * foreground, which only happens once "always notify" is on.
 */
const DEFAULT_SETTINGS = Object.freeze({
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  focusedTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  awayOnly: true,
  themeMode: 'auto',
  indicator: 'bar',
  dotColor: '',
  testText: '',
  sound: true,
})

/** Theme choices the helper understands. */
const THEME_MODES = Object.freeze(['auto', 'dark', 'light'])

/** Accent indicator styles the helper understands: a top bar or a header dot. */
const INDICATOR_MODES = Object.freeze(['bar', 'dot'])

/** Optional fixed color for the pulsing dot; empty means "follow the palette". */
const DOT_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

/** Bounds for the auto-close delay, in seconds (15 s up to two hours). */
const TIMEOUT_MIN_SECONDS = 15
const TIMEOUT_MAX_SECONDS = 7200

/**
 * Palettes chosen from the DSH theme aliases so the card reads as DSH chrome:
 * `neutral-bluish` surfaces and label colors, `deepseek` accent, and the
 * inverted high-contrast primary button DSH itself uses.
 */
const THEMES = {
  dark: {
    bg: '#FF232324',
    fg: '#FFF9FAFB',
    muted: '#FFADB2B8',
    border: '#FF35363A',
    accent: '#FF5686FE',
    primaryBg: '#FFF9FAFB',
    primaryFg: '#FF151517',
    primaryHover: '#FFE7E8EB',
    ghostHover: '#14FFFFFF',
  },
  light: {
    bg: '#FFFFFFFF',
    fg: '#FF0F1115',
    muted: '#FF61666B',
    border: '#FFE4E7EC',
    accent: '#FF4176E6',
    primaryBg: '#FF0F1115',
    primaryFg: '#FFFFFFFF',
    primaryHover: '#FF2B2F36',
    ghostHover: '#0F000000',
  },
}

/** Path to Windows PowerShell, resolved once. */
const POWERSHELL = resolvePowershell()

/**
 * Opt-in breadcrumbs for a popup that never shows up: set
 * `DSH_MESSAGE_NOTIFY_DEBUG=1` and the Host half reports each decision on
 * stderr. Silent in normal use.
 *
 * @param line - what just happened.
 */
function debug(line) {
  if (process.env.DSH_MESSAGE_NOTIFY_DEBUG === '1') console.error(`[dsh-message-notify] ${line}`)
}

/**
 * Answer one request with a JSON body.
 *
 * @param res - the response to write.
 * @param status - HTTP status code.
 * @param body - JSON-serializable payload.
 */
function reply(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * Coerce a raw settings record into the shape the card reads.
 *
 * @param raw - whatever was on disk or in a request body.
 * @returns a complete settings record; unknown fields are dropped.
 */
function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const settings = { ...DEFAULT_SETTINGS }
  if (typeof source.awayOnly === 'boolean') settings.awayOnly = source.awayOnly
  if (typeof source.themeMode === 'string' && THEME_MODES.includes(source.themeMode)) {
    settings.themeMode = source.themeMode
  }
  if (typeof source.indicator === 'string' && INDICATOR_MODES.includes(source.indicator)) {
    settings.indicator = source.indicator
  }
  const seconds = Number(source.timeoutSeconds)
  if (Number.isInteger(seconds) && seconds >= TIMEOUT_MIN_SECONDS && seconds <= TIMEOUT_MAX_SECONDS) {
    settings.timeoutSeconds = seconds
  }
  const focusedSeconds = Number(source.focusedTimeoutSeconds)
  if (
    Number.isInteger(focusedSeconds) &&
    focusedSeconds >= TIMEOUT_MIN_SECONDS &&
    focusedSeconds <= TIMEOUT_MAX_SECONDS
  ) {
    settings.focusedTimeoutSeconds = focusedSeconds
  }
  if (typeof source.dotColor === 'string' && DOT_COLOR_PATTERN.test(source.dotColor)) {
    settings.dotColor = source.dotColor.toLowerCase()
  }
  if (typeof source.testText === 'string') {
    settings.testText = source.testText.trim().slice(0, SUMMARY_LIMIT)
  }
  if (typeof source.sound === 'boolean') settings.sound = source.sound
  return settings
}

/**
 * Read the persisted settings.
 *
 * @returns the stored settings, or `null` when none were saved yet (so the
 *   bundle patch keeps acting as the initial value).
 */
async function loadSettings() {
  try {
    const raw = await readFile(SETTINGS_FILE, 'utf8')
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * Persist the settings next to the profile.
 *
 * @param settings - the record to write.
 */
async function saveSettings(settings) {
  await mkdir(dirname(SETTINGS_FILE), { recursive: true })
  await writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

/**
 * Collect one request body as text.
 *
 * @param req - the incoming request.
 * @param limit - how many characters to keep before ignoring the rest.
 * @returns the body, or an empty string when the stream failed.
 */
function readBody(req, limit) {
  return new Promise((resolve) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (raw.length <= limit) raw += chunk
    })
    req.on('end', () => resolve(raw))
    req.on('error', () => resolve(''))
  })
}

/**
 * Name the first field a settings write got wrong.
 *
 * @param body - the parsed request body.
 * @returns a message, or an empty string when the write is acceptable.
 */
function settingsProblem(body) {
  if (typeof body.awayOnly !== 'undefined' && typeof body.awayOnly !== 'boolean') return 'awayOnly must be a boolean.'
  if (typeof body.themeMode !== 'undefined' && !THEME_MODES.includes(body.themeMode)) {
    return `themeMode must be one of ${THEME_MODES.join(', ')}.`
  }
  if (typeof body.indicator !== 'undefined' && !INDICATOR_MODES.includes(body.indicator)) {
    return `indicator must be one of ${INDICATOR_MODES.join(', ')}.`
  }
  if (typeof body.timeoutSeconds !== 'undefined') {
    const seconds = Number(body.timeoutSeconds)
    if (!Number.isInteger(seconds) || seconds < TIMEOUT_MIN_SECONDS || seconds > TIMEOUT_MAX_SECONDS) {
      return `timeoutSeconds must be an integer between ${TIMEOUT_MIN_SECONDS} and ${TIMEOUT_MAX_SECONDS}.`
    }
  }
  if (typeof body.focusedTimeoutSeconds !== 'undefined') {
    const seconds = Number(body.focusedTimeoutSeconds)
    if (!Number.isInteger(seconds) || seconds < TIMEOUT_MIN_SECONDS || seconds > TIMEOUT_MAX_SECONDS) {
      return `focusedTimeoutSeconds must be an integer between ${TIMEOUT_MIN_SECONDS} and ${TIMEOUT_MAX_SECONDS}.`
    }
  }
  if (typeof body.dotColor !== 'undefined') {
    if (typeof body.dotColor !== 'string' || (body.dotColor !== '' && !DOT_COLOR_PATTERN.test(body.dotColor))) {
      return 'dotColor must be an empty string or a #RRGGBB color.'
    }
  }
  if (typeof body.testText !== 'undefined') {
    if (typeof body.testText !== 'string' || body.testText.length > SUMMARY_LIMIT) {
      return `testText must be a string of at most ${SUMMARY_LIMIT} characters.`
    }
  }
  if (typeof body.sound !== 'undefined' && typeof body.sound !== 'boolean') {
    return 'sound must be a boolean.'
  }
  return ''
}

/**
 * Locate the inbox Windows PowerShell binary.
 *
 * `powershell.exe` on PATH is normally fine, but the desktop app may be started
 * with a trimmed environment, so the system path is preferred.
 *
 * @returns the executable to spawn.
 */
function resolvePowershell() {
  const root = process.env.SystemRoot ?? process.env.windir
  if (typeof root === 'string' && root !== '') {
    for (const candidate of [
      join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      join(root, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return 'powershell.exe'
}

/**
 * Join the text blocks of one message.
 *
 * @param message - a message whose `content` may hold text blocks.
 * @returns its text, or an empty string when it has none.
 */
function textOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * Collapse text into one readable line.
 *
 * @param text - raw message text.
 * @returns whitespace-normalised text without code fences.
 */
function flatten(text) {
  return text
    .replace(/```[a-zA-Z0-9_-]*\n?/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_>#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Truncate on a word-ish boundary and mark the cut.
 *
 * @param text - flattened text.
 * @param limit - maximum characters kept.
 * @returns the shortened text.
 */
function clamp(text, limit) {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  const head = space > limit * 0.6 ? cut.slice(0, space) : cut
  return `${head.trimEnd()}…`
}

/**
 * Report a failure without ever disturbing the session that triggered it.
 *
 * @param ctx - the plugin context.
 * @param error - whatever was thrown.
 */
function report(ctx, error) {
  try {
    const logger = ctx.get('logger')
    logger?.warn?.(`[dsh-message-notify] ${error instanceof Error ? error.message : String(error)}`)
  } catch {
    // Logging is best-effort; a missing logger must not fail a reply.
  }
}

/**
 * Read one optional Host service.
 *
 * @param ctx - the plugin context.
 * @param service - exact service key.
 * @returns the service, or `undefined` when the profile does not provide it.
 */
function serviceOf(ctx, service) {
  try {
    return ctx.get(service)
  } catch {
    return undefined
  }
}

/**
 * Start the helper and wait until it exits.
 *
 * The helper is unref'd so a DSH shutdown cannot leave a half-drawn card
 * behind, and `stdout`/`stderr` are ignored because the window is the output.
 *
 * @param payloadPath - JSON file describing the card.
 * @param holdMs - how long the card may stay up before the watchdog gives up.
 * @returns a promise settled when the helper is gone.
 */
function runHelper(payloadPath, holdMs) {
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }

    let child
    try {
      child = spawn(
        POWERSHELL,
        [
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-WindowStyle',
          'Hidden',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          POPUP_SCRIPT,
          '-PayloadPath',
          payloadPath,
        ],
        // `detached` is deliberately absent: on Windows a detached PowerShell
        // exits before running the script. `unref` still lets DSH quit while
        // the card is up, and the helper is a plain top-level window anyway.
        { stdio: 'ignore', windowsHide: true },
      )
    } catch (error) {
      debug(`spawn threw ${error instanceof Error ? error.message : String(error)}`)
      done()
      return
    }

    debug(`spawned helper pid=${child.pid ?? '?'}`)
    child.once('error', (error) => debug(`helper error ${error.message}`))
    child.once('exit', (code, signal) => debug(`helper exit code=${code} signal=${signal}`))

    child.once('error', done)
    child.once('exit', done)
    child.unref()

    const watchdog = setTimeout(done, Math.max(HELPER_WATCHDOG_MS, holdMs))
    watchdog.unref?.()
  })
}

/**
 * Watch finished turns and surface the ones that produced a reply.
 *
 * @param ctx - the plugin context.
 * @param config - optional entries from the bundle patch.
 */
export function apply(ctx, config = {}) {
  if (process.platform !== 'win32') return

  const focusProcess =
    typeof config.focusProcess === 'string' && config.focusProcess !== ''
      ? config.focusProcess
      : DEFAULT_FOCUS_PROCESS
  /** Optional breadcrumb file the helper appends to; empty keeps it off. */
  const tracePath = typeof config.tracePath === 'string' ? config.tracePath : ''

  /**
   * Live settings: the bundle patch seeds them, the settings page replaces them,
   * and every card reads them at build time so a save applies to the next card
   * without a restart.
   */
  const settings = normalizeSettings({
    timeoutSeconds: config.timeoutSeconds,
    focusedTimeoutSeconds: config.focusedTimeoutSeconds,
    themeMode: config.themeMode,
    indicator: config.indicator,
    dotColor: config.dotColor,
    sound: config.sound,
  })
  void loadSettings().then((stored) => {
    if (stored !== null) Object.assign(settings, stored)
  }).catch(() => {})

  /** Last palette a page reported, and when it did. */
  const themeHint = { dark: undefined, at: 0 }

  // The Client half reports DSH's real palette over this route; when no page
  // has reported yet the helper falls back to the Windows app theme.
  const webServer = serviceOf(ctx, 'webServer')
  const registerRoutes = (server) => {
    ctx.effect(() => server.register({
      kind: 'exact',
      path: THEME_ROUTE,
      handler: (req, res) => {
        if (req.method === 'GET') {
          // Lets a person confirm that a page reported its palette at all.
          reply(res, 200, {
            ok: true,
            reportedDark: themeHint.dark ?? null,
            reportedAt: themeHint.at === 0 ? null : new Date(themeHint.at).toISOString(),
            ageSeconds: themeHint.at === 0 ? null : Math.round((Date.now() - themeHint.at) / 1000),
          })
          return
        }
        if (req.method !== 'POST') {
          reply(res, 405, { ok: false, error: 'Use POST or GET.' })
          return
        }
        let raw = ''
        req.setEncoding('utf8')
        req.on('data', (chunk) => {
          if (raw.length < 1024) raw += chunk
        })
        req.on('end', () => {
          try {
            const parsed = raw.length === 0 ? {} : JSON.parse(raw)
            if (typeof parsed?.dark !== 'boolean') {
              reply(res, 400, { ok: false, error: 'Expect {"dark": boolean}.' })
              return
            }
            themeHint.dark = parsed.dark
            themeHint.at = Date.now()
            reply(res, 200, { ok: true })
          } catch {
            reply(res, 400, { ok: false, error: 'The request body must be JSON.' })
          }
        })
        req.on('error', () => {
          try {
            res.destroy()
          } catch {
            // The socket is already gone.
          }
        })
      },
    }), 'dsh-message-notify: theme route')

    // The settings page in the plugin detail page reads and writes through this
    // route; it is same-origin, so the page's own session authorizes it.
    ctx.effect(() => server.register({
      kind: 'exact',
      path: SETTINGS_ROUTE,
      handler: (req, res) => {
        if (req.method === 'GET') {
          reply(res, 200, {
            ok: true,
            settings,
            queue: { pending: queue.length, showing },
            bounds: { minSeconds: TIMEOUT_MIN_SECONDS, maxSeconds: TIMEOUT_MAX_SECONDS },
          })
          return
        }
        if (req.method !== 'POST') {
          reply(res, 405, { ok: false, error: 'Use POST or GET.' })
          return
        }
        void readBody(req, 4096).then((raw) => {
          let parsed
          try {
            parsed = raw.length === 0 ? {} : JSON.parse(raw)
          } catch {
            reply(res, 400, { ok: false, error: 'The request body must be JSON.' })
            return
          }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            reply(res, 400, { ok: false, error: 'Expect a settings object.' })
            return
          }
          const problem = settingsProblem(parsed)
          if (problem !== '') {
            reply(res, 400, { ok: false, error: problem })
            return
          }
          Object.assign(settings, normalizeSettings({ ...settings, ...parsed }))
          void saveSettings(settings)
            .then(() => reply(res, 200, { ok: true, settings }))
            .catch((error) => {
              report(ctx, error)
              reply(res, 500, { ok: false, error: 'Could not write the settings file.' })
            })
        })
      },
    }), 'dsh-message-notify: settings route')

    // A test card proves the whole chain end to end, so it ignores both the
    // "only while away" rule and the master switch.
    ctx.effect(() => server.register({
      kind: 'exact',
      path: TEST_ROUTE,
      handler: (req, res) => {
        if (req.method !== 'POST') {
          reply(res, 405, { ok: false, error: 'Use POST.' })
          return
        }
        void readBody(req, 4096).then((raw) => {
          let parsed = {}
          if (raw.trim() !== '') {
            try {
              parsed = JSON.parse(raw)
            } catch {
              reply(res, 400, { ok: false, error: 'The request body must be JSON.' })
              return
            }
          }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            reply(res, 400, { ok: false, error: 'Expect a test body.' })
            return
          }
          const requested = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
          const text = requested !== '' ? requested : (settings.testText !== '' ? settings.testText : DEFAULT_TEST_SUMMARY)
          enqueue(cardFor({ header: { cwd: process.cwd() } }, {
            force: true,
            skipWhenFocused: false,
            kicker: 'DSH 测试提醒',
            title: '这是一条测试提醒',
            summary: clamp(text, SUMMARY_LIMIT),
          }))
          reply(res, 200, { ok: true })
        })
      },
    }), 'dsh-message-notify: test route')
  }

  if (webServer?.register !== undefined) {
    registerRoutes(webServer)
  } else if (typeof ctx.inject === 'function') {
    // Belt and braces for the boot race that made the settings page 404: if the
    // loader applies this plugin before the web server exists, wait for it here
    // instead of silently losing the routes.
    ctx.inject(['webServer'], (webCtx) => {
      const late = serviceOf(webCtx, 'webServer')
      if (late?.register !== undefined) registerRoutes(late)
    })
  }

  /** Latest title source and reply text per session id. */
  const sessions = new Map()
  /** Payloads waiting for the single visible card. */
  const queue = []
  let showing = false
  /** The card the helper is showing right now, or null while idle. */
  let current = null

  const stateOf = (id) => {
    let state = sessions.get(id)
    if (state !== undefined) return state
    state = { title: '', reply: '' }
    sessions.set(id, state)
    if (sessions.size > SESSION_CACHE_LIMIT) {
      const oldest = sessions.keys().next()
      if (!oldest.done) sessions.delete(oldest.value)
    }
    return state
  }

  /** The page-reported palette, while it is still fresh. */
  const hintedTheme = () => {
    if (themeHint.dark === undefined || Date.now() - themeHint.at >= THEME_HINT_TTL_MS) return ''
    return themeHint.dark ? 'dark' : 'light'
  }

  /**
   * Build the part of a payload every card kind shares.
   *
   * @param session - the session the request belongs to, when known.
   * @param fields - the kind-specific copy.
   * @returns the payload handed to the helper.
   */
  const cardFor = (session, fields) => {
    const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : ''
    const workspace = cwd === '' ? '未登记工作区' : `${basename(cwd)} · ${cwd}`
    const hinted = hintedTheme()
    // An explicit dark/light choice must beat the page's palette report; "auto"
    // asks the helper to follow DSH (the hint) or the Windows app theme.
    const themeMode =
      settings.themeMode === 'auto' ? (hinted === '' ? 'auto' : hinted) : settings.themeMode
    return {
      windowTitle: 'DSH 消息提醒',
      workspace,
      viewLabel: '查看',
      closeLabel: '关闭',
      timeoutSeconds: settings.timeoutSeconds,
      focusedTimeoutSeconds: settings.focusedTimeoutSeconds,
      skipWhenFocused: settings.awayOnly,
      // A real card folds itself two seconds after DSH comes back to the
      // foreground, in both reminder modes; only the test card stays put.
      watchReturn: fields.force !== true,
      focusProcess,
      focusExe: FOCUS_EXE,
      themeMode,
      themes: THEMES,
      indicator: settings.indicator,
      dotColor: settings.dotColor,
      sound: settings.sound,
      tracePath,
      ...fields,
    }
  }

  /**
   * Title of the conversation behind a reply.
   *
   * @param session - the session that produced the reply.
   * @param state - its remembered title.
   * @returns the best title available.
   */
  const replyTitle = (session, state) => {
    const titleService = serviceOf(ctx, 'sessionTitle')
    let title = ''
    try {
      title = (titleService?.get?.(session)?.title ?? '').trim()
    } catch {
      title = ''
    }
    if (title === '') title = state.title
    if (title === '') title = '新的对话'
    return title
  }

  /** Card for a finished turn that produced a reply. */
  const replyPayload = (session, state, summary) =>
    cardFor(session, {
      kicker: KICKER_REPLY,
      title: clamp(replyTitle(session, state), TITLE_LIMIT),
      summary: clamp(summary, SUMMARY_LIMIT),
    })

  /** Card for a tool call that waits for the user's permission. */
  const approvalPayload = (session, request) => {
    const reason = reasonOf(request)
    return cardFor(session, {
      priority: true,
      kicker: KICKER_APPROVAL,
      title: clamp(`需要授权：${toolNameOf(request)}`, TITLE_LIMIT),
      summary: clamp(
        reason === '' ? '有工具调用在等你的确认，确认前它会一直等着。' : reason,
        SUMMARY_LIMIT,
      ),
    })
  }

  /** Card for a structured question; `exit_plan_mode` gets its own wording. */
  const questionPayload = (session, request) => {
    const items = Array.isArray(request?.questions) ? request.questions.filter((item) => item != null) : []
    const planReview = items.some((item) => item?.intent?.kind === 'plan-review')
    const first = items[0]
    const header = typeof first?.header === 'string' ? flatten(first.header) : ''
    const body = typeof first?.question === 'string' ? flatten(first.question) : ''

    let title = header !== '' ? header : body
    if (title === '') title = planReview ? '计划等待确认' : '需要你回答几个问题'

    let summary
    if (planReview) {
      summary = body !== '' ? body : '计划已提交，等你批准或继续规划。'
    } else if (header !== '' && body !== '') {
      summary = body
    } else {
      const options = Array.isArray(first?.options) ? first.options.length : 0
      summary = `${items.length} 个问题${options > 0 ? `，${options} 个选项` : ''}在等你的回答。`
    }

    return cardFor(session, {
      priority: true,
      kicker: planReview ? KICKER_PLAN : KICKER_QUESTION,
      title: clamp(title, TITLE_LIMIT),
      summary: clamp(summary, SUMMARY_LIMIT),
    })
  }

  const pump = async () => {
    if (showing) return
    const next = queue.shift()
    if (next === undefined) return
    showing = true
    current = {
      payload: next,
      priority: next.priority === true,
      controlPath: '',
      pending: undefined,
      pendingClose: false,
      preempted: false,
    }
    debug(`showing "${next.title}"`)
    try {
      await showPopup(next, current)
    } catch (error) {
      report(ctx, error)
    } finally {
      current = null
      showing = false
      if (queue.length > 0) void pump()
    }
  }

  /** Drop queued plain replies; when a card is replaced, only the newest matters. */
  const dropPlainReplies = () => {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].priority !== true) queue.splice(index, 1)
    }
  }

  /**
   * Replace the visible card's copy in place, without closing it.
   *
   * @param payload - the newer reply card.
   * @returns false when the control channel cannot be written.
   */
  const replaceShown = (payload) => {
    const state = current
    if (state === null) return false
    if (state.controlPath === '') {
      // The helper is still starting; the newest reply wins the first paint.
      state.pending = payload
      state.payload = payload
      state.priority = payload.priority === true
      return true
    }
    const ok = writeControl(state.controlPath, {
      kicker: payload.kicker,
      title: payload.title,
      summary: payload.summary,
      workspace: payload.workspace,
    })
    if (ok) {
      state.payload = payload
      state.priority = payload.priority === true
      debug(`replaced shown card with "${payload.title}"`)
    }
    return ok
  }

  /** Ask the helper to fold so a priority card can take its place. */
  const preempt = () => {
    const state = current
    if (state === null || state.preempted === true) return
    state.preempted = true
    if (state.controlPath === '') {
      state.pendingClose = true
      return
    }
    const ok = writeControl(state.controlPath, { close: true })
    debug(ok ? 'closing shown card for a priority request' : 'could not close shown card')
  }

  /**
   * Queue one card; confirmations jump ahead of plain replies, and a newer
   * reply replaces the visible reply card instead of waiting for it to fold.
   *
   * @param payload - card content.
   */
  const enqueue = (payload) => {
    const priority = payload.priority === true
    if (!priority && showing && current !== null) {
      if (current.priority !== true && current.preempted !== true) {
        if (replaceShown(payload)) {
          dropPlainReplies()
          return
        }
      }
      // A priority card owns the screen (or the control channel failed): only
      // the newest reply matters, so drop older waiting ones.
      dropPlainReplies()
      queue.push(payload)
    } else if (priority) {
      if (current !== null && current.priority !== true) preempt()
      const firstReply = queue.findIndex((item) => item.priority !== true)
      queue.splice(firstReply === -1 ? queue.length : firstReply, 0, payload)
    } else {
      queue.push(payload)
    }
    if (queue.length > QUEUE_LIMIT) {
      // Drop the newest plain reply: a pending confirmation matters more.
      let dropped = -1
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index].priority !== true) {
          dropped = index
          break
        }
      }
      if (dropped === -1) queue.pop()
      else queue.splice(dropped, 1)
    }
    void pump()
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (session.header?.origin === 'subagent') return
      const id = String(session.id)
      const state = stateOf(id)

      if (event.type === 'user/message') {
        if (state.title === '') state.title = clamp(flatten(textOf(event.data)), TITLE_LIMIT)
        return
      }

      if (event.type === 'assistant/message') {
        const text = flatten(textOf(event.data?.message))
        if (text !== '') state.reply = text
        return
      }

      if (event.type !== 'turn/end') return
      const kind = event.data?.reason?.kind
      if (kind !== 'completed' && kind !== 'max-tokens' && kind !== 'interrupted') return
      const summary = state.reply
      state.reply = ''
      if (summary === '') return
      debug(`turn ${event.data?.turn} ended with ${summary.length} chars`)
      enqueue(replyPayload(session, state, summary))
    } catch (error) {
      report(ctx, error)
    }
  })

  // Approvals and questions block the turn, so they never reach `session/event`;
  // watch the two waterfalls instead. This half is only a spectator and must
  // hand every request on unchanged, or the turn would wait forever.
  const peek = (agent, build, request) => {
    try {
      if (agent?.session?.header?.origin === 'subagent') return
      enqueue(build(agent?.session, request))
    } catch (error) {
      report(ctx, error)
    }
  }

  // The built-in UI answerer claims these waterfalls before a normally
  // registered observer would run, so prepend both hooks: watch the request,
  // then hand it on unchanged so the UI can still answer it.
  ctx.on('approval/request', (request, next) => {
    peek(request?.agent, approvalPayload, request)
    return typeof next === 'function' ? next() : undefined
  }, { prepend: true })

  ctx.on('user-questions/request', (request, next) => {
    peek(request?.agent, questionPayload, request)
    return typeof next === 'function' ? next() : undefined
  }, { prepend: true })
}

/**
 * Write a control record for the helper without letting a 250 ms poll read a
 * half-written file.
 *
 * @param path - control file inside the card's scratch directory.
 * @param record - JSON payload the helper applies.
 * @returns whether the record reached the file.
 */
function writeControl(path, record) {
  const body = JSON.stringify(record)
  try {
    const temp = `${path}.tmp`
    writeFileSync(temp, body, 'utf8')
    renameSync(temp, path)
    return true
  } catch (error) {
    debug(`control write failed: ${error instanceof Error ? error.message : String(error)}`)
    try {
      writeFileSync(path, body, 'utf8')
      return true
    } catch {
      return false
    }
  }
}

/**
 * Hand one payload to the helper and keep its control file addressable while
 * the card is up.
 *
 * @param payload - card content.
 * @param state - live view of this card, used by the queue for replacements.
 */
async function showPopup(payload, state) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-message-notify-'))
  debug(`scratch ${directory}`)
  try {
    const payloadPath = join(directory, 'payload.json')
    const controlPath = join(directory, 'control.json')
    const resultPath = join(directory, 'result.json')
    // A replacement can land between the queue choosing this card and the
    // helper reading its payload; from here on it goes through the control file.
    state.controlPath = controlPath
    const merged = state.pending === undefined ? payload : { ...payload, ...state.pending }
    state.pending = undefined
    state.payload = merged
    state.priority = merged.priority === true
    const record = { ...merged, resultPath, controlPath }
    await writeFile(payloadPath, JSON.stringify(record), 'utf8')
    if (state.pendingClose) {
      state.pendingClose = false
      writeControl(controlPath, { close: true })
    }
    // The auto-close delay can be as long as two hours, so the watchdog has to
    // outlive the card instead of cutting the queue off at two minutes. The
    // helper picks one of the two delays when it appears, so the watchdog has to
    // follow the slower one.
    const away = Number(payload.timeoutSeconds)
    const focused = Number(payload.focusedTimeoutSeconds)
    const slowest = Math.max(
      Number.isFinite(away) ? away : 0,
      Number.isFinite(focused) ? focused : 0,
      DEFAULT_TIMEOUT_SECONDS,
    )
    await runHelper(payloadPath, slowest * 1000 + 60_000)
  } finally {
    state.controlPath = ''
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Name of the tool an approval request is about.
 *
 * @param request - the approval request event.
 * @returns a tool name safe to show.
 */
function toolNameOf(request) {
  return typeof request?.toolName === 'string' && request.toolName !== '' ? request.toolName : '工具调用'
}

/**
 * Localised, single-line reason behind an approval request.
 *
 * @param request - the approval request event.
 * @returns flattened reason text, possibly empty.
 */
function reasonOf(request) {
  const displayReason = request?.displayReason
  if (displayReason !== null && typeof displayReason === 'object') {
    for (const locale of ['zh', 'zh-CN', 'zh-Hans', 'en']) {
      const text = displayReason[locale]
      if (typeof text === 'string' && text.trim() !== '') return flatten(text)
    }
  }
  return typeof request?.reason === 'string' ? flatten(request.reason) : ''
}

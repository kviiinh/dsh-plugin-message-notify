/**
 * Client half of `dsh-plugin-message-notify`.
 *
 * Two jobs, both small:
 *
 *  1. Palette report. The card is drawn by another process (PowerShell + WPF),
 *     so it cannot read the page's CSS variables. This half reads DSH's active
 *     palette from the theme service and hands it to the Host half, which puts
 *     it in the next payload. DSH keeps its theme preference in the page (not on
 *     disk), so this is the only way the card can match a palette that differs
 *     from the Windows app theme.
 *
 *  2. Settings page. The plugin detail page lists this bundle as a row; the row
 *     opens this page, where the timeout, the "only while away" rule, the theme
 *     override and the indicator colour are edited. On/off lives on the plugin's own
 *     toggle in the plugin list, so this page has no second master switch.
 *     Values live on the Host (a JSON file under the DSH home), so this page is
 *     a thin form over a private same-origin route.
 *
 * The palette report may run before any DOM exists, so it must not depend on
 * services that can be absent during boot.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-message-notify',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Must match `THEME_ROUTE` in index.js. */
    const THEME_ROUTE = '/plugins-local/dsh-message-notify-theme'
    /** Must match `SETTINGS_ROUTE` in index.js. */
    const SETTINGS_ROUTE = '/plugins-local/dsh-message-notify-settings'
    /** Must match `TEST_ROUTE` in index.js. */
    const TEST_ROUTE = '/plugins-local/dsh-message-notify-test'

    /** `<package>#<row id>`, the key the plugin detail page expects. */
    const ROW_KEY = 'dsh-plugin-message-notify#dsh-message-notify'

    /** Swatch shown while the indicator follows the palette (the dark-theme accent). */
    const DEFAULT_DOT_COLOR = '#5686FE'

    /**
     * The palette DSH is painting right now.
     *
     * The theme service is the source of truth. The DOM attribute is only a
     * fallback for a boot order where the service is not resolvable yet; it is
     * how the shipped stylesheets switch palettes.
     *
     * @param ctx - the client plugin context.
     * @returns 'dark', 'light', or an empty string when neither source answers.
     */
    function readScheme(ctx) {
      try {
        const theme = ctx.get('theme')
        const scheme = theme?.getTheme?.()?.active?.colorScheme
        if (scheme === 'dark' || scheme === 'light') return scheme
      } catch {
        // Fall through to the attribute probe.
      }
      const body = globalThis.document?.body
      if (body !== null && body !== undefined) {
        // The shipped stylesheets switch palettes on this attribute, and it is
        // only present for the dark one.
        return body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
      }
      return ''
    }

    /** The last value the Host accepted, so replays cost nothing. */
    let reported = ''

    /**
     * Tell the Host which palette the page is wearing.
     *
     * @param ctx - the client plugin context.
     */
    function report(ctx) {
      const scheme = readScheme(ctx)
      if (scheme === '' || scheme === reported) return
      reported = scheme
      globalThis
        .fetch(THEME_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dark: scheme === 'dark' }),
        })
        .catch(() => {
          // A Host without the route only means the card falls back to the
          // Windows app theme; it is not worth surfacing.
          reported = ''
        })
    }

    /**
     * Call one Host route and parse its JSON body.
     *
     * @param path - route path, including the plugin prefix.
     * @param init - optional fetch options.
     * @returns the parsed body.
     */
    async function call(path, init) {
      const response = await fetch(path, { credentials: 'same-origin', ...init })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        const message = (payload && (payload.error || payload.message)) || `HTTP ${response.status}`
        throw new Error(message)
      }
      return payload
    }

    /**
     * Page styling. Inline objects only, so the plugin never has to inject a
     * global stylesheet into DSH's page. `--dsw-alias-*` tokens are the
     * palette variables the shipped stylesheets define, so every surface below
     * follows the active theme without this file knowing any colour.
     */
    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 4, padding: '2px 0 8px', fontSize: 13 },
      intro: {
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
        lineHeight: 1.6,
        paddingBottom: 6,
      },
      row: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        padding: '10px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        flexWrap: 'wrap',
      },
      rowLabel: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingTop: 6,
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      },
      rowBody: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
        marginLeft: 'auto',
        maxWidth: '100%',
      },
      column: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 },
      line: { display: 'flex', alignItems: 'center', gap: 6 },
      mini: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, whiteSpace: 'nowrap' },
      info: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
      infoButton: {
        width: 15,
        height: 15,
        padding: 0,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 10,
        lineHeight: 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
      },
      tip: {
        position: 'absolute',
        top: 22,
        left: -4,
        width: 252,
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12,
        lineHeight: 1.6,
        whiteSpace: 'normal',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
        zIndex: 30,
      },
      choice: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
      check: { accentColor: 'var(--dsw-alias-brand-primary)', cursor: 'pointer', margin: 0 },
      number: {
        width: 88,
        height: 28,
        padding: '0 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
      },
      testText: {
        width: 320,
        height: 28,
        padding: '0 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
      },
      popoverWrap: { position: 'relative', display: 'inline-flex' },
      trigger: {
        height: 30,
        minWidth: 128,
        padding: '0 10px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        cursor: 'pointer',
      },
      menu: {
        position: 'absolute',
        top: 34,
        right: 0,
        minWidth: 148,
        padding: 4,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-3)',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
        zIndex: 40,
      },
      menuItem: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        width: '100%',
        height: 30,
        padding: '0 8px',
        borderRadius: 6,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        textAlign: 'left',
        cursor: 'pointer',
      },
      menuItemOn: { color: 'var(--dsw-alias-brand-primary)', fontWeight: 500 },
      /** Theme-neutral hover tint, so menus read the same in light and dark. */
      hoverTint: 'color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)',
      swatchTrigger: {
        width: 46,
        height: 30,
        padding: 3,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        cursor: 'pointer',
      },
      swatchFill: { width: '100%', height: '100%', borderRadius: 4, display: 'block' },
      palette: {
        position: 'absolute',
        top: 34,
        right: 0,
        width: 214,
        padding: 10,
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-3)',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
        zIndex: 40,
      },
      paletteUp: { top: 'auto', bottom: 34 },
      sv: {
        position: 'relative',
        width: '100%',
        height: 88,
        borderRadius: 6,
        cursor: 'crosshair',
        touchAction: 'none',
        userSelect: 'none',
      },
      svThumb: {
        position: 'absolute',
        width: 12,
        height: 12,
        marginLeft: -6,
        marginTop: -6,
        borderRadius: '50%',
        border: '2px solid #fff',
        boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.35)',
        pointerEvents: 'none',
      },
      hue: {
        position: 'relative',
        width: '100%',
        height: 10,
        marginTop: 8,
        borderRadius: 5,
        cursor: 'pointer',
        touchAction: 'none',
        background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
      },
      hueThumb: {
        position: 'absolute',
        top: '50%',
        width: 10,
        height: 14,
        marginLeft: -5,
        marginTop: -7,
        borderRadius: 3,
        border: '2px solid #fff',
        boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.35)',
        pointerEvents: 'none',
      },
      hexRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 },
      hexLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, letterSpacing: '0.04em' },
      hexInput: {
        flex: 1,
        minWidth: 0,
        height: 26,
        padding: '0 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      },
      hexBad: { borderColor: 'var(--dsw-alias-state-error-primary)' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 },
      swatch: {
        width: '100%',
        // Same width as before, half the height: a 5x2 strip of 2:1 chips.
        height: 16,
        padding: 0,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        cursor: 'pointer',
      },
      swatchOn: { boxShadow: '0 0 0 2px var(--dsw-alias-brand-primary)' },
      paletteReset: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        height: 28,
        marginTop: 8,
        padding: '0 6px',
        borderRadius: 6,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
        cursor: 'pointer',
      },
      actions: { display: 'flex', alignItems: 'center', gap: 10, paddingTop: 12 },
      button: {
        height: 30,
        padding: '0 14px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        cursor: 'pointer',
      },
      /** Filled DSH primary: brand becomes the surface, the page colour the ink. */
      primary: {
        borderColor: 'var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
      },
      /** Nothing to save yet: flat, muted and unclickable-looking. */
      primaryIdle: {
        borderColor: 'var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'default',
      },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: 1.6 },
      notice: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 },
    }

    /**
     * One settings row: the name and an optional info dot on the left, the
     * control right-aligned on the same line. The long explanation lives in the
     * dot's hover card so the form stays scannable.
     *
     * @param props - `label`, `tip` and the control as children.
     */
    function FieldRow(props) {
      const [open, setOpen] = React.useState(false)
      const hasTip = typeof props.tip === 'string' && props.tip !== ''
      // Rows near the bottom open their card upwards so it cannot fall out of
      // the page's scroll container.
      const tipStyle = props.flip === true ? { ...S.tip, top: 'auto', bottom: 22 } : S.tip
      return h(
        'div',
        { style: S.row },
        h(
          'div',
          { style: S.rowLabel },
          h('span', null, props.label),
          hasTip
            ? h(
                'span',
                { style: S.info },
                h(
                  'button',
                  {
                    type: 'button',
                    style: S.infoButton,
                    'aria-label': '说明',
                    onMouseEnter: () => setOpen(true),
                    onMouseLeave: () => setOpen(false),
                    onFocus: () => setOpen(true),
                    onBlur: () => setOpen(false),
                  },
                  'i',
                ),
                open ? h('div', { role: 'tooltip', style: tipStyle }, props.tip) : null,
              )
            : null,
        ),
        h('div', { style: S.rowBody }, props.children),
      )
    }

    /** Tiny inline icons drawn in `currentColor`, so both palettes work. */
    function icon(path) {
      return h(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: path,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /**
     * Close a popover when the pointer leaves it or Escape is pressed.
     *
     * @returns a ref to attach to the popover root.
     */
    function useDismiss(open, close) {
      const ref = React.useRef(null)
      const latest = React.useRef(close)
      latest.current = close
      React.useEffect(() => {
        if (!open) return undefined
        const onPointer = (event) => {
          const node = ref.current
          if (node !== null && event.target instanceof Node && !node.contains(event.target)) latest.current()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') latest.current()
        }
        document.addEventListener('mousedown', onPointer)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onPointer)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])
      return ref
    }

    /**
     * A select whose popup is ours: DSH-style surface, hover tint and a check on
     * the current value, instead of the system list box.
     *
     * @param props - `value`, `options` (`{ value, label }[]`), `onChange`, `disabled`.
     */
    function Dropdown(props) {
      const [open, setOpen] = React.useState(false)
      const [hover, setHover] = React.useState(-1)
      const ref = useDismiss(open, () => setOpen(false))
      const current = props.options.find((option) => option.value === props.value) ?? props.options[0]
      return h(
        'div',
        { ref, style: S.popoverWrap },
        h(
          'button',
          {
            type: 'button',
            style: S.trigger,
            disabled: props.disabled,
            'aria-haspopup': 'listbox',
            'aria-expanded': open,
            onClick: () => {
              setHover(-1)
              setOpen((value) => !value)
            },
          },
          h('span', null, current.label),
          icon('M2.5 4.5 L6 8 L9.5 4.5'),
        ),
        open
          ? h(
              'div',
              { role: 'listbox', style: S.menu },
              props.options.map((option, index) => {
                const selected = option.value === props.value
                const style = { ...S.menuItem }
                if (selected) Object.assign(style, S.menuItemOn)
                if (index === hover) style.background = S.hoverTint
                return h(
                  'button',
                  {
                    key: option.value,
                    type: 'button',
                    role: 'option',
                    'aria-selected': selected,
                    style,
                    onMouseEnter: () => setHover(index),
                    onMouseLeave: () => setHover(-1),
                    onClick: () => {
                      setOpen(false)
                      if (!selected) props.onChange(option.value)
                    },
                  },
                  h('span', null, option.label),
                  selected ? icon('M2.5 6.5 L5 9 L9.5 3.5') : null,
                )
              }),
            )
          : null,
      )
    }

    /** Colours offered for the pulsing indicator; the first two are DSH's own accents. */
    const DOT_COLORS = [
      '#5686FE',
      '#4176E6',
      '#22C55E',
      '#EAB308',
      '#F97316',
      '#EF4444',
      '#EC4899',
      '#A855F7',
      '#06B6D4',
      '#0F1115',
    ]

    const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

    /** Hex colour -> HSV with `h` in degrees and `s`/`v` in 0..1. */
    function hexToHsv(hex) {
      const value = HEX_COLOR.test(hex) ? hex.slice(1) : DEFAULT_DOT_COLOR.slice(1)
      const r = parseInt(value.slice(0, 2), 16) / 255
      const g = parseInt(value.slice(2, 4), 16) / 255
      const b = parseInt(value.slice(4, 6), 16) / 255
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const delta = max - min
      let h = 0
      if (delta !== 0) {
        if (max === r) h = ((g - b) / delta) % 6
        else if (max === g) h = (b - r) / delta + 2
        else h = (r - g) / delta + 4
        h *= 60
        if (h < 0) h += 360
      }
      return { h, s: max === 0 ? 0 : delta / max, v: max }
    }

    /** HSV -> `#RRGGBB`, clamped so pointer rounding can never overflow. */
    function hsvToHex(hsv) {
      const h = ((hsv.h % 360) + 360) % 360
      const s = Math.min(1, Math.max(0, hsv.s))
      const v = Math.min(1, Math.max(0, hsv.v))
      const sector = Math.floor(h / 60)
      const f = h / 60 - sector
      const p = v * (1 - s)
      const q = v * (1 - s * f)
      const t = v * (1 - s * (1 - f))
      const rgb = [
        [v, t, p],
        [q, v, p],
        [p, v, t],
        [p, q, v],
        [t, p, v],
        [v, p, q],
      ][sector % 6]
      const pair = (channel) =>
        Math.round(Math.min(1, Math.max(0, channel)) * 255)
          .toString(16)
          .padStart(2, '0')
      return `#${pair(rgb[0])}${pair(rgb[1])}${pair(rgb[2])}`
    }

    /**
     * A colour picker whose popup is ours: a saturation/value field, a hue
     * slider and a `#RRGGBB` box for any colour, quick presets, and a "follow
     * the theme" row — instead of the system colour dialog.
     *
     * @param props - `value` (empty means follow the theme), `onChange`, `disabled`.
     */
    function ColorPicker(props) {
      const [open, setOpen] = React.useState(false)
      const [opensUp, setOpensUp] = React.useState(false)
      const [hexText, setHexText] = React.useState('')
      const [hsv, setHsv] = React.useState(() => hexToHsv(props.value === '' ? DEFAULT_DOT_COLOR : props.value))
      const wrapRef = useDismiss(open, () => setOpen(false))
      const svRef = React.useRef(null)
      const hueRef = React.useRef(null)
      const hsvRef = React.useRef(hsv)
      hsvRef.current = hsv
      const follow = props.value === ''
      const usable = hexText === '' || HEX_COLOR.test(hexText.trim())

      // Follow changes made elsewhere: a preset, "follow the theme", or a save
      // that resets the draft.
      React.useEffect(() => {
        if (props.value !== '') setHsv(hexToHsv(props.value))
        setHexText(props.value)
      }, [props.value])

      const commit = (next) => {
        setHsv(next)
        props.onChange(hsvToHex(next))
      }

      const pick = (event, area) => {
        const node = area === 'hue' ? hueRef.current : svRef.current
        if (node === null) return
        const rect = node.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return
        const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
        if (area === 'hue') {
          commit({ ...hsvRef.current, h: x * 360 })
          return
        }
        const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
        commit({ ...hsvRef.current, s: x, v: 1 - y })
      }

      const drag = (event, area) => {
        event.preventDefault()
        pick(event, area)
        const move = (next) => pick(next, area)
        const stop = () => {
          document.removeEventListener('pointermove', move)
          document.removeEventListener('pointerup', stop)
        }
        document.addEventListener('pointermove', move)
        document.addEventListener('pointerup', stop)
      }

      const applyHex = () => {
        const text = hexText.trim()
        if (!HEX_COLOR.test(text)) {
          setHexText(props.value)
          return
        }
        commit(hexToHsv(text.toLowerCase()))
      }

      const toggle = () => {
        if (!open && wrapRef.current !== null) {
          const rect = wrapRef.current.getBoundingClientRect()
          setOpensUp(window.innerHeight - rect.bottom < 380)
          setHexText(props.value)
          if (props.value !== '') setHsv(hexToHsv(props.value))
        }
        setOpen((value) => !value)
      }

      return h(
        'div',
        { ref: wrapRef, style: S.popoverWrap },
        h(
          'button',
          {
            type: 'button',
            style: S.swatchTrigger,
            disabled: props.disabled,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': '选择提示颜色',
            onClick: toggle,
          },
          h('span', {
            style: follow
              ? {
                  ...S.swatchFill,
                  // Two halves of DSH's light/dark accents: "follow the theme".
                  background: `linear-gradient(135deg, ${DEFAULT_DOT_COLOR} 0 50%, #4176E6 50% 100%)`,
                }
              : { ...S.swatchFill, background: props.value },
          }),
        ),
        open
          ? h(
              'div',
              { role: 'dialog', style: { ...S.palette, ...(opensUp ? S.paletteUp : null) } },
              h(
                'div',
                {
                  ref: svRef,
                  style: {
                    ...S.sv,
                    background: `linear-gradient(to top, #000, rgba(0, 0, 0, 0)), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`,
                  },
                  onPointerDown: (event) => drag(event, 'sv'),
                },
                h('span', {
                  style: { ...S.svThumb, left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` },
                }),
              ),
              h(
                'div',
                { ref: hueRef, style: S.hue, onPointerDown: (event) => drag(event, 'hue') },
                h('span', { style: { ...S.hueThumb, left: `${(hsv.h / 360) * 100}%` } }),
              ),
              h(
                'div',
                { style: S.hexRow },
                h('span', { style: S.hexLabel }, 'HEX'),
                h('input', {
                  type: 'text',
                  value: hexText,
                  spellCheck: false,
                  disabled: props.disabled,
                  maxLength: 7,
                  placeholder: '#RRGGBB',
                  'aria-label': '颜色值',
                  style: { ...S.hexInput, ...(usable ? null : S.hexBad) },
                  onChange: (event) => setHexText(event.target.value),
                  onBlur: applyHex,
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      applyHex()
                    }
                  },
                }),
              ),
              h(
                'div',
                { style: { ...S.grid, marginTop: 10 } },
                DOT_COLORS.map((color) =>
                  h('button', {
                    key: color,
                    type: 'button',
                    role: 'option',
                    'aria-label': color,
                    'aria-selected': props.value === color,
                    style: { ...S.swatch, background: color, ...(props.value === color ? S.swatchOn : null) },
                    onClick: () => {
                      props.onChange(color)
                      setHsv(hexToHsv(color))
                      setOpen(false)
                    },
                  }),
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: S.paletteReset,
                  onClick: () => {
                    props.onChange('')
                    setOpen(false)
                  },
                },
                follow ? icon('M2.5 6.5 L5 9 L9.5 3.5') : null,
                '跟随主题',
              ),
            )
          : null,
      )
    }

    /** Server settings -> editable draft; the seconds stay text so typing is free. */
    function toDraft(settings) {
      if (settings === null) return null
      return {
        awayOnly: settings.awayOnly === true,
        themeMode: typeof settings.themeMode === 'string' ? settings.themeMode : 'auto',
        indicator: settings.indicator === 'dot' ? 'dot' : 'bar',
        dotColor: typeof settings.dotColor === 'string' ? settings.dotColor : '',
        testText: typeof settings.testText === 'string' ? settings.testText : '',
        sound: settings.sound !== false,
        timeout: String(settings.timeoutSeconds),
        focusedTimeout: String(settings.focusedTimeoutSeconds),
      }
    }

    /** Whether the draft would change anything once saved. */
    function changed(saved, draft) {
      return (
        draft.awayOnly !== saved.awayOnly ||
        draft.themeMode !== saved.themeMode ||
        draft.indicator !== saved.indicator ||
        draft.dotColor !== saved.dotColor ||
        draft.testText !== saved.testText ||
        draft.sound !== saved.sound ||
        Number(draft.timeout) !== saved.timeoutSeconds ||
        Number(draft.focusedTimeout) !== saved.focusedTimeoutSeconds
      )
    }

    /**
     * The page behind one row of the plugin detail page.
     *
     * Edits stay local until Save, so the number field can be typed freely and
     * a half-typed value never reaches the Host.
     *
     * @param props - `view` is 'page' for the full page and 'summary' for the
     *   one-line stand-in; the rest of the Host props are unused here.
     */
    function SettingsPanel(props) {
      const summaryOnly = props?.view === 'summary'
      const [saved, setSaved] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        call(SETTINGS_ROUTE).then(
          (body) => {
            if (!alive) return
            const next = body?.settings ?? null
            setSaved(next)
            setDraft(toDraft(next))
          },
          (failure) => {
            if (alive) setError(failure.message)
          },
        )
        return () => {
          alive = false
        }
      }, [])

      const summary =
        saved === null
          ? '右下角提醒：正在读取设置…'
          : `右下角提醒：${
              saved.awayOnly
                ? `只在离开 DSH 时弹 · ${saved.timeoutSeconds} 秒自动收起`
                : `总是弹 · 在 DSH 里 ${saved.focusedTimeoutSeconds} 秒 / 离开时 ${saved.timeoutSeconds} 秒自动收起`
            }`

      if (summaryOnly) return h('div', { style: S.mini }, summary)
      if (saved === null || draft === null) {
        return h('div', { style: error === '' ? S.mini : S.error }, error === '' ? '正在读取设置…' : error)
      }

      const dirty = changed(saved, draft)


      /** Apply a local edit; nothing is written until Save. */
      const edit = (change) => {
        setDraft((current) => (current === null ? current : { ...current, ...change }))
        setError('')
        setNotice('')
      }

      const save = () => {
        if (busy) return
        const seconds = Number(draft.timeout)
        const focusedSeconds = Number(draft.focusedTimeout)
        if (!Number.isInteger(seconds) || seconds < 15 || seconds > 7200) {
          setError('离开 DSH 时的收起秒数要是 15–7200 之间的整数。')
          setNotice('')
          return
        }
        if (!Number.isInteger(focusedSeconds) || focusedSeconds < 15 || focusedSeconds > 7200) {
          setError('DSH 在前台时的收起秒数要是 15–7200 之间的整数。')
          setNotice('')
          return
        }
        setBusy(true)
        setError('')
        setNotice('')
        call(SETTINGS_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            awayOnly: draft.awayOnly,
            themeMode: draft.themeMode,
            indicator: draft.indicator,
            dotColor: draft.dotColor,
            testText: draft.testText,
            sound: draft.sound,
            timeoutSeconds: seconds,
            focusedTimeoutSeconds: focusedSeconds,
          }),
        }).then(
          (body) => {
            const next = body?.settings ?? null
            if (next !== null) {
              setSaved(next)
              setDraft(toDraft(next))
            }
            setNotice('已保存，下一张卡片就按新设置显示。')
            setBusy(false)
          },
          (failure) => {
            setError(failure.message)
            setBusy(false)
          },
        )
      }

      const test = () => {
        if (busy) return
        setBusy(true)
        setError('')
        setNotice('')
        call(TEST_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ summary: draft.testText }),
        }).then(
          () => {
            setNotice('已发送，看看屏幕右下角。')
            setBusy(false)
          },
          (failure) => {
            setError(failure.message)
            setBusy(false)
          },
        )
      }

      const secondsField = (value, onInput) =>
        h('input', {
          type: 'number',
          min: 15,
          max: 7200,
          step: 1,
          value,
          disabled: busy,
          style: S.number,
          onChange: (event) => onInput(event.target.value),
        })

      return h(
        'div',
        { style: S.page },
        h(
          'div',
          { style: S.intro },
          '新回复、授权请求、提问与计划确认会在屏幕右下角弹一张卡片（离开 DSH 时必弹，DSH 就在前台时按下面的「提醒时机」决定）。这里决定它什么时候弹、停留多久、长什么样，保存在本机，保存后对下一张卡片生效；要彻底关掉提醒，用插件自己的开关。',
        ),

        h(
          FieldRow,
          {
            label: '提醒时机',
            tip: '「只有我不在 DSH 时」只在 DSH 不处于前台时弹；「总是提醒」在 DSH 就在前台时也弹，适合把 DSH 放在副屏的用户。',
          },
          h(
            'div',
            { style: S.column },
            h(
              'label',
              { style: S.choice },
              h('span', { style: S.mini }, '只有我不在 DSH 时'),
              h('input', {
                type: 'radio',
                name: 'dsh-message-notify-away',
                style: S.check,
                checked: draft.awayOnly,
                disabled: busy,
                onChange: () => edit({ awayOnly: true }),
              }),
            ),
            h(
              'label',
              { style: S.choice },
              h('span', { style: S.mini }, '总是提醒'),
              h('input', {
                type: 'radio',
                name: 'dsh-message-notify-away',
                style: S.check,
                checked: !draft.awayOnly,
                disabled: busy,
                onChange: () => edit({ awayOnly: false }),
              }),
            ),
          ),
        ),
        h(
          FieldRow,
          {
            label: '自动收起',
            tip: draft.awayOnly
              ? '不操作多久后自动收起，可设 15–7200 秒（最长 2 小时）。鼠标停在卡片上会暂停计时；切回 DSH 后 3 秒会自动收起。'
              : '两个时间都可设 15–7200 秒（最长 2 小时）：DSH 在前台时按上面那个收起，你离开后按下面那个。鼠标停在卡片上会暂停计时。',
          },
          draft.awayOnly
            ? h(
                'div',
                { style: S.line },
                secondsField(draft.timeout, (value) => edit({ timeout: value })),
                h('span', { style: S.mini }, '秒'),
              )
            : h(
                'div',
                { style: S.column },
                h(
                  'div',
                  { style: S.line },
                  h('span', { style: S.mini }, '在 DSH 里'),
                  secondsField(draft.focusedTimeout, (value) => edit({ focusedTimeout: value })),
                  h('span', { style: S.mini }, '秒'),
                ),
                h(
                  'div',
                  { style: S.line },
                  h('span', { style: S.mini }, '离开 DSH 时'),
                  secondsField(draft.timeout, (value) => edit({ timeout: value })),
                  h('span', { style: S.mini }, '秒'),
                ),
              ),
        ),
        h(
          FieldRow,
          {
            label: '提示样式',
            tip: '顶部中央横条（默认）或小标题旁的圆点；两种都用「提示颜色」呼吸。切换后下一张卡片生效。',
            flip: true,
          },
          h(Dropdown, {
            value: draft.indicator,
            disabled: busy,
            onChange: (value) => edit({ indicator: value }),
            options: [
              { value: 'bar', label: '顶部横条' },
              { value: 'dot', label: '标题旁圆点' },
            ],
          }),
        ),
        h(
          FieldRow,
          {
            label: '主题',
            tip: '「跟随 DSH 主题」读取 DSH 当前实际使用的深浅色；也可以固定成深色或浅色。',
            flip: true,
          },
          h(Dropdown, {
            value: draft.themeMode,
            disabled: busy,
            onChange: (value) => edit({ themeMode: value }),
            options: [
              { value: 'auto', label: '跟随 DSH 主题' },
              { value: 'dark', label: '深色' },
              { value: 'light', label: '浅色' },
            ],
          }),
        ),
        h(
          FieldRow,
          {
            label: '提示颜色',
            tip: '显示提示的呼吸强调色（顶部横条或标题旁圆点）；默认跟随主题（深色 #5686FE / 浅色 #4176E6）。也可以从预设里挑，或在色盘上拖、直接输入 #RRGGBB。',
            flip: true,
          },
          h(ColorPicker, {
            value: draft.dotColor,
            disabled: busy,
            onChange: (value) => edit({ dotColor: value }),
          }),
        ),
        h(
          FieldRow,
          {
            label: '提示音',
            tip: '卡片出现时播放 Windows 的「通知」提示音；关掉后静音。保存后下一张卡片生效，同一张卡片的替换不会重复响。',
            flip: true,
          },
          h(Dropdown, {
            value: draft.sound ? 'on' : 'off',
            disabled: busy,
            onChange: (value) => edit({ sound: value === 'on' }),
            options: [
              { value: 'on', label: '开启' },
              { value: 'off', label: '关闭' },
            ],
          }),
        ),
        h(
          FieldRow,
          {
            label: '测试正文',
            tip: '点「测试提醒」时，卡片正文显示这里的文字（最多 260 字）；留空则显示默认提示。没保存也会用当前输入。',
            flip: true,
          },
          h('input', {
            type: 'text',
            maxLength: 260,
            value: draft.testText,
            disabled: busy,
            placeholder: '输入测试卡片的正文',
            style: S.testText,
            onChange: (event) => edit({ testText: event.target.value }),
          }),
        ),
        h(
          'div',
          { style: S.actions },
          h(
            'button',
            {
              type: 'button',
              style: { ...S.button, ...(busy || !dirty ? S.primaryIdle : S.primary) },
              disabled: busy || !dirty,
              onClick: save,
            },
            busy ? '处理中…' : '保存',
          ),
          h('button', { type: 'button', style: S.button, disabled: busy, onClick: test }, '测试提醒'),
          error === '' ? null : h('span', { style: S.error }, error),
          error === '' && notice !== '' ? h('span', { style: S.notice }, notice) : null,
          error === '' && notice === '' && dirty ? h('span', { style: S.mini }, '有未保存的改动') : null,
        ),
      )
    }

    return {
      // `slots` carries the settings page; the palette report only uses optional
      // services through try/catch so it cannot block boot.
      inject: ['slots'],
      apply(ctx) {
        report(ctx)
        // A theme switch and a reconnected page both change which palette the
        // Host half should draw with. `on` is guarded because the palette report
        // must never be the reason this bundle fails to boot.
        if (typeof ctx.on === 'function') {
          ctx.effect(() => ctx.on('theme/change', () => report(ctx)))
          // A restarted or reconnected Host lost the last hint, so replay it.
          ctx.effect(() => ctx.on('connection/reset', () => { reported = ''; report(ctx) }))
        }
        ctx.effect(() =>
          ctx.slots.inject('plugins.row.config', () =>
            ctx.slots.register(
              { name: 'plugins.row.config', key: ROW_KEY, order: 40 },
              SettingsPanel,
            ),
          ),
        )
      },
    }
  },
})

/**
 * @dsh-external/dsh-codely-quota — client 悬浮「额度圈」（桌宠式）源码（TS）
 *
 * 运行态产物为 lib/client.js（手写 CJS，与本节同构）。本文件仅供在有完整 DSH 源码
 * checkout（DSH_CHECKOUT）的环境 `npm run build:client` 重建；逻辑如有出入以 lib/client.js 为准。
 *
 * 形态：右下角悬浮小圆环（类 dsh 上下文占用指示圈）：
 *   · 圆环 = 每日赠送额度【剩余比例】（>25% 绿 / 10-25% 琥珀 / <10% 红），中心显示百分比；
 *   · 单击 → 展开详情浮层（每日赠送/充值余额/套餐窗口/月度统计/速率），单击外部 / Esc 关闭；
 *   · 按住可拖拽换位置（localStorage 记忆）；
 *   · 代理没开就不启用：轮询 host /api/health，proxyUp=false 时整体隐藏，恢复后自动出现；
 *   · 🎨 主题自适应：跟随 dsh 全局主题（body[data-ds-dark-theme]），浅色白底黑字 / 深色深底浅字，
 *     MutationObserver 实时切换（自定义属性 --cqw-* 驱动全部样式）。
 */
export const inject = ['slots']

type Ctx = {
  effect(fn: () => void | (() => void), label?: string): void
  slots: {
    register(options: { name: string; id: string; order?: number }, component?: () => null): () => void
  }
}

const API = '/@dsh-external/dsh-codely-quota/api'
const POS_KEY = 'dsh-codely-quota.pos.v1'
const THEME_ATTR = 'data-ds-dark-theme'

/* ═══ 主题调色板（key 带 --cqw- 前缀，写为 wrapper 上的自定义属性） ═══ */
const THEME: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    '--cqw-surface': '#ffffff',
    '--cqw-fg': '#16161c',
    '--cqw-muted': '#72727c',
    '--cqw-card': '#f7f7fb',
    '--cqw-cardBorder': '#e7e7ee',
    '--cqw-panelBorder': '#e2e2e9',
    '--cqw-track': '#e9e9ee',
    '--cqw-btn': '#f3f3f7',
    '--cqw-btnBorder': '#d9d9e2',
    '--cqw-ball': '#ffffff',
    '--cqw-ballBorder': '#e4e4ec',
    '--cqw-ringTrack': '#e3e3ec',
    '--cqw-bannerBg': '#fdecec',
    '--cqw-bannerBorder': '#f0b6b9',
    '--cqw-bannerFg': '#c62828',
    '--cqw-shadow': 'rgba(0,0,0,.18)',
    '--cqw-tagNeutral': '#6b6b75',
  },
  dark: {
    '--cqw-surface': '#1d1d24',
    '--cqw-fg': '#e9e9ee',
    '--cqw-muted': '#9a9aa5',
    '--cqw-card': '#23232b',
    '--cqw-cardBorder': '#2f2f39',
    '--cqw-panelBorder': '#33333d',
    '--cqw-track': '#2b2b34',
    '--cqw-btn': '#2c2c35',
    '--cqw-btnBorder': '#3d3d48',
    '--cqw-ball': '#23232b',
    '--cqw-ballBorder': '#3a3a44',
    '--cqw-ringTrack': '#3a3a44',
    '--cqw-bannerBg': '#3a2326',
    '--cqw-bannerBorder': '#6e3b40',
    '--cqw-bannerFg': '#ffb3b6',
    '--cqw-shadow': 'rgba(0,0,0,.55)',
    '--cqw-tagNeutral': '#9d9da8',
  },
}

function isDarkTheme(): boolean {
  return !!document.body && document.body.hasAttribute(THEME_ATTR)
}

function applyThemeVars(w: HTMLElement): void {
  const map = isDarkTheme() ? THEME.dark : THEME.light
  for (const k of Object.keys(map)) {
    w.style.setProperty(k, map[k])
  }
}

const fmt = (v: unknown): string =>
  v == null ? '-' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
const pt = (v: unknown): string => String(v ?? '').slice(0, 19).replace('T', ' ')
const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c])
const usedPct = (used: unknown, quota: unknown): number => {
  const total = Number(quota)
  return total > 0 ? Math.min(100, Math.max(0, (Number(used) / total) * 100)) : 0
}
const bar = (p: number): string =>
  `<div style="height:5px;border-radius:3px;background:var(--cqw-track);overflow:hidden"><div style="height:100%;width:${Math.round(p)}%;background:var(--dsw-accent-color,#4f8cff);border-radius:3px;transition:width .3s"></div></div>`
const tag = (text: string, color: string): string =>
  `<span style="display:inline-block;padding:0 6px;border-radius:5px;font-size:10px;line-height:17px;color:${color};background:color-mix(in srgb,${color} 14%,transparent);border:1px solid color-mix(in srgb,${color} 34%,transparent)">${text}</span>`

const WIN_LABEL: Record<string, string> = {
  usage_5h: '5小时用量窗',
  subscription_week: '订阅周窗口',
  subscription_month: '订阅月窗口',
}

let activeDispose: (() => void) | null = null

/** shell.overlay 悬浮层条目（座席占位：保持注入器 slot 骨架契约）。球体本身直接挂 document.body，此条目渲染 null 不占视觉。 */
function NoopOverlayEntry(): null { return null }

export function apply(ctx: Ctx): void {
  ctx.effect(() => {
    if (activeDispose) { try { activeDispose() } catch { /* 忽略旧实例 */ } }
    activeDispose = buildPet()
    let unregister: (() => void) | null = null
    try {
      unregister = ctx.slots.register({ name: 'shell.overlay', id: 'codely-quota', order: 1e9 }, NoopOverlayEntry)
    } catch { /* slot 尚未声明时忽略——不影响球体挂载 */ }
    return () => {
      try { activeDispose?.() } catch { /* 忽略 */ }
      activeDispose = null
      try { unregister?.() } catch { /* 忽略 */ }
    }
  }, '@dsh-external/dsh-codely-quota: pet')
}

function buildPet(): () => void {
  const wrapper = document.createElement('div')
  wrapper.style.cssText =
    'position:fixed;z-index:2147483000;display:none;font-family:var(--dsw-font-ui,sans-serif);filter:drop-shadow(0 4px 14px var(--cqw-shadow))'
  applyThemeVars(wrapper)

  let pos: { left?: number; top?: number } | null = null
  try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null') } catch { pos = null }
  if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
    wrapper.style.left = pos.left + 'px'
    wrapper.style.top = pos.top + 'px'
  } else {
    wrapper.style.right = '18px'
    wrapper.style.bottom = '86px'
  }

  // 圆环按钮容器（无 title：悬停不弹原生气泡，点击展开才显示详情）
  const pet = document.createElement('div')
  pet.style.cssText =
    'width:38px;height:38px;cursor:pointer;border-radius:50%;background:var(--cqw-ball);border:1px solid var(--cqw-ballBorder);display:flex;align-items:center;justify-content:center;touch-action:none;user-select:none;-webkit-user-select:none'
  const R = 14
  const CIRC = 2 * Math.PI * R
  pet.innerHTML =
    `<svg width="36" height="36" viewBox="0 0 36 36" style="display:block">` +
    `<circle cx="18" cy="18" r="${R}" fill="none" stroke="var(--cqw-ringTrack)" stroke-width="3.5"/>` +
    `<circle data-cq="ring" cx="18" cy="18" r="${R}" fill="none" stroke="#4f8cff" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}" transform="rotate(-90 18 18)" style="transition:stroke-dashoffset .4s, stroke .3s"/>` +
    `<text data-cq="pct" x="18" y="18" text-anchor="middle" dominant-baseline="central" style="font-size:9px;font-weight:700;fill:var(--cqw-fg)">?</text>` +
    `</svg>`
  wrapper.appendChild(pet)

  const panel = document.createElement('div')
  panel.style.cssText =
    'display:none;position:absolute;right:0;bottom:calc(100% + 10px);width:344px;max-width:calc(100vw - 40px);max-height:min(70vh,560px);overflow:auto;border:1px solid var(--cqw-panelBorder);border-radius:12px;background:var(--cqw-surface);box-shadow:0 10px 40px var(--cqw-shadow);padding:12px 14px;font-size:12px;line-height:18px;color:var(--cqw-fg)'
  panel.innerHTML =
    `<div style="display:flex;align-items:center;gap:8px">` +
    `<span style="font-weight:700;font-size:13px">Codely 积分额度</span><span data-cq="plan"></span><span style="flex:1"></span>` +
    `<span data-cq="age" style="font-size:10px;color:var(--cqw-muted)"></span>` +
    `<button data-cq="refresh" style="background:var(--cqw-btn);color:var(--cqw-fg);border:1px solid var(--cqw-btnBorder);border-radius:6px;padding:1px 8px;font-size:11px;cursor:pointer">刷新</button>` +
    `</div>` +
    `<div data-cq="banner" style="display:none;margin-top:8px;border:1px solid var(--cqw-bannerBorder);background:var(--cqw-bannerBg);border-radius:8px;padding:6px 8px;font-size:11px;color:var(--cqw-bannerFg)"></div>` +
    `<div data-cq="body" style="display:grid;gap:8px;margin-top:10px"></div>` +
    `<div data-cq="foot" style="margin-top:10px;font-size:10px;color:var(--cqw-muted)"></div>`
  wrapper.appendChild(panel)
  document.body.appendChild(wrapper)

  let data: any = null
  let lastOk = 0
  let lastErr = ''
  let proxyOk = false
  let refreshMs = 30000
  let visible = false
  let panelOpen = false
  let disposed = false
  const timers: number[] = []

  const ring = wrapper.querySelector('[data-cq="ring"]')!
  const pctEl = wrapper.querySelector('[data-cq="pct"]')!
  const bodyEl = wrapper.querySelector<HTMLElement>('[data-cq="body"]')!
  const bannerEl = wrapper.querySelector<HTMLElement>('[data-cq="banner"]')!
  const footEl = wrapper.querySelector<HTMLElement>('[data-cq="foot"]')!
  const ageEl = wrapper.querySelector<HTMLElement>('[data-cq="age"]')!
  const planEl = wrapper.querySelector<HTMLElement>('[data-cq="plan"]')!
  const refreshBtn = wrapper.querySelector<HTMLButtonElement>('[data-cq="refresh"]')!

  function setRing(p: number, color: string, label: string): void {
    const off = CIRC - (CIRC * Math.max(0, Math.min(100, p))) / 100
    ring.setAttribute('stroke-dashoffset', String(off))
    ring.setAttribute('stroke', color)
    pctEl.textContent = label
  }
  function ringState(): void {
    if (!proxyOk) { setRing(0, '#6b6b76', '!'); return }
    if (!data) {
      if (lastErr) { setRing(0, '#e5484d', '!'); return }
      setRing(14, '#8b8b96', '…')
      return
    }
    const da = data.dailyAllowance
    if (da && Number(da.quota_points) > 0) {
      const remain = 100 - usedPct(da.used_points, da.quota_points)
      const color = remain > 25 ? '#36b37e' : remain > 10 ? '#d99a1c' : '#e5484d'
      setRing(remain, color, Math.round(remain) + '%')
      return
    }
    const eff = data.billing ? Number(data.billing.effective_available_points) : 0
    setRing(eff > 0 ? 100 : 0, '#4f8cff', eff > 0 ? '有' : '0')
  }

  function renderBody(): void {
    if (!data) {
      bodyEl.innerHTML = lastErr
        ? `<div style="color:var(--cqw-bannerFg);font-size:11px">${esc(lastErr)}</div>`
        : '<div style="color:var(--cqw-muted)">加载中…</div>'
      return
    }
    const plan: any = data.plan
    const da: any = data.dailyAllowance
    const bill: any = data.billing
    const cp: any = data.codingPlan
    const t: any = data.totals
    const g: any = data.giftCredits
    const ch: string[] = []

    planEl.innerHTML = plan && plan.plan_type !== 'free'
      ? tag('套餐·' + String(plan.plan_tag || plan.plan_type).toUpperCase(), '#4f8cff')
      : tag('免费版', 'var(--cqw-tagNeutral, #6b6b75)')

    if (da && Number(da.quota_points) > 0) {
      ch.push(
        `<div style="border:1px solid var(--cqw-cardBorder);border-radius:10px;padding:8px 10px;background:var(--cqw-card)">` +
        `<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--cqw-muted)"><span>每日赠送${da.quota_timezone ? '（' + da.quota_timezone + '）' : ''}</span><span data-cq="countdown"></span></div>` +
        `<div style="display:flex;align-items:baseline;gap:6px;margin:4px 0 6px"><span style="font-size:20px;font-weight:700;font-variant-numeric:tabular-nums">${fmt(da.remaining_points)}</span><span style="color:var(--cqw-muted);font-size:11px">/ 每日 ${fmt(da.quota_points)} 积分</span></div>` +
        bar(usedPct(da.used_points, da.quota_points)) +
        `<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--cqw-muted);margin-top:2px"><span>已用 ${fmt(da.used_points)}</span><span>窗口 ${pt(da.period_end_at)}</span></div>` +
        `</div>`)
    }
    let bal = ''
    if (bill) {
      bal += `<div style="display:flex;align-items:center;gap:6px"><span style="font-size:15px;font-weight:600;font-variant-numeric:tabular-nums">${fmt(bill.effective_available_points)}</span>` +
        (bill.is_exhausted ? tag('已耗尽', '#e5b94c') : '') +
        `<span style="font-size:11px;color:var(--cqw-muted)">充值积分</span>` +
        (Number(bill.recharged_points) ? `<span style="font-size:10px;color:var(--cqw-muted)">累计 ${fmt(bill.recharged_points)}</span>` : '') +
        `</div>`
    }
    if (g && g.remaining_points != null) {
      bal += `<div style="font-size:11px"><span style="color:#8ab949">赠送</span> ${fmt(g.remaining_points)}${g.expirations?.length ? '，' + g.expirations.length + ' 笔待到期' : ''}</div>`
    }
    if (bal) ch.push(`<div style="border:1px solid var(--cqw-cardBorder);border-radius:10px;padding:8px 10px;background:var(--cqw-card)">${bal}</div>`)

    let wr = ''
    if (cp?.found && Array.isArray(cp.windows) && cp.windows.length) {
      for (const w of cp.windows) {
        const label = WIN_LABEL[w.window_type] || w.window_type
        wr += `<div style="margin-bottom:6px"><div style="display:flex;justify-content:space-between;font-size:11px"><span>${label}${w.exhausted ? tag('用尽', '#e5484d') : ''}</span><span>剩 <b>${fmt(w.remaining_points)}</b> / ${fmt(w.quota_points)}</span></div>` +
          bar(usedPct(w.used_points, w.quota_points)) +
          `<div style="font-size:10px;color:var(--cqw-muted);margin-top:1px">已用 ${fmt(w.used_points)}${w.next_boundary_at ? ' · 下次刷新 ' + pt(w.next_boundary_at) : ''}</div></div>`
      }
    } else if (cp && !cp.found) {
      wr = '<div style="font-size:11px;color:var(--cqw-muted)">无订阅套餐窗口（免费版）。付费后显示 <b>5小时 / 周 / 月</b> 用量窗。</div>'
    }
    if (wr) ch.push(`<div style="border:1px solid var(--cqw-cardBorder);border-radius:10px;padding:8px 10px;background:var(--cqw-card)"><div style="font-size:11px;color:var(--cqw-muted);margin-bottom:4px">套餐窗口限额</div>${wr}</div>`)

    if (t) {
      const period = data.period || {}
      ch.push(
        `<div style="border:1px solid var(--cqw-cardBorder);border-radius:10px;padding:8px 10px;background:var(--cqw-card)">` +
        `<div style="font-size:11px;color:var(--cqw-muted);margin-bottom:4px">本月 ${period.start_date || '?'} ~ ${period.end_date || '?'}</div>` +
        `<div style="display:flex;gap:14px;flex-wrap:wrap">` +
        `<div><b style="font-size:14px;font-variant-numeric:tabular-nums">${fmt(t.recorded_points)}</b><div style="font-size:10px;color:var(--cqw-muted)">消耗积分</div></div>` +
        `<div><b style="font-size:14px;font-variant-numeric:tabular-nums">${fmt(t.settlement_count)}</b><div style="font-size:10px;color:var(--cqw-muted)">结算次数</div></div>` +
        `<div><b style="font-size:14px;font-variant-numeric:tabular-nums">${fmt((t.prompt_tokens || 0) + (t.completion_tokens || 0))}</b><div style="font-size:10px;color:var(--cqw-muted)">总令牌</div></div>` +
        `</div></div>`)
    }
    bodyEl.innerHTML = ch.join('') || '<div style="color:var(--cqw-muted);font-size:11px">暂无数据</div>'
    if (lastErr) {
      bannerEl.style.display = 'block'
      bannerEl.innerHTML = `<b>注意：</b>${esc(lastErr)}`
    } else bannerEl.style.display = 'none'
    const rl = data.rateLimit
    footEl.textContent = (rl?.rpm_limit != null ? '速率 ' + rl.rpm_limit + ' RPM · ' : '') + pt(data.fetchedAt) + ' 更新 · 按住圆环可拖动'
  }

  function tick(): void {
    if (!proxyOk) return
    if (lastOk) ageEl.textContent = Math.max(0, Math.round((Date.now() - lastOk) / 1000)) + 's 前'
    const da = data?.dailyAllowance
    const node = wrapper.querySelector('[data-cq="countdown"]')
    if (da?.period_end_at && node) {
      const ms = new Date(da.period_end_at).getTime() - Date.now()
      if (ms > 0) {
        const hh = Math.floor(ms / 3600000), mm = Math.floor((ms % 3600000) / 60000), ss = Math.floor((ms % 60000) / 1000)
        node.textContent = `距重置 ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
      } else node.textContent = '窗口到期'
    }
  }

  function setVisible(v: boolean): void {
    if (visible === v) return
    visible = v
    wrapper.style.display = v ? 'block' : 'none'
    if (!v) closePanel()
  }
  function closePanel(): void { panelOpen = false; panel.style.display = 'none' }
  function togglePanel(): void { panelOpen ? closePanel() : openPanel() }
  function openPanel(): void {
    panelOpen = true
    panel.style.display = 'block'
    renderBody()
    tick()
  }

  function refreshQuota(force: boolean): Promise<void> {
    refreshBtn.disabled = true
    return fetch(API + '/quota' + (force ? '?force=1' : ''), { cache: 'no-store' })
      .then((r) => r.json().catch(() => null))
      .then((j: any) => {
        if (!j || !j.ok) throw new Error(j?.error || 'HTTP ?')
        data = j.data
        lastOk = Date.now()
        lastErr = ''
        ringState()
        if (panelOpen) { renderBody(); tick() }
      })
      .catch((e: any) => {
        lastErr = String((e && e.message) || e)
        if (panelOpen) renderBody()
      })
      .finally(() => { refreshBtn.disabled = false })
  }

  function checkHealth(): Promise<void> {
    return fetch(API + '/health', { cache: 'no-store' })
      .then((r) => r.json().catch(() => null))
      .then((j: any) => {
        proxyOk = !!(j && j.proxyUp)
        if (j?.refreshMs) refreshMs = Number(j.refreshMs) || 30000
      })
      .catch(() => { proxyOk = false })
      .then(() => {
        setVisible(proxyOk)
        if (proxyOk) {
          ringState()
          tick()
          if (!data) return refreshQuota(false)
        } else {
          data = null
          lastOk = 0
          lastErr = '本地代理未启动（codely-dsh-bridge），额度圈暂停显示'
        }
        return undefined
      })
  }

  /* 交互 */
  pet.addEventListener('click', (e) => { e.stopPropagation(); togglePanel() })
  function onDocClick(e: MouseEvent): void { if (panelOpen && !wrapper.contains(e.target as Node)) closePanel() }
  document.addEventListener('click', onDocClick, true)
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel() })

  let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0
  pet.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    moved = false
    dragging = true
    sx = e.clientX; sy = e.clientY
    const rect = wrapper.getBoundingClientRect()
    ox = rect.left; oy = rect.top
    pet.setPointerCapture?.(e.pointerId)
  })
  pet.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const dx = e.clientX - sx, dy = e.clientY - sy
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true
    if (moved) {
      wrapper.style.left = ox + dx + 'px'
      wrapper.style.top = oy + dy + 'px'
      wrapper.style.right = 'auto'
      wrapper.style.bottom = 'auto'
    }
  })
  const endDrag = (e: PointerEvent): void => {
    if (!dragging) return
    dragging = false
    if (moved) {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({ left: ox + (e.clientX - sx), top: oy + (e.clientY - sy) }))
      } catch { /* 忽略 */ }
    }
  }
  pet.addEventListener('pointerup', endDrag)
  pet.addEventListener('pointercancel', endDrag)
  refreshBtn.addEventListener('click', (e) => { e.stopPropagation(); void refreshQuota(true) })

  /* 主题跟随：dsh 切换主题（body[data-ds-dark-theme]）时实时换肤 */
  let themeObserver: MutationObserver | null = null
  if (typeof MutationObserver !== 'undefined' && document.body) {
    themeObserver = new MutationObserver(() => { applyThemeVars(wrapper) })
    themeObserver.observe(document.body, { attributes: true, attributeFilter: [THEME_ATTR] })
  }

  timers.push(window.setInterval(() => { void checkHealth() }, 15000))
  timers.push(window.setInterval(() => { if (proxyOk && !document.hidden) void refreshQuota(false) }, refreshMs))
  timers.push(window.setInterval(() => { tick() }, 1000))
  void checkHealth()

  return () => {
    if (disposed) return
    disposed = true
    timers.forEach((t) => clearInterval(t))
    themeObserver?.disconnect()
    document.removeEventListener('click', onDocClick, true)
    if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper)
  }
}
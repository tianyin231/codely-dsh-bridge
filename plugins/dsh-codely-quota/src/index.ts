/**
 * @dsh-external/dsh-codely-quota — 积分额度混合插件（host 侧）
 *
 * 职责：
 *   1. webServer 前缀路由 /@dsh-external/dsh-codely-quota/api：
 *        GET /quota  → 经本地 codely-dsh-bridge 代理取积分额度快照（带 host 侧短缓存）
 *        GET /health → 本地代理连通性
 *   2. toolkit 工具 codely_quota：agent 在会话里直接查余额（文本摘要）
 *
 * 数据源：本地代理 http://127.0.0.1:8790/quota（codely-dsh-bridge 项目）。
 * 面板数据流：client 面板（conversation.view「额度」tab）→ 同源 fetch 上面路由 → 代理 → Codely 官网。
 * 资源全部挂 ctx.effect（热重载/卸载自动清理）。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'

export const name = "@dsh-external/dsh-codely-quota"
export const inject = ['tools', 'webServer']

export interface Config {
  /** 本地 codely-dsh-bridge 代理地址（README：npm start 默认 8790） */
  proxyBaseURL: string
  /** host 侧快照缓存毫秒（多客户端共享，避免打爆官网接口；面板里点“刷新”可穿透） */
  cacheMs: number
  /** 面板自动刷新间隔（毫秒，client 读取） */
  refreshMs: number
}

export const Config = z.object({
  proxyBaseURL: z.string().default('http://127.0.0.1:8790'),
  cacheMs: z.number().min(1000).default(10000),
  refreshMs: z.number().min(5000).default(30000),
})

type AppContext = Context & {
  tools: any
  webServer: {
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: any, res: any) => void | Promise<void> }): () => void
  }
}

const API_PREFIX = '/' + name + '/api'

/** host 侧积分快照缓存（内存级，按 TTL 老化；force=1 可穿透） */
let cache: { ts: number; value: any } = { ts: 0, value: null }

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(ms) })
}

/**
 * 取积分快照：本地代理 /quota → 归一化 JSON。
 * 代理不可达/未登录时抛错，错误文案直接给用户看（面板/工具共用）。
 */
async function fetchQuotaSnapshot(cfg: Config, force = false): Promise<any> {
  const now = Date.now()
  if (!force && cache.value && now - cache.ts < cfg.cacheMs) return cache.value

  const base = cfg.proxyBaseURL.replace(/\/+$/, '')
  const r = await fetchWithTimeout(`${base}/quota${force ? '?force=1' : ''}`, 10000)
  let j: any = null
  try { j = await r.json() } catch { /* fallthrough */ }
  if (!r.ok || !j?.ok) {
    throw new Error(`本地代理返回异常（HTTP ${r.status}）：${j?.error || r.statusText || '未知'}。请确认已运行 codely-dsh-bridge 的 npm start（且已 npm run login）`)
  }
  cache = { ts: Date.now(), value: j.data }
  return j.data
}

function json(res: any, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

const L = (v: unknown): string => (v == null ? '-' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 }))
const pt = (v: unknown): string => String(v ?? '').slice(0, 19).replace('T', ' ')

/** 快照 → 会话友好的文本摘要（agent 工具结果） */
function summarize(data: any): string {
  if (!data) return '（无数据）'
  const plan = data.plan?.plan_type ?? 'unknown'
  const da = data.dailyAllowance
  const bill = data.billing
  const cp = data.codingPlan
  const lines: string[] = []
  lines.push(`Codely 积分额度（${plan === 'free' ? '免费版' : '套餐 ' + plan}，更新于 ${pt(data.fetchedAt)}）`)
  if (da?.quota_points) {
    lines.push(`每日赠送：剩余 ${L(da.remaining_points)} / ${L(da.quota_points)}，已用 ${L(da.used_points)}（${da.quota_timezone || 'Asia/Shanghai'} 日窗口，重置于 ${pt(da.period_end_at)}）`)
  }
  if (bill) {
    lines.push(`充值积分余额：${L(bill.effective_available_points)}${bill.is_exhausted ? '（已耗尽）' : ''}${Number(bill.recharged_points) ? '，累计充值 ' + L(bill.recharged_points) : ''}`)
  }
  if (cp?.found && Array.isArray(cp.windows)) {
    for (const w of cp.windows) {
      const label = w.window_type === 'usage_5h' ? '5小时用量窗' : w.window_type === 'subscription_week' ? '订阅周' : w.window_type === 'subscription_month' ? '订阅月' : w.window_type
      lines.push(`窗口[${label}]：剩余 ${L(w.remaining_points)} / ${L(w.quota_points)}，已用 ${L(w.used_points)}${w.exhausted ? '（已耗尽）' : ''}${w.next_boundary_at ? '，下次刷新 ' + pt(w.next_boundary_at) : ''}`)
    }
  } else if (cp && !cp.found) {
    lines.push('套餐窗口：当前无订阅套餐（付费后此处将显示 5小时/周/月 用量窗口）')
  }
  const t = data.totals
  if (t) {
    lines.push(`本月（${data.period?.start_date || '?'} ~ ${data.period?.end_date || '?'}）：消耗 ${L(t.recorded_points)} 积分 / ${L(t.settlement_count)} 次结算；令牌 ${L(t.prompt_tokens)} in + ${L(t.completion_tokens)} out`)
  }
  const rl = data.rateLimit
  if (rl) lines.push(`网关速率限制：${rl.rpm_limit ?? '?'} RPM${rl.tpm_limit ? ' / ' + L(rl.tpm_limit) + ' TPM' : ''}`)
  return lines.join('\n')
}

async function proxyHealth(cfg: Config): Promise<boolean> {
  try {
    const r = await fetchWithTimeout(`${cfg.proxyBaseURL.replace(/\/+$/, '')}/healthz`, 3000)
    return r.ok
  } catch { return false }
}

export function apply(ctx: AppContext, config: Config): void {
  // ── host API：client 面板消费（同源，无 CORS） ──
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req: any, res: any) => {
      const u = new URL(req.url ?? '/', 'http://localhost')
      const action = u.pathname.replace(API_PREFIX, '').replace(/^\/+/, '') || '/'
      try {
        if (action === '/' || action === 'quota') {
          const force = u.searchParams.get('force') === '1'
          const data = await fetchQuotaSnapshot(config, force)
          json(res, 200, { ok: true, fetchedAt: data.fetchedAt, data })
        } else if (action === 'health') {
          const up = await proxyHealth(config)
          json(res, 200, { ok: up, proxyUp: up, proxyBaseURL: config.proxyBaseURL, refreshMs: config.refreshMs })
        } else {
          json(res, 404, { ok: false, error: 'unknown action: ' + action })
        }
      } catch (e: any) {
        json(res, 502, { ok: false, error: String(e?.message || e) })
      }
    },
  }), name + ': api')

  // ── toolkit 工具：codely_quota（会话内查余额） ──
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'codely_quota',
    description: '查询 Codely 账号当前积分余额（每日赠送/充值余额/订阅窗口/月度统计）',
    parameters: {
      force: { type: 'boolean', description: '跳过缓存强制刷新' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { force?: boolean }) {
      try {
        return summarize(await fetchQuotaSnapshot(config, !!args?.force))
      } catch (e: any) {
        return '查询失败：' + String(e?.message || e)
      }
    },
  })), name + ': tool')

  ctx.logger?.info?.('[' + name + '] 已就绪：API ' + API_PREFIX + '，工具 codely_quota，代理 ' + config.proxyBaseURL)
}
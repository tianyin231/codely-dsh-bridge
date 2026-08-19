/**
 * codely-dsh-bridge — 积分余额查询（共享模块）
 *
 * Codely 账号的「积分（点）」体系（逆向自官方网页端 2026-08，接口见 docs/PROTOCOL.md §7）：
 *   · 每日赠送额度  GET /api/user/billing/usage/summary → daily_allowance
 *       （免费/基础档每日刷新，如 10000 积分/天，每天 0 点 Asia/Shanghai 重置）
 *   · 充值积分余额  GET .../usage/summary → billing.effective_available_points
 *   · 套餐窗口限额  GET .../usage/summary → coding_plan.windows[]
 *       （付费 codely coding plan，窗口类型：usage_5h（5小时用量窗）/ subscription_week（订阅周）/
 *         subscription_month（订阅月），每个窗口有 quota/used/remaining/exhausted/next_boundary_at）
 *   · 月度/累计统计  GET .../usage/summary → totals / lifetime / daily
 *   · 套餐类型       GET /api/user/plan
 *   · 网关速率限制   GET https://codely-litellm.tuanjie.cn/key/info（sk- 密钥，best-effort）
 *
 * 本模块只负责「拉取 + 短缓存 + 归一化」，供：
 *   · codely-proxy.js 的 GET /quota 端点（插件/人工查询）
 *   · dsh-codely-quota 插件 host（经本地代理消费）
 */
'use strict';

const auth = require('./codely-auth');

const CACHE_TTL_MS = 15 * 1000; // 15s 缓存，避免高频轮询打爆官网

let cache = { ts: 0, data: null };

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 网关 /key/info（sk- 密钥的速率限制与累计消费；失败静默，不影响主流程） */
async function fetchKeyInfo(apiKey) {
  try {
    const j = await fetchJson(`https://${auth.LITELLM_HOST}/key/info`, {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    });
    const info = j?.info;
    if (!info) return null;
    return {
      rpm_limit: info.rpm_limit ?? null,
      tpm_limit: info.tpm_limit ?? null,
      max_parallel_requests: info.max_parallel_requests ?? null,
      spend: info.spend ?? null, // LiteLLM 计费口径（含小数点后 6 位），仅参考口径
      budget_duration: info.budget_duration ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * 抓取一次完整的积分额度快照（带 15s 内存缓存）。
 * @param {object} [o]
 * @param {boolean} [o.force] 跳过缓存强制刷新
 * @returns {Promise<object>} 归一化快照：
 *   { fetchedAt, organization, plan, billing, dailyAllowance, giftCredits, codingPlan,
 *     period, totals, lifetime, rateLimit }
 * 取不到凭据/网络失败会抛错（错误文案面向终端：提示 npm run login / npm start）。
 */
async function fetchQuotaSnapshot({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.data && now - cache.ts < CACHE_TTL_MS) return cache.data;

  const creds = await auth.getAccessToken(); // 失败会抛「请先 npm run login」
  const base = auth.BASE;
  const headers = { Authorization: `Bearer ${creds.access_token}`, Accept: 'application/json' };

  const call = async (path) => {
    try {
      return await fetchJson(base + path, headers);
    } catch (e) {
      // 401/403：access_token 过期 → 刷新一次再试（与 codely-auth 惯例一致）
      if (e.message === 'HTTP 401' || e.message === 'HTTP 403') {
        const t = await auth.refreshAccessToken();
        return fetchJson(base + path, { ...headers, Authorization: `Bearer ${t}` });
      }
      throw e;
    }
  };

  const [summary, plan, apiKey, keyInfo] = await Promise.all([
    call('/api/user/billing/usage/summary'),
    call('/api/user/plan').catch(() => null),
    auth.fetchApiKey(creds).catch(() => null),
    Promise.resolve(null), // 占位，下面单独算（fetchApiKey 结果依赖）
  ]);

  // keyInfo 依赖 apiKey，拆开拉取；失败不影响主数据
  let rateLimit = null;
  if (apiKey) {
    try { rateLimit = await fetchKeyInfo(apiKey); } catch { /* 静默 */ }
  }

  const snapshot = {
    fetchedAt: new Date().toISOString(),
    organization: summary?.organization ?? null,
    plan: plan ? {
      plan_type: plan.plan_type ?? 'unknown',
      plan_tag: plan.plan_tag ?? '',
      is_team_plan: !!plan.is_team_plan,
      is_active: !!plan.is_active,
      can_upgrade: !!plan.can_upgrade,
    } : null,
    billing: summary?.billing ?? null,
    dailyAllowance: summary?.daily_allowance ?? null,
    giftCredits: summary?.gift_credits ?? null,
    codingPlan: summary?.coding_plan ?? null,
    period: summary?.period ?? null,
    totals: summary?.totals ?? null,
    lifetime: summary?.lifetime ?? null,
    rateLimit,
  };
  cache = { ts: Date.now(), data: snapshot };
  return snapshot;
}

/** 清空缓存（如登录态切换后） */
function clearQuotaCache() { cache = { ts: 0, data: null }; }

/* CLI：node codely-quota.js [--force] —— 终端直接查积分余额 */
async function main() {
  const force = process.argv.includes('--force');
  const snap = await fetchQuotaSnapshot({ force });
  const pct = (u, q) => (Number(q) > 0 ? ((Number(u) / Number(q)) * 100).toFixed(1) : '-');
  const plan = snap.plan?.plan_type === 'free' ? '免费版' : `套餐 ${snap.plan?.plan_type || '?'}`;
  console.log(`Codely 积分额度（${plan}，更新于 ${snap.fetchedAt}）`);
  const da = snap.dailyAllowance;
  if (da?.quota_points) {
    console.log(`每日赠送  剩余 ${Number(da.remaining_points).toFixed(2)} / ${Number(da.quota_points).toFixed(0)}（已用 ${Number(da.used_points).toFixed(2)}，${pct(da.used_points, da.quota_points)}%，窗口 ${da.period_start_at} ~ ${da.period_end_at}）`);
  }
  console.log(`充值余额  ${Number(snap.billing?.effective_available_points ?? 0).toFixed(0)}${snap.billing?.is_exhausted ? '（已耗尽）' : ''}${Number(snap.billing?.recharged_points) ? `，累计充值 ${snap.billing?.recharged_points}` : ''}`);
  const cp = snap.codingPlan;
  if (cp?.found) {
    for (const w of cp.windows || []) console.log(`窗口[${w.window_type}]  剩余 ${w.remaining_points} / ${w.quota_points}${w.exhausted ? '（已耗尽）' : ''}${w.next_boundary_at ? '，下次刷新 ' + w.next_boundary_at : ''}`);
  } else if (cp && !cp.found) {
    console.log('套餐窗口  无订阅套餐（付费后显示 5小时/周/月 用量窗口）');
  }
  const t = snap.totals;
  if (t) console.log(`本月统计  消耗 ${t.recorded_points.toFixed(2)} 积分 / ${t.settlement_count} 次结算 / ${Math.round(t.prompt_tokens + t.completion_tokens)} 令牌`);
  if (snap.rateLimit) console.log(`速率限制  ${snap.rateLimit.rpm_limit || '?'} RPM`);
}

module.exports = { fetchQuotaSnapshot, clearQuotaCache, CACHE_TTL_MS };
if (require.main === module) main().catch((e) => { console.error('查询失败:', e.message); process.exit(1); });
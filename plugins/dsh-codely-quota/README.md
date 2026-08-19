# dsh-codely-quota — Codely 积分额度悬浮圈

dsh 插件（hybrid 形态）：在 dsh web 里放一个**右下角悬浮小圆环**（类似 dsh 的上下文占用指示圈），
一眼看到每日额度剩余比例，**点击展开**各积分详情；还带一个 `codely_quota` 工具随时查询。

- **圆环**：每日赠送额度剩余比例（>25% 绿 / 10-25% 琥珀 / <10% 红），中心显示百分比；
  无每日赠送时退化为充值余额的「有/0」指示。
- **单击**展开浮层：每日赠送（含**距每日重置倒计时**）/ 充值余额 / 套餐窗口 / 本月统计 / 速率限制；
  点外部或 Esc 关闭；浮层内「刷新」按钮强制刷新。
- **可拖拽**：按住圆环拖动换位置（localStorage 记忆，无需配置）。
- **代理没开就不启用**：持续轮询 host `/api/health`；本地代理（`npm start`）不在线时整个隐藏，
  恢复后自动出现——不开桥接就看不到它。

## 数据源

不直连官网鉴权，而是走 **codely-dsh-bridge 本地代理**（同一份登录态）：

```
悬浮圈(浏览器)  →  插件 host API（/…/codely-quota/api）  →  本地代理 GET /quota  →  Codely 官网 usage/summary
   /health 15s、/quota 30s        cacheMs 短缓存             15s 缓存              access_token 自动续期
```

- 代理未启动 → 圈圈隐藏；启动后自动出现并加载数据。
- 代理在跑但登录失效 → 圈圈变灰显「!」，展开浮层给红色提示（`npm run login`）。
- 需要本地代理运行 `codely-dsh-bridge` 的 `npm start`（默认 `http://127.0.0.1:8790`）。

## 展示内容（点击展开）

| 区块 | 内容 |
|---|---|
| 每日赠送 | 剩余/额度/进度条 + 距每日重置（0 点 Asia/Shanghai）实时倒计时 |
| 积分账户 | 充值积分余额、累计充值、赠送积分、可申请赠送提示 |
| 套餐窗口限额 | 付费套餐的 `usage_5h`（5小时用量窗）/ `subscription_week`（周）/ `subscription_month`（月）窗口：额度/已用/剩余/下次刷新；免费号显示提示文案 |
| 本月统计 | 当月消耗积分/结算/令牌 + 网关速率限制 |

## agent 工具

- `codely_quota`：返回余额摘要文本（参数 `force` 可选，跳过缓存强制刷新）。
- 工具 schema 保持精简，避免膨胀首轮预填充。

## 配置（cordis Config）

| 键 | 默认 | 说明 |
|---|---|---|
| `proxyBaseURL` | `http://127.0.0.1:8790` | 本地代理地址（与 `npm start -- --port` 一致） |
| `cacheMs` | `10000` | host 侧快照缓存（毫秒） |
| `refreshMs` | `30000` | 悬浮圈自动刷新间隔（毫秒） |

## 注入与迭代

```bash
# 注入（dsh-super-injector，免重启；重启后由注入清单自动恢复）
dev_inject_plugin {"dir": "<本插件绝对路径>"}

# 改代码后重载
dev_reload_package {"packageName": "dsh-codely-quota"}

# 卸载即净
dev_uninject_plugin {"match": "dsh-codely-quota"}
```

> 本包 `lib/index.js`（host）与 `lib/client.js`（面板）为**直接可部署产物**（手写 ESM/CJS，无构建链依赖）；
> `src/` 下保留同逻辑的 TypeScript 源码（含校验用 tsconfig/tsdown 配置），在有完整 DSH 源码 checkout
> （设置了 `DSH_CHECKOUT`）的环境中可跑 `npm run build` + `npm run build:client` 重新生成。
> 运行时依赖经包自身 `node_modules` junction 解析（`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`）。

## 接口（host webServer 路由）

前缀：`/@dsh-external/dsh-codely-quota/api`

| 路径 | 说明 |
|---|---|
| `GET /quota` | 积分快照 JSON（`?force=1` 穿透缓存） |
| `GET /health` | `{proxyUp, proxyBaseURL, refreshMs}` 连通性/配置 |

## 风险提示

- 积分数据来自官网计费接口，结算有延迟（按日/按次），面板数值可能滞后几小时。
- 面板/工具均只读，不产生任何调用计费。
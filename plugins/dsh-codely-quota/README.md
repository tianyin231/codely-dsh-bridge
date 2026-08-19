# dsh-codely-quota — Codely 积分额度悬浮圈

dsh 插件（hybrid 形态）：在 dsh web 里放一个**右下角悬浮小圆环**（类似 dsh 的上下文占用指示圈），
一眼看到每日额度剩余比例，**点击展开**各积分详情；还带一个 `codely_quota` 工具随时查询。
- **注意**：如果先开启dsh后开启代理，额度显示无显示，请刷新面板；
- **圆环**：每日赠送额度剩余比例（>25% 绿 / 10-25% 琥珀 / <10% 红），中心显示百分比；
  无每日赠送时退化为充值余额的「有/0」指示。
- **单击**展开浮层：每日赠送（含**距每日重置倒计时**）/ 充值余额 / 套餐窗口 / 本月统计 / 速率限制；
  点外部或 Esc 关闭；浮层内「刷新」按钮强制刷新。
- **可拖拽**：按住圆环拖动换位置（localStorage 记忆，无需配置）。
- **代理没开就不启用**：持续轮询 host `/api/health`；本地代理（`npm start`）不在线时整个隐藏，
  恢复后自动出现——不开桥接就看不到它。
- **🎨 主题自适应**：跟随 dsh 全局主题（`body[data-ds-dark-theme]`）——浅色＝白底黑字，深色＝深底浅字；
  切主题由 MutationObserver 实时换肤，无需刷新。所有配色收敛为 `--cqw-*` 自定义属性，想微调改 `THEME` 常量即可。

## 多账号切换（小球内一键丝滑切换）

展开浮层顶部有一条**账号行**：显示当前账号名，多账号时出现**下拉选择器**。切换即「丝滑」生效：
换凭据 + 换密钥 + 清配额缓存 + 自动重探模型映射（`~/.dsh/settings.yaml` 按新账号权限刷新），**全程无需重启任何进程**。

**添加新账号**：点账号行右侧的 **「+」** —— 直接发起设备码登录并给出**验证链接（可一键复制）+ 用户码**。
授权完成后自动保存凭据并切换过去，圆环平滑过渡到新账号额度。

> ⚠️ **授权跟随浏览器会话**：官方授权页（Unity ID）会把设备码授权给**打开链接的那个浏览器会话**，
> 没有「切换账号」按钮。**不要在主浏览器直接打开**——已登录的会话会瞬间授权当前账号并消耗设备码
> （无痕里再打开会提示 "no longer pending"）。正确姿势：**复制链接 → 无痕窗口/另一浏览器打开 → 登录
> 另一个 Unity 账号 → 授权**。若误在主浏览器打开授权了当前账号，面板会明确提示而不是假装成功；
> 已保存的不同账号之间（小球下拉 / CLI `switch`）随时丝滑切换。

```
小球「+」  →  插件 host POST /api/account/login/start → 本地代理 → 发起设备码（不自动弹窗）
             （复制链接到无痕/另一浏览器授权 → 轮询 /status → 同账号识别/自动保存 accounts/ + 激活 + 重探模型）
```

```
小球(下拉选择)  →  插件 host POST /api/account/switch  →  本地代理 POST /account/switch
                    →  换 accounts/<name>.json → codely-creds.json + 换 sk- 密钥 + 清缓存 + 重探模型
```

- 账号由 `codely-dsh-bridge` 的多账号注册表管理：`npm run account -- list / switch <name> / login [name] / remove <name>`。
- 页面开着、别人用 CLI 切了账号：小球会在 15s 健康轮询 / 每次额度刷新时自动跟上当前账号显示。

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

> 一键装配：**`npm run setup`（codely-dsh-bridge 根目录）已自动把本插件装进 dsh profile**
> （dependencies `link:` + bundles），dsh 启动即加载——换机器重跑 setup 即自动完成。以下为手动/开发方式：

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
| `GET /quota` | 积分快照 JSON（`?force=1` 穿透缓存），含 `data.account` 当前账号信息 |
| `GET /health` | `{proxyUp, proxyBaseURL, refreshMs, account}` 连通性/配置 |
| `GET /accounts` | 已登录账号列表（`{current, account, list[]}`） |
| `POST /account/switch?name=<账号>` | 切换到指定账号（同 CLI `npm run account -- switch`，免重启） |
| `POST /account/login/start` | 发起设备码登录（返回验证链接+用户码；不自动弹窗，由客户端引导复制到无痕/另一浏览器授权） |
| `GET /account/login/status` | 轮询授权状态；`authorized` 时已自动保存账号并激活 |
| `POST /account/login/cancel` | 取消进行中的登录 |

## 风险提示

- 积分数据来自官网计费接口，结算有延迟（按日/按次），面板数值可能滞后几小时。
- 面板/工具均只读，不产生任何调用计费。
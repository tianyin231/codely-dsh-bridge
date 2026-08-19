# codely-dsh-bridge

让 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（DeepSeek Harness，`npx @deepseek-ai/dsh web`）**直接使用 Codely CLI 的账号额度**。

原理是在本地跑一个小代理，把 dsh 发出的 OpenAI 格式请求转发到 Codely 的 LiteLLM 网关，并自动补上网关强制校验的客户端身份与会话标识——这些校验导致 dsh 无法直连网关（详见 [docs/PROTOCOL.md](docs/PROTOCOL.md)）。

```
┌─────────┐  OpenAI 格式      ┌────────────────────┐  注入身份头/会话    ┌──────────────────────────────┐
│   dsh   │ ────────────────▶ │ codely-dsh-bridge  │ ──────────────────▶ │ codely-litellm.tuanjie.cn/v1 │
│ (任意端) │   :8790/v1        │    （本地代理）      │    sk- 密钥         │      （Codely 额度后端）       │
└─────────┘                   └────────────────────┘                    └──────────────────────────────┘
                                       │  sk- 密钥失效时自动刷新
                                       ▼
                              ~/.codely-cli 登录凭据 ──▶ codely.tuanjie.cn/api/api-token/cli-api-key
```

## 环境要求

- Node.js ≥ 18
- 已运行过至少一次 dsh（`~/.dsh/` 目录存在）
- Codely 账号（Unity 账号）——**无需安装 codely CLI**，脚本内置设备码登录；如本机已装并登录过 codely CLI，也可直接复用其登录态

## 快速开始

```bash
cd codely-dsh-bridge
npm install

# 1. 脚本内登录（无需安装 codely CLI）：会打开浏览器，用 Unity 账号授权
npm run login

# 2. 一键安装：换取密钥 + 注册 dsh provider + 写入凭据（幂等，可重复运行）
npm run setup

# 3. 启动代理（保持窗口开启；或 --set-default 设默认模型后直接 dsh web）
npm start
```

> 已装 codely CLI 且登录过的机器可跳过第 1 步——setup 会自动复用 `~/.codely-cli` 的登录态，两种方式凭据互不影响。

然后：

```bash
dsh web          # 模型列表里选 codely 系列
# 或非交互验证：
dsh --profile headless "你好"
```

**启动即实时映射**：`npm start` 启动代理时，会自动探测每个 alias 的真实后端（网关透传的 `resp.model`），把「真实模型代号 + 上下文窗口」同步写入 `~/.dsh/settings.yaml`，dsh 模型选择界面随即自动刷新显示真实代号（如 `glm-5-fp8-128k（codely-core）` 或 `glm-5-2-260617（codely-core）`、`deepseek-v4-flash-0731（codely-flash）`、`qwen3.5-397b-a17b（codely-vl）`…），无需手动重跑 setup；官方新放行模型也会自动纳入。启动时的探测日志大致长这样：

```text
[proxy] 探测真实后端（经本代理，共 5 个 alias）...
[proxy] GET /v1/models -> 200 (205ms)
[probe]   codely-basic    -> deepseek-v4-flash-0731  (上下文 1024K)
[probe]   codely-flash    -> deepseek-v4-flash-0731  (上下文 1024K)
[probe]   codely-air      -> deepseek-v4-flash-0731  (上下文 1024K)
[probe]   codely-vl       -> qwen3.5-397b-a17b  (上下文 128K, 支持图片)
[probe]   codely-core     -> glm-5-2-260617  (上下文 128K)      # 可能显示 glm-5-fp8-128k，见下文"映射非单一"
[probe] 已同步 5 个模型到 ~/.dsh/settings.yaml，dsh 模型选择界面将自动刷新
```

> 注：`codely-core` 每次启动显示的代号**可能不同**（`glm-5-fp8-128k` / `glm-5-2-260617` 等 GLM-5 多后端轮换），属正常现象，详见"可用模型"章节的映射规则。

想把 codely 设为 dsh 默认模型（跳过手选）：

```bash
npm run setup -- --set-default --model codely-core
```

> Windows 下也可以直接双击 `start.cmd` 启动代理。

## 可用模型

模型列表在 `npm run setup` 时**实时查询** `/v1/models` 自动写入，不写死——不同账号/会员档位可用的模型不同。查询**优先走本地代理**（与 dsh 实际请求同一条路），代理未启动时自动回退直连网关。

> **真实后端**：LiteLLM 网关会在 `chat.completions` 响应的 `model` 字段透传真实后端模型名（非模型自报，无法伪造）。下表来自 `npm run backend-probe` 实测，随网关部署可能变化。

| dsh 中的模型 ID | 名称（选择器显示，真实后端代号） | 真实后端（网关透传） | 上下文窗口 |
|---|---|---|---|
| `codely-core` | `glm-5-fp8-128k（codely-core）` **或** `glm-5-2-260617（codely-core）` | `glm-5-fp8-128k` / `glm-5-2-260617`（GLM-5 多部署） | **128K**（非 1M） |
| `codely-flash` | `deepseek-v4-flash-0731（codely-flash）` | `deepseek-v4-flash-0731` | 1M |
| `codely-air` / `codely-basic` | `deepseek-v4-flash-0731（codely-air/basic）` | `deepseek-v4-flash-0731` | 1M |
| `codely-vl` | `qwen3.5-397b-a17b（codely-vl）` | `qwen3.5-397b-a17b`（Qwen3.5 MoE） | 128K |

> **⚠️ `codely-core` 的映射不是单一的**：实测发现它背后是**多个 GLM-5 后端负载均衡轮换**（`glm-5-fp8-128k` 与 `glm-5-2-260617` 等，均属 GLM-5 系、都是 128K 上下文），不同启动/请求可能透传出不同代号。因此：
> - `name` 只会显示**某一次探测到的那个**代号，不代表 core 永远只有那一个后端；
> - `contextWindow` 取 GLM-5 系的统一窗口 **128K**，与具体轮换到哪个部署无关，所以压缩阈值是稳定的；
> - 判断一个 alias 「到底是什么」应看**系/家族**（如 core=GLM-5 系、flash=DeepSeek-V4-Flash），而非某一次透传的精确版本号。

> **映射规则**：`id` 必须是 alias（网关只放行 `codely-*`，改真实代号会 401）；`name` 显示"真实后端代号（alias）"，由启动探测动态生成。**探测逻辑**：代理/`setup` 对每个 alias 采样数次（`samples`，默认 3），取出现次数最多的后端作为映射，并消抖网关的负载均衡轮换；单次失败自动跳过。官方**新增放行模型**时会自动纳入（代理先 GET `/v1/models` 取实时列表再逐个探测），无需改代码。

> **等价关系**：官方 agent 里的 `core(GLM-5.2_MAX)` 在桥接侧由 `codely-core`（GLM-5 主通道）+ `codely-flash`（DeepSeek-V4-Flash fast 兜底）混合额度组成，基本等价。
>
> **关于上下文**：`contextWindow` **只影响 dsh 内部上下文压缩阈值，不会显示在模型选择页**——该页只渲染 `name`（主标签）。其中 `codely-core` 是 **128K 而非 1M**（GLM-5 系实测统一 128K，上游 `/v1/models` 声称的 1M 与真实后端不符；setup/代理均按实测 128K 写入）。
>
> 查看当前账号实际可用的模型: `npm run models`；核对真实后端: `npm run backend-probe`；重跑 `npm run setup` 同步到 dsh。

> ⚠️ **关于 GLM 系列（含 `glm-5.2-max`）**：在你自己的 Codely 网页 agent 里能看到/用到 GLM，不代表桥接侧可用。桥接用的 `sk-` 密钥对应的团队白名单是 `['alias-only-proxy-models']`（即上表 5 个 `codely-*` 别名），任何 GLM 命名（`glm-5.2-max` / `GLM-5.2` / `GLM-5.3` 等）都返回 `401 team not allowed to access model`。Codely 自家 agent 大概率是服务端独立鉴权/预置，客户端密钥拿不到该通道。GLM 出现在桥接列表的唯一前提是它进了你的团队白名单（届时 `/v1/models` 会直接返回它）。

密钥额度与你在 codely CLI 里用的是同一份（实测速率限制 200 RPM）。

## 附带：dsh 积分额度悬浮圈插件（dsh-codely-quota）

本仓库顺带打包了一个 **dsh 插件**（`plugins/dsh-codely-quota`）：在 dsh web 右下角放一个**悬浮小圆环**
（类似 dsh 的上下文占用指示圈），一眼看出每日额度剩余比例，**点击展开**各积分详情；还给 agent 一个 `codely_quota` 工具随时查询：

```
┌─ dsh web 悬浮额度圈 ─┐   ┌────────────────────┐   ┌────────────────┐   ┌───────────────┐
│ 圆环=剩余比例(色阶)   │──▶│ 插件 host API      │──▶│ 本仓库代理      │──▶│ Codely 官网   │
│ 点击展开全部详情      │   │ /…/codely-quota/api │   │ GET /quota      │   │ billing/usage│
└──────────────────────┘    /health 15s /quota 30s   15s 缓存         access_token 自动续期
                                                         ↕
                              ⚙️ 代理没开就不启用：/health 探测离线时整个隐藏，恢复后自动出现
```

**交互**：单击圆环展开/收起详情浮层（点外部 / Esc 收起）；按住可拖拽换位置（localStorage 记忆）；浮层内「刷新」按钮强制刷新。

展开后展示四块**实时积分数据**（数据源=官网 `/api/user/billing/usage/summary`，官方口径）：

| 区块 | 内容 |
|---|---|
| 每日赠送 | 免费/基础档每日 10000 积分：剩余 / 已用 / 进度条 / **距每日重置倒计时**（0 点 Asia/Shanghai） |
| 积分账户 | 充值积分余额（`effective_available_points`）、累计充值、可申请赠送提示 |
| 套餐窗口限额 | 付费 codely coding plan 的 **`usage_5h`（5小时用量窗）/ `subscription_week`（订阅周）/ `subscription_month`（订阅月）** 三个窗口的额度/已用/剩余与下次刷新时间——免费号不显示窗口，付费后自动出现 |
| 本月统计 | 当月消耗积分、结算次数、令牌量、网关速率限制（如 200 RPM） |

配套能力：

- **`codely_quota` 工具**：agent 在会话中直接调用即可拿到上面的摘要文本（可 `force` 强制刷新）——长任务前先看还剩多少额度。
- **`npm run quota`**：不开 dsh 也能在终端看同样的数据。
- 本仓库代理新增 **`GET /quota`** 端点（`?force=1` 强制刷新），只监听 loopback 且校验 Host，防 DNS rebinding。

### 使用

```bash
# 1. 代理先跑起来（悬浮圈数据都从本地代理取；代理不跑时悬浮圈自动隐藏）
npm start

# 2. 注入插件（当前机器已注入；换机器见下）
#    dev_inject_plugin {"dir": "…/codely-dsh-bridge/plugins/dsh-codely-quota"}

# 3. 刷新 dsh web 页面 → 右下角出现「额度圈」（点击展开详情）
```

> 注入通过 dsh-super-injector（运行时注入，重启后由注入清单自动恢复）。改 `lib/` 代码后重跑注入/重载即可。
> 插件配置：`proxyBaseURL`（默认 `http://127.0.0.1:8790`）、`cacheMs`（host 缓存）、`refreshMs`（悬浮圈自动刷新）。

## 命令一览

| 命令 | 作用 |
|---|---|
| `npm run login` | 独立登录（设备码流程，浏览器授权一次，凭据存 `codely-creds.json`） |
| `npm run models` | 查询当前账号可用的模型列表 |
| `npm run backend-probe` | 探测 `codely-*` 别名背后的真实后端模型（读网关透传的 `resp.model`） |
| `npm run quota` | 终端直接查看积分余额（每日赠送/充值余额/套餐窗口/月度统计，`--force` 强制刷新） |
| `npm run setup` | 安装/更新配置（自动检测可用模型，备份原文件为 `*.bak-codely`） |
| `npm start` | 启动代理（默认 `127.0.0.1:8790`，`--port N` 可改端口，需与 setup 的 `--port` 一致） |
| `npm test` | 冒烟测试（healthz / models / 一次对话） |
| `npm run uninstall` | 回滚 dsh 配置（优先恢复备份） |

setup 支持的参数：`--port N`（代理端口）、`--set-default`（设为 dsh 默认 provider）、`--model ID`（配合 `--set-default`）。

## 它改了哪些东西

| 文件 | 改动 |
|---|---|
| `~/.dsh/settings.yaml` | `llm-pi-ai.providers` 下新增 `codely` 条目（指向 `http://127.0.0.1:8790/v1`）；已有 provider（如 opencode-go）不受影响 |
| `~/.dsh/.credentials.yaml` | 新增 `CODELY_API_KEY` |
| 本目录 `codely-creds.json` | `npm run login` 保存的登录凭据（独立于官方 CLI，已 gitignore） |
| 本目录 `key.cache` / `session.cache` | 代理运行时状态（已 gitignore） |

注意：setup 会用 YAML 库重写 dsh 的两个配置文件，**原文件中的注释会丢失**，因此修改前会先做备份。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| dsh 报 `ECONNREFUSED 127.0.0.1:8790` | 代理没启动，先 `npm start` |
| `欢迎使用Codely, 访问 https://codely.tuanjie.cn/` | 网关 UA 校验未过——请确认请求走的是本代理而不是直连网关（检查 settings.yaml 里 `codely` 的 baseURL 是 `127.0.0.1:8790`） |
| `非法session` | 会话标识缺失——同上，必须经过代理；或代理版本过旧 |
| 代理日志反复 `上游返回 401` | 密钥失效且自动刷新失败 → 重新 `npm run login`，再 `npm run setup` |
| 代理日志 `模型被团队权限拒绝`，或 dsh 报 `team not allowed to access model` | 上游团队白名单不含该模型（如 `GLM-5.2` / `glm-5.2-max` 等，白名单仅 `codely-*` 别名）→ 在 dsh 改用列表内的模型：`codely-core` / `codely-flash` / `codely-air` / `codely-basic` / `codely-vl`；换 key/换团队无效（密钥幂等、白名单随团队固定），重跑 `npm run setup` 也只会同步白名单内模型 |
| 想确认代理状态 | `curl http://127.0.0.1:8790/healthz` |
| 换了 Codely 账号/组织 | 重新 `npm run login` + `npm run setup` |
| 登录时浏览器没自动打开 | 手动复制终端打印的 Verification URL 到浏览器打开 |

## 卸载

```bash
npm run uninstall     # 恢复 dsh 配置备份
```

## ⚠️ 安全须知

- `codely-creds.json`（登录凭据）、`key.cache`、`~/.dsh/.credentials.yaml` 都含账号级密钥，**请勿外传或提交到 git**（`.gitignore` 已排除前两者）
- 代理默认只监听 `127.0.0.1`，不要用 `--bind 0.0.0.0` 暴露到公网
- 本项目仅供个人把自己已购的 Codely 额度接入自己常用的 agent 工具；请遵守 Codely 服务条款

## 目录结构

```
codely-dsh-bridge/
├── login.js           # 独立登录（设备码流程，免装 codely CLI）
├── codely-auth.js     # 凭据管理（本地 creds 优先，官方 CLI 回退，自动刷新）
├── codely-proxy.js    # 本地代理（核心；含 /quota 积分端点）
├── codely-quota.js    # 积分余额查询（summary/plan/key-info，15s 缓存；可 CLI：npm run quota）
├── setup.js           # 安装脚本（幂等）
├── uninstall.js       # 回滚脚本
├── start.cmd          # Windows 一键启动
├── plugins/
│   └── dsh-codely-quota/   # 附带 dsh 插件：积分额度悬浮圈（点击展开详情）+ codely_quota 工具
├── test/smoke.js      # 冒烟测试
└── docs/PROTOCOL.md   # 网关协议逆向笔记（维护必读）
```

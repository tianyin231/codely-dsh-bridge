# codely-dsh-bridge

把 **Codely 账号的模型额度** 接入 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（DeepSeek Harness，`npx @deepseek-ai/dsh web`）使用。

**背景**：[Codely](https://codely.tuanjie.cn) 是 [Unity 中国](https://www.unity.cn)（Tuanjie / 团结引擎）旗下的 AI 编程智能体，官方 agent 名为 **Tuanjie Cowork**（媒体亦称「团结 Codely」）；账号登录体系为 Unity ID，模型推理走 `codely-litellm.tuanjie.cn` 的 LiteLLM 网关。额度属于**你的 Codely 账号**（每日赠送 / 充值积分 / 订阅套餐窗口），与官方 agent 共用同一份。

**本项目做什么**：在本地跑一个小代理，把 dsh 发出的 OpenAI 格式请求转发到 Codely 的 LiteLLM 网关，并自动补上网关强制校验的客户端身份与会话标识——这些校验导致 dsh 无法直连网关（详见 [docs/PROTOCOL.md](docs/PROTOCOL.md)）。**不改造 dsh、不绕过计费**：用的就是你账号自己的额度，只是把官方 agent 独占的模型通道「代理」给 dsh 用，并提供多账号额度的统一管理与一键丝滑切换（见「多账号切换」）。

> ⚠️ 本项目为**非官方个人项目**，与 Unity 中国 / Codely 无任何隶属关系；接口为个人逆向所得、随时可能变更，仅供把自己已购的额度接入常用工具链使用，请遵守 Codely 服务条款。

```
┌─────────┐  OpenAI 格式      ┌────────────────────┐  注入身份头/会话    ┌──────────────────────────────┐
│   dsh   │ ────────────────▶ │ codely-dsh-bridge  │ ──────────────────▶ │ codely-litellm.tuanjie.cn/v1 │
│ (任意端) │   :8790/v1        │    （本地代理）      │    sk- 密钥         │      （Codely 额度后端）       │
└─────────┘                   └────────────────────┘                    └──────────────────────────────┘
                                       │  sk- 密钥失效时自动刷新
                                       ▼
  登录凭据（本项目 codely-creds.json 或 ~/.codely-cli）──▶ codely.tuanjie.cn/api/api-token/cli-api-key
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

## 正确使用顺序（重要）

```text
一次性  ──▶  npm run login        # 扫码/浏览器授权，生成 codely-creds.json
常驻    ──▶  npm start           # 启动代理（监听 127.0.0.1:8790，必须一直开着）
配置    ──▶  npm run setup       # 注册 codely provider + 装配额度圈插件（幂等）
使用    ──▶  dsh web             # 打开浏览器后刷新页面 → 右下角出现额度圈
```

关键注意点：

1. **代理必须先于 dsh 使用**：额度圈和模型请求都走本地代理——代理没开时模型请求失败，额度圈也会整体隐藏（`/api/health` 探测 `proxyUp=false` 即隐藏，代理恢复后自动出现）。
2. **改过插件源码 / 重跑过 setup 后必须重启 dsh web 并刷新页面**：插件通过 profile bundles 在启动时装配，运行中的 dsh 不会热加载新插件（启动配置快照在启动瞬间固定）。之前遇到过"装好插件却不显示额度圈"的典型原因就是 dsh 没重启。
3. **setup 在代理未启动时也能跑**：模型列表查询会自动回退直连网关，真实后端探测也会回退直连——写出的模型与上下文窗口信息同样准确，不强制要求先 `npm start`。
4. **端口必须一致**：`npm start` 与 `npm run setup` 的 `--port` 要一致（默认 8790；换端口用 `npm start -- --port 9000` 和 `npm run setup -- --port 9000`）。
5. **改过插件源码后**（`plugins/dsh-codely-quota/src/`）：重跑 `npm run build:client` 刷新 `lib/client.js`，再重跑 `npm run setup` 重新装配，最后重启 dsh web。

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

**交互**：单击圆环展开/收起详情浮层（点外部 / Esc 收起）；按住可拖拽换位置（localStorage 记忆）；浮层内「刷新」按钮强制刷新；顶部**账号行**多账号时显示切换下拉，一键丝滑切号。

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

# 2. 无需手动注入——**npm run setup 已自动装配插件**（写入 profile 的 dependencies + bundles，见 "附带插件" 章节）
#    旧版手动方式：dev_inject_plugin {"dir": "…/codely-dsh-bridge/plugins/dsh-codely-quota"}

# 3. 刷新 dsh web 页面 → 右下角出现「额度圈」（点击展开详情）
```

> 装配方式：`npm run setup` 会把插件以 `link:` + bundles 写进 profile（`~/.dsh/profiles/web/package.json`），dsh 启动即自动加载——换机器重跑 setup 即自动完成，无需手工注入。改 `lib/` 代码后刷新页面即可生效（或按插件 README 用 `dev_reload_package` 热重载）。
> 插件配置：`proxyBaseURL`（默认 `http://127.0.0.1:8790`）、`cacheMs`（host 缓存）、`refreshMs`（悬浮圈自动刷新）。

## 多账号切换（CLI + 小球）

支持把**多个 Codely 账号**登录并保存，随时切换当前账号（额度 / 模型 / 密钥全部跟着变，**无需重启代理**）：

```
账号注册表（本目录 accounts/，gitignored）
  accounts/index.json     当前账号 + 账号列表
  accounts/<name>.json    各账号登录凭据
  codely-creds.json       始终等于「当前激活账号」凭据（老链路零改动）
```

**CLI 切换**：

```bash
npm run account -- list                 # 列出已登录账号（* 标记当前）
npm run account -- login my-team-a      # 设备码登录新账号并设为当前（浏览器授权）
npm run account -- switch my-team-b     # 切到另一账号（代理运行时自动重探模型映射）
npm run account -- show                 # 查看当前账号详情
npm run account -- remove my-team-a     # 删除账号（删当前账号时自动切到剩下的第一个）
```

> 也可以直接 `npm run login -- --name my-team-a` 登录并登记。老版本单账号升级后首次
> `npm run account -- list` 会自动把现有 `codely-creds.json` 导入注册表。

**小球里丝滑切换**：dsh web 右下角**额度圈**（悬浮球）→ 单击展开 → 顶部**账号行**（多账号时出现
下拉选择器）→ 选择目标账号 → 一键切换：换凭据、换密钥、清配额缓存、重探模型，**圆环平滑过渡到
新账号的额度比例**，全程免重启。若在 CLI 里切了账号，小球会在健康轮询时自动跟上显示。

**小球里添加新账号**：点账号行右侧 **「+」** —— 发起设备码登录并给出**可复制的验证链接 + 用户码**
（与 `npm run login` 同一授权逻辑，入口在小球里）。授权完成后自动保存凭据并切换过去，无需碰终端。

> ⚠️ 授权跟随打开链接的浏览器会话：官方授权页是 Unity ID 登录页，**没有「切换账号」按钮**，且
> **主浏览器直接打开会瞬间授权当前账号并消耗设备码**（再复制到无痕会提示 no longer pending）。
> 添加另一账号请：**复制链接 → 无痕窗口/另一浏览器打开 → 登录另一 Unity 账号 → 授权**。授权到当前
> 账号时小球会明确提示；已保存的不同账号之间随时丝滑切换（小球下拉 / `npm run account -- switch`）。

> 原理：小球 → 插件 host API → 本地代理 `POST /account/switch` → 换 `codely-creds.json` + 删
> `key.cache`/`session.cache`（下次请求自动取新账号密钥、重开会话）+ 重探模型写回
> `~/.dsh/settings.yaml`。代理新增端点（仅 loopback Host 可访问）：`GET /accounts`（列表）、
> `POST /account/switch?name=<账号>`（切换）、`POST /account/login/start|status|cancel`（小球内
> 设备码登录：发起跳转官方登录页 → 轮询授权 → 自动保存并激活）。

## 命令一览

| 命令 | 作用 |
|---|---|
| `npm run login` | 独立登录（设备码流程，浏览器授权一次，凭据存 `codely-creds.json`，同时登记到账号注册表） |
| `npm run account -- list` | 列出已登录账号（`*` 标记当前） |
| `npm run account -- switch <name>` | 切换当前账号（换凭据+密钥，代理运行中自动重探模型） |
| `npm run account -- login [name]` | 设备码登录一个新账号并设为当前 |
| `npm run account -- remove <name>` | 删除账号（删当前时自动切到剩余第一个） |
| `npm run account -- show` | 查看当前账号详情 |
| `npm run models` | 查询当前账号可用的模型列表 |
| `npm run backend-probe` | 探测 `codely-*` 别名背后的真实后端模型（读网关透传的 `resp.model`） |
| `npm run quota` | 终端直接查看积分余额（每日赠送/充值余额/套餐窗口/月度统计，`--force` 强制刷新） |
| `npm run setup` | 安装/更新配置（自动检测模型 + 自动装配额度圈插件，修改前备份为 `*.bak-codely`） |
| `npm start` | 启动代理（默认 `127.0.0.1:8790`，`--port N` 可改端口，需与 setup 的 `--port` 一致） |
| `npm test` | 冒烟测试（healthz / models / 一次对话） |
| `npm run uninstall` | 回滚 dsh 配置（优先恢复备份） |

setup 支持的参数：`--port N`（代理端口）、`--set-default`（设为 dsh 默认 provider）、`--model ID`（配合 `--set-default`）。

## 它改了哪些东西

| 文件 | 改动 |
|---|---|
| `~/.dsh/settings.yaml` | `llm-pi-ai.providers` 下新增 `codely` 条目（指向 `http://127.0.0.1:8790/v1`）；已有 provider（如 opencode-go）不受影响 |
| `~/.dsh/.credentials.yaml` | 新增 `CODELY_API_KEY` |
| 本目录 `codely-creds.json` | `npm run login` 保存的「当前激活账号」凭据（独立于官方 CLI，已 gitignore） |
| 本目录 `accounts/` | 多账号注册表（`index.json` + 各账号凭据，已 gitignore） |
| 本目录 `key.cache` / `session.cache` | 代理运行时状态（已 gitignore；切换账号时自动更换） |
| `~/.dsh/profiles/web/package.json` | 新增 `@dsh-external/dsh-codely-quota`（`link:` 依赖 + bundles 条目），dsh 启动自动装配额度圈（`npm run uninstall` 会移除） |

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
| 换了 Codely 账号/组织 | `npm run account -- list` 看账号 → `npm run account -- switch <name>` 切过去（新账号需先 `npm run account -- login <name>` 登录）；小球里也能一键切换 |
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
├── login.js           # 独立登录（设备码流程，免装 codely CLI；登录后登记到账号注册表）
├── account.js         # 多账号管理 CLI（list / switch / login / remove / show）
├── codely-auth.js     # 凭据管理（本地 creds 优先，官方 CLI 回退，自动刷新）
├── codely-accounts.js # 多账号注册表（accounts/ 读写、切换、凭据指纹）
├── codely-proxy.js    # 本地代理（核心；含 /quota、/accounts、/account/switch 端点）
├── codely-quota.js    # 积分余额查询（summary/plan/key-info，按账号指纹 15s 缓存；可 CLI：npm run quota）
├── setup.js           # 安装脚本（幂等）
├── uninstall.js       # 回滚脚本
├── start.cmd          # Windows 一键启动
├── accounts/          # 多账号注册表（index.json + 各账号凭据，运行时生成，gitignored）
├── plugins/
│   └── dsh-codely-quota/   # 附带 dsh 插件：积分额度悬浮圈（点击展开详情 + 账号切换下拉）+ codely_quota 工具
├── test/smoke.js      # 冒烟测试
└── docs/PROTOCOL.md   # 网关协议逆向笔记（维护必读）
```

# Codely LiteLLM 网关协议笔记

本文记录 codely-dsh-bridge 依赖的网关行为，全部来自对官方 CLI（`codely.exe`，基于 Bun 打包的 Gemini-CLI 衍生架构）的抓包与二进制字符串分析（2026-08，CLI 版本 1.0.0-release.41）。若官方更新后代理失效，按此排查。

## 1. 端点

| 端点 | 用途 |
|---|---|
| `POST https://codely.tuanjie.cn/auth/device/initiate` | 发起设备码授权，body `{"provider":"unity","client_name":"codely-cli"}` → `{auth_request_token, verification_uri_complete, user_code, interval, expires_in}` |
| `GET https://codely.tuanjie.cn/auth/device/poll?auth_request_token=…` | 轮询授权状态：`pending` / `slow_down` / `authorized`（含 `authorization_code`）/ `denied` / `expired` / `completed` |
| `POST https://codely.tuanjie.cn/auth/device/exchange` | 用 `{"authorization_code": …}` 换 `{access_token, refresh_token, token_type, expires_in}` |
| `POST https://codely.tuanjie.cn/auth/refresh` | 用 `{"refresh_token": …}` 续期 access_token |
| `GET https://codely.tuanjie.cn/auth/external/me` | Bearer access_token → 用户信息 `{id, …}` |
| `GET https://codely.tuanjie.cn/api/teams` | Bearer → 组织列表 `{teams:[{team_id,team_name,is_current}], current_team_id}` |
| `https://codely-litellm.tuanjie.cn/v1/chat/completions` | 对话（OpenAI 格式，支持 SSE 流式） |
| `https://codely-litellm.tuanjie.cn/v1/models` | 模型列表 |
| `GET https://codely.tuanjie.cn/api/api-token/cli-api-key?teamId=<orgId>` | 用 OAuth access_token（JWT）换取 LiteLLM 虚拟密钥（`sk-` 开头） |

设备码流程无需任何 client_secret（client_name 仅作标识），因此可在任意脚本中独立完成登录——本项目 `login.js` 即为此实现。

换 key 请求：

```bash
curl "https://codely.tuanjie.cn/api/api-token/cli-api-key?teamId=<orgId>" \
  -H "Authorization: Bearer <access_token>"
# → {"cli_api_key":"sk-xxxx","user_id":23493,"rpm":200,"tpm":0}
```

- `access_token` 取自 `~/.codely-cli/oauth_creds.json`
- `teamId` 取自 `~/.codely-cli/org.json` → `accounts.<user_id>.currentOrgId`
- 同一账号重复获取返回**同一密钥**（幂等），因此可放心缓存与自动刷新

## 2. 网关的三道校验（缺一不可）

### 2.1 密钥格式

`Authorization: Bearer sk-...`。网关只接受 LiteLLM 虚拟密钥；`oauth_creds.json` 里旧版的 `cli_api_key` 字段（十六进制冒号格式）会被 401 拒绝，必须按 §1 重新换取。

### 2.2 客户端身份（User-Agent）

UA 必须形如 `codely-cli/<version> (win32; x64)`，否则返回：

```json
{"error": {"message": "{'error': '欢迎使用Codely, 访问 https://codely.tuanjie.cn/'}"}}
```

官方 CLI 实际发送的完整头组（OpenAI SDK 特征）：

```
User-Agent: codely-cli/1.0.0-release.41 (win32; x64)
X-Stainless-Lang: js
X-Stainless-Package-Version: 5.11.0
X-Stainless-OS: Windows
X-Stainless-Arch: x64
X-Stainless-Runtime: node
X-Stainless-Runtime-Version: v24.3.0
X-Stainless-Retry-Count: 0
```

实测仅 UA 为必需项，X-Stainless 组为保险起见一并注入。

### 2.3 会话标识

请求体需要 `litellm_session_id`（官方 CLI 同时在 `metadata.session_id` 里带一份），缺失返回：

```json
{"error": {"message": "400: {'error': '非法session'}"}}
```

两种注入位置实测均有效：

- 请求体顶层 `"litellm_session_id": "<uuid>"`（官方做法）
- 请求头 `x-litellm-session-id: <uuid>`

对值本身无校验（任意持久 UUID 即可），本代理两者都注入。

## 3. 最小可用请求示例

```bash
curl https://codely-litellm.tuanjie.cn/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxx" \
  -H "User-Agent: codely-cli/1.0.0-release.41 (win32; x64)" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codely-flash",
    "messages": [{"role":"user","content":"hi"}],
    "max_completion_tokens": 100,
    "litellm_session_id": "00000000-0000-0000-0000-000000000001"
  }'
```

注意使用 `max_completion_tokens`（新字段）；流式请求带 `stream: true`，SSE 响应的 delta 中推理内容在 `reasoning_content` 字段。

## 4. 错误对照表

### 4.0 alias 真实后端（网关透传实测 2026-08）

`/v1/models` 只返回 5 个 `codely-*` alias。但 LiteLLM 网关会在 `chat.completions` 响应的 `model` 字段**透传真实后端模型名**（路由层填充，非模型自报），据此可实锤每个 alias 背后是谁：

| alias | 真实后端（resp.model 透传，同系可能多部署轮换） | 说明 |
|---|---|---|
| `codely-core` | `glm-5-fp8-128k` **或** `glm-5-2-260617` | GLM-5 系，**多个部署负载均衡轮换**，上下文统一 **128K**（非 1M） |
| `codely-flash` | `deepseek-v4-flash-0731` | DeepSeek-V4-Flash |
| `codely-air` / `codely-basic` | `deepseek-v4-flash-0731` | 与 flash 同一后端 |
| `codely-vl` | `qwen3.5-397b-a17b` | Qwen3.5 MoE（397B，17B 激活） |

> **关键：`codely-core` 的映射非单一**——gateway 在同一 alias 背后做 GLM-5 多后端负载均衡（如 `glm-5-fp8-128k`、`glm-5-2-260617`），不同启动/请求透传的精确版本号不同：连续单独采样常稳定到 `glm-5-fp8-128k`，但并发/跨请求可能见到 `glm-5-2-260617`。判断 alias「是什么」应按**系/家族**（core=GLM-5 系、flash=DeepSeek-V4-Flash、vl=Qwen3.5 MoE），而非某一次精确版本号。`contextWindow` 用系的统一窗口（GLM-5 系 128K），不随轮换变化，探测逻辑见下方。

即官方 agent 的 `core(GLM-5.2_MAX)` ≈ `codely-core`（GLM-5）+ `codely-flash`（DeepSeek-V4-Flash fast）混合额度，基本等价。

⚠️ 注意：`/v1/models` 里 `codely-core` 声明的 `max_model_len=1048576` 与真实 GLM-5 系(128K) **不符**。窗口信息应以 `backend-probe` 实测为准（本项目 `setup.js`/代理均按 128K 写入 dsh），而非上游 alias 声明。核对可用 `npm run backend-probe`。

**探测逻辑**（`auth.probeBackends`）：对每 alias 采样 `samples` 次（默认 3，取出现次数最多的后端，消抖负载均衡轮换），失败逐次跳过；经代理时带 `x-codely-probe` 头不刷代理日志。

| HTTP | message | 含义 |
|---|---|---|
| 401 | `LiteLLM Virtual Key expected... expected to start with 'sk-'` | 密钥格式/值不对 → 重新换 key |
| 401 | `team not allowed to access model ... This team can only access models=['alias-only-proxy-models']` | 模型被团队权限拒绝：团队白名单只放行 `codely-*` 别名，**其他任何命名一律 401**（换 key 无效——密钥按账号幂等、白名单随团队固定）。`glm-5.2-max` / `GLM-5.2` / `GLM-5.3` 及 `codely-glm-*`、真实模型名（如 `deepseek-v4-flash`）实测全部拒绝 → 只能用 `/v1/models` 返回列表内的模型。注：Codely 自家网页 agent 里可选 GLM 属于服务端独立鉴权/预置，客户端 `sk-` 密钥拿不到该通道 |
| 400 | `欢迎使用Codely, 访问 ...` | UA 校验未过 → 见 §2.2 |
| 400 | `非法session` | 缺会话标识 → 见 §2.3 |
| 405 | `Method Not Allowed`（`/v1/models/<id>:generateContent`） | 网关不开放 Gemini 原生格式，用 OpenAI 格式 |

## 5. 官方 CLI 相关实现（二进制中的位置，便于核对更新）

- Anthropic 兼容层 `getAuthHeaders()`：`{"x-api-key": key, authorization: "Bearer " + key}`
- 真实请求走 OpenAI SDK（`X-Stainless-*` 头组）打 `/v1/chat/completions`
- `fetchCliApiKey()`：GET `${codely.tuanjie.cn}/api/api-token/cli-api-key?teamId=...`
- 默认 base URL 常量 `$5 = "https://codely-litellm.tuanjie.cn/v1"`（硬编码，无环境变量可覆盖）
- `/report/{success,failure,tool-call}` 为事后遥测上报，与请求放行无关

## 6. 免责声明

以上为个人逆向笔记，接口随时可能变更；本项目仅用于把本人已购额度接入本人工具链，请遵守 Codely 服务条款。

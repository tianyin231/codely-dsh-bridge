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

想把 codely 设为 dsh 默认模型（跳过手选）：

```bash
npm run setup -- --set-default --model codely-core
```

> Windows 下也可以直接双击 `start.cmd` 启动代理。

## 可用模型

| dsh 中的模型 ID | 说明 |
|---|---|
| `codely-core` | 旗舰推理模型（1M 上下文） |
| `codely-flash` | 快速模型（实际路由 DeepSeek-V4-Flash） |
| `codely-air` / `codely-basic` | 轻量/基础档 |
| `codely-vl` | 多模态（文本 + 图片） |
| `GLM-5.2` / `GLM-5.3` | GLM 系列（1M 上下文） |

密钥额度与你在 codely CLI 里用的是同一份（实测速率限制 200 RPM）。

## 命令一览

| 命令 | 作用 |
|---|---|
| `npm run login` | 独立登录（设备码流程，浏览器授权一次，凭据存 `codely-creds.json`） |
| `npm run setup` | 安装/更新配置（自动备份原文件为 `*.bak-codely`） |
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
├── codely-proxy.js    # 本地代理（核心）
├── setup.js           # 安装脚本（幂等）
├── uninstall.js       # 回滚脚本
├── start.cmd          # Windows 一键启动
├── test/smoke.js      # 冒烟测试
└── docs/PROTOCOL.md   # 网关协议逆向笔记（维护必读）
```

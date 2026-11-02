# WB Pool 本地版 · 双击即用的 AI 聚合池

把 **WorkBuddy 多账号免费额度** 和 **76 家第三方免费渠道** 聚合成一个 OpenAI 兼容端点。
单文件 exe，**双击就能用**，全程只在本机运行，不需要任何服务器。

> 思路参考 [XDTrees/dsh-xdpool](https://github.com/XDTrees/dsh-xdpool)（MIT），把它搬到了 WorkBuddy 上。

---

## 它做什么

- **多账号轮换**：自动扫描本机 WorkBuddy 桌面端的登录凭据，多账号收进一个池子；一个号 429 / 积分耗尽就自动换下一个。
- **积分自动化**：每天自动签到、领补偿和任务奖励，池子里所有号一起薅。
- **免费渠道兜底**：内置 76 家第三方渠道注册表（Groq / OpenRouter / SiliconFlow 等），控制台里填个 Key 就点亮。
- **一条端点**：对外只暴露 `http://127.0.0.1:8788/v1/chat/completions`，WorkBuddy / 任何 OpenAI 兼容客户端都能接。
- **控制台**：账号状态、积分、模型勾选、渠道管理、调用统计，一个页面全有。

```
WorkBuddy 桌面端 / 任意 OpenAI 客户端
        │  模型选「WB Pool」
        ▼
POST http://127.0.0.1:8788/v1/chat/completions
        │
┌───────┴────────────────────────────┐
│  wbpool 网关（本机）                 │
│  1. WorkBuddy 账号池（优先）         │
│     429 → 冷却换号；积分尽 → 长休息   │
│  2. 第三方免费渠道（兜底）            │
│  3. 自动签到 / 任务奖励（后台定时）   │
└────────────────────────────────────┘
```

## 快速开始

1. 到 [Releases](../../releases) 下载 `WB Pool 本地版.exe`（约 84 MB，免安装）。
2. 双击运行 —— 它会自动：
   - 扫描本机 WorkBuddy 登录过的账号（需要装过 WorkBuddy 并登录过一次）
   - 在 `127.0.0.1:8788` 起网关
   - 把「WB Pool」注册进 WorkBuddy 的模型列表
   - 打开浏览器进控制台
3. 在 WorkBuddy 模型选择器里选 **WB Pool · 自动（多账号池）**，开聊。
   想指定具体模型，先在控制台「网关」页勾选，重启 exe 后模型列表里就会出现独立条目。

**没装 WorkBuddy 也能用**：打开控制台 →「渠道」页 → 填任意一家免费渠道的 API Key。

## 隐私与安全

- 所有凭据只落在本机 `%USERPROFILE%\.wbpool\`，**不经过、不上传任何第三方服务器**。
- 网关只绑定 `127.0.0.1`，局域网里别人碰不到。
- 关闭 exe 的控制台窗口即停止服务；数据随时可整目录删除。

## 从源码构建

要求：Node.js 22+，Windows。

```bash
npm install --no-save postject
node tools/build-local-exe.mjs
# 产物：dist/WB Pool 本地版.exe（同时复制一份到桌面）
```

不想构建也可以直接跑源码：

```bash
node local.mjs          # 双击 exe 做的事，源码版
node src/cli.mjs serve  # 纯网关模式
node src/cli.mjs doctor # 体检：解密 / 上游连通性 / 渠道
node tools/selftest.mjs # 池路由自测
```

## 配置

首启自动生成 `%USERPROFILE%\.wbpool\config.json`，常用项：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `8788` | 网关端口（被占用会自动往后找） |
| `distribution` | `priority` | 分配策略：`priority` / `round-robin` / `balanced` / `sticky` / `expiry` |
| `cooldownMs` | `60000` | 429 冷却时长 |
| `providers` | `{}` | 第三方渠道：`{ "groq": { "apiKey": "…", "enabled": true } }` |
| `selectedModels` | `[]` | 要注册成独立模型条目的模型 id |
| `automation` | 开 | 每日签到 / 奖励领取时间点 |

## 开发者说明（源码结构）

```
local-entry.cjs        SEA 主脚本：解包运行时 → 加载 local.mjs
local.mjs              本地版入口：扫号、起网关、注册模型、开控制台
src/core/gateway.mjs   HTTP 网关与控制台 API（/v1/chat/completions + /api/*）
src/core/accounts.mjs  账号池：扫描、冷却、分配策略
src/core/at-rest.mjs   WorkBuddy 凭据解密（AES-256-GCM 信封）
src/core/upstream.mjs  WorkBuddy 上游客户端、模型目录、签到 / 积分
src/core/providers.mjs 第三方渠道转发
src/automation.mjs     每日签到 / 奖励定时任务
ui/                    控制台与登录页
data/providers-registry.json  76 家免费渠道注册表
```

## License

[MIT](LICENSE)。`data/providers-registry.json` 移植自 [dsh-xdpool](https://github.com/XDTrees/dsh-xdpool)（MIT）。

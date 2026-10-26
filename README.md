# devin-byok

把 Devin 桌面版（Cognition 官方，Windsurf 换皮）变成 **BYOK（Bring Your Own Key）** 客户端的本地网关。

Devin 里正常聊天、跑 agent，但推理走你自己的 OpenAI/Anthropic 兼容端点——不走官方订阅计费。

> [!NOTE]
> 本项目为个人研究用途，与 Cognition 无关。使用你自己的 Devin 账号与自己的 API key，请自行遵守相关服务条款。

## 工作原理

```
Devin Desktop
    │
    │ ACP stdio
    ▼
devin.exe (Rust CLI)
    │  HTTPS_PROXY=http://127.0.0.1:3006    ← settings.json devin.acp.agentEnv
    ▼
devin-byok gateway (本机, node)
    │  CONNECT server.codeium.com:443 → MITM（rootCA 装在系统信任库）
    │
    ├─ GetChatMessage                    → BYOK 提供商（你的 key）
    ├─ GetWebSearchResults               → BYOK 搜索（可选）
    └─ 其他 RPC（登录/模型目录/团队配置）→ 透传真 Codeium
    ▼
Devin UI 一切正常，推理走你的 key
```

Agent loop 在客户端（devin.exe 执行工具），网关只做协议翻译——拦的是
`server.codeium.com` 的 Connect-RPC（`exa.api_server_pb.ApiServerService/GetChatMessage`），
架构思路与 [cursor-byok](https://github.com/Yimikami/cursor-byok) 同构。

**为什么不用 patch Devin 主程序**：旧方案（workbench URL patch）随 Devin 3.5.17
更新失效。本方案走 `devin.acp.agentEnv` 注入代理环境变量 + 系统信任库 CA，
CLI 是标准 Rust reqwest 代理栈，桌面版升级不影响。

## 快速开始

要求：Node.js ≥ 18，Devin Desktop 已安装并登录。

### 1. 生成证书（首次）

```powershell
node setup-cert.mjs
```

生成 rootCA + `server.codeium.com` 证书到 `~/.devin-byok/certs/`，并安装 rootCA
到系统信任库（Windows 装到 CurrentUser Root 免管理员）。

### 2. 配置

```powershell
copy .env.example .env
# 编辑 .env 填入你的端点与 key
```

最小配置：

```
BYOK1_OPENAI_API_HOST=api.example.com
BYOK1_OPENAI_API_KEY=sk-xxx
BYOK1_OPENAI_API_PATH=/v1/chat/completions
BYOK1_MODEL=your-model
BYOK1_PROTOCOL=openai
DEFAULT_MODEL=your-model
MITM_CERTS_DIR=C:/Users/<you>/.devin-byok/certs
```

### 3. 让 Devin 走网关

在 `%APPDATA%\Devin\User\settings.json` 加入：

```json
"devin.acp.agentEnv": {
  "devin-cli": {
    "HTTPS_PROXY": "http://127.0.0.1:3006",
    "HTTP_PROXY": "http://127.0.0.1:3006"
  }
}
```

重启 Devin 生效。

### 4. 启动

```powershell
node src/hybrid-server.js
```

或双击 `start-devin-byok.cmd`（Windows）。管理界面：http://127.0.0.1:3006/

### 5. 验证

Devin 里任意模型发一句话，网关控制台出现：

```
#N GetChatMessage model=swe-1-6 byok=true → BYOK
  🧠 Model: swe-1-6 → your-model (OpenAI)
```

或离线自测（不启动 Devin）：

```powershell
node test-e2e.mjs    # 模拟 devin-cli 完整协议栈，打印 BYOK 回复
```

## 模型路由

Devin 的模型选择器显示官方 uid（白名单由服务端下发，透传），BYOK 借官方 uid 路由：

| Devin 里选 | 路由到 |
|---|---|
| swe-1-6 / swe-1-7 / glm-5-2 / kimi-k2 等 | DEFAULT_MODEL（BYOK1） |
| swe-1-6-medium | BYOK2 |
| swe-1-7-max | BYOK3 |
| swe-1-7-fast | BYOK4 |

映射表在 `src/handlers/chat.js` 的 `MODEL_MAP`，可自行增删。

## 测试

```powershell
node test-e2e.mjs     # 端到端：CONNECT MITM → GetChatMessage → BYOK 回复
node test-debug.mjs   # 逐帧 dump Connect envelope 的 proto 字段
```

## 目录结构

```
setup-cert.mjs          首次证书生成 + 信任库安装
.env.example            配置模板
src/
  env-loader.mjs        .env 自加载（须在 import 链首位）
  hybrid-server.js      MITM 入口 + RPC 路由
  handlers/
    chat.js             GetChatMessage 翻译核心（MODEL_MAP 在此）
    parse-request.js    Devin proto → 中间格式（字段号映射）
    build-response.js   中间格式 → Devin 响应帧
    openai-stream.js    OpenAI SSE → Devin delta 流
    anthropic-stream.js Anthropic SSE → Devin delta 流
    ...
  vendor/node-forge/    证书生成依赖（vendored，BSD/GPL 双许可）
test-e2e.mjs            端到端测试
```

## 已知边界

- **官方 uid 依赖**：BYOK 模型名借官方 uid，Devin 下架某 uid 时该槽位路由失效
  （改 MODEL_MAP 一行即可重新映射）
- **透传 RPC 仍走真 Codeium**：登录态、模型目录、团队白名单是官方的；
  账号异常会影响这些（聊天本身不经过官方计费）
- **网关必须先于 Devin 启动**：CLI 出站全部走代理，网关不在则连不上
  （停止用 stop-devin-byok.cmd；不用 BYOK 时删掉 settings.json 的 agentEnv 恢复）
- **proto 漂移**：Devin 后端改 GetChatMessage 字段时需要重新适配
  （参考 [devin2api](https://github.com/WncFht/devin2api) 的 proto 提取工具链）

## 安全提示

- MITM 意味着网关能解密 devin-cli 与 server.codeium.com 之间的全部流量——
  本项目只在本地回环跑，不要暴露到网络
- rootCA 私钥在 `~/.devin-byok/certs/rootCA-key.pem`，勿外传
- .env 含 API key，已在 .gitignore 里

## 致谢与许可

- [jornlin/devin-model-pro](https://github.com/)（MIT, © 2024 ycx932436 /
  © 2026 jornlin）——协议翻译层与 MITM 网关的原实现
- [Yimikami/cursor-byok](https://github.com/Yimikami/cursor-byok)——架构参照
- [WncFht/devin2api](https://github.com/WncFht/devin2api)——Devin proto 逆向成果
- node-forge（BSD-3-Clause OR GPL-2.0）

本项目 MIT 许可，见 [LICENSE](LICENSE)。

# OpenCode 集成验证指南

这份文档用于验证 `OpenCode -> 本地平台 daemon -> 平台上下文/记忆` 这条链是否已经接通。

## 前置条件

- 已执行过 plugin 安装
- OpenCode 配置文件里已经有平台 plugin
- 当前项目路径是 `E:\vibecoding\sdk\V1`

你可以先确认配置里存在 plugin：

```powershell
Select-String -Path C:\Users\zxm\.config\opencode\opencode.json -Pattern 'ctx-platform-plugin\.mjs' -Context 0,2
```

## 1. 启动本地平台 daemon

在项目根目录运行：

```powershell
cd E:\vibecoding\sdk\V1
npm run opencode:daemon
```

看到下面这类输出说明 daemon 已启动：

```text
[ctx-opencode-daemon] listening on http://127.0.0.1:4317
```

## 2. 检查 daemon 健康状态

新开一个终端，执行：

```powershell
Invoke-RestMethod http://127.0.0.1:4317/health
```

期望返回类似：

```powershell
ok        : True
host      : 127.0.0.1
port      : 4317
bindings  : 0
memories  : 0
```

## 3. 手动写入一条平台记忆

执行：

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:4317/v1/memory/remember `
  -ContentType 'application/json' `
  -Body '{"directory":"E:\\vibecoding\\sdk\\V1","title":"Preference","content":"User prefers concise architectural summaries."}'
```

这会往本地平台 daemon 里写一条确认记忆。

## 4. 检查平台状态

执行：

```powershell
Invoke-RestMethod http://127.0.0.1:4317/v1/state
```

重点检查：

- `memories` 里是否有刚才写入的记录
- `sessions` 和 `tasks` 后续在 OpenCode 实际聊天后会逐步出现

## 5. 手动检查当前 system context

在不打开 OpenCode 的情况下，也可以直接确认平台会返回什么上下文：

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:4317/v1/context/system `
  -ContentType 'application/json' `
  -Body '{"directory":"E:\\vibecoding\\sdk\\V1","opencodeSessionId":"ses_manual_test","model":"gpt-5"}'
```

期望返回里的 `system` 包含类似内容：

```text
[WORKSPACE] E:\vibecoding\sdk\V1

[TASK]
Title: OpenCode Active Task
Objective: Active OpenCode session for E:\vibecoding\sdk\V1

[MEMORY]
- Preference: User prefers concise architectural summaries.
```

这一步说明平台上下文拼装已经正常。

## 6. 在 VSCode 的 OpenCode 中验证

1. 保持 daemon 运行
2. 重启 VSCode 里的 OpenCode
3. 打开工作区 `E:\vibecoding\sdk\V1`
4. 在 OpenCode 中正常提问

推荐验证问题：

```text
What communication style do I prefer?
```

或者：

```text
Summarize this repo in the style you know I prefer.
```

如果 plugin 和 daemon 都生效，OpenCode 的 system hook 会拿到平台上下文，回答里应体现那条 preference memory。

## 7. 验证成功的判断标准

- `npm run opencode:daemon` 能稳定启动
- `/health` 返回 `ok: true`
- `/v1/memory/remember` 能成功写入
- `/v1/state` 里能看到 memory 记录
- `/v1/context/system` 返回内容里包含 `[MEMORY]`
- OpenCode 实际回答能体现平台记忆

## 8. 已知限制

- 当前 daemon 是内存态，重启后数据会丢失
- 当前主要验证的是透明 system-context 注入和基础记忆回流
- 如果 OpenCode 本机 runtime/plugin 自身崩溃，问题可能不在平台侧

## 9. 常见错误

### 9.1 `npm error enoent Could not read package.json`

原因：
你不在项目根目录运行命令。

修复：

```powershell
cd E:\vibecoding\sdk\V1
npm run opencode:daemon
```

或者：

```powershell
npm --prefix E:\vibecoding\sdk\V1 run opencode:daemon
```

### 9.2 `/health` 连接失败

原因：

- daemon 没启动
- daemon 启动后立刻报错退出

修复：

- 回到 daemon 终端看报错
- 确认端口 `4317` 没被占用

### 9.3 OpenCode 没体现平台记忆

排查顺序：

1. 先看 `/v1/state` 里有没有 memory
2. 再看 `/v1/context/system` 里有没有 `[MEMORY]`
3. 确认 OpenCode 已重启
4. 确认当前工作区路径和写记忆时的 `directory` 一致

## 10. 相关文件

- [直接安装文档](/e:/vibecoding/sdk/V1/docs/opencode-direct-install.md)
- [plugin](/e:/vibecoding/sdk/V1/plugins/opencode/ctx-platform-plugin.mjs)
- [daemon](/e:/vibecoding/sdk/V1/scripts/opencode-platform-daemon.mjs)
- [安装脚本](/e:/vibecoding/sdk/V1/scripts/install-opencode-plugin.mjs)

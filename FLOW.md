# MCP：WSL(Ubuntu) -> `powershell.exe` -> Windows 程序（以 `hdc.exe` 为例）

## 1) 目标与约束

- **目标**：创建一个 MCP Server（推荐 stdio 传输），使得运行在 Windows10 的 WSL Ubuntu 内的客户端（Codex / Claude Code / Claude Desktop 等）能够稳定调用 Windows 环境下的程序（`.exe`），并返回 `stdout/stderr/exitCode`。
- **重点难点**：跨多层解析边界（WSL shell → PowerShell → Win32 程序 →（可选）设备端 shell）时的**参数转义**、**路径转换**、**管道边界**与**超时/非交互**控制。

参考资料（用于关键结论，不要求逐字照搬）：
- WSL interop / 文件系统与跨系统命令：`https://learn.microsoft.com/en-us/windows/wsl/filesystems`
- `powershell.exe` 参数（尤其 `-EncodedCommand`/`-NonInteractive`）：`https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1`
- MCP schema / 工具调用结构：`https://github.com/modelcontextprotocol/specification`（例如 `schema/2025-11-25/schema.json`）

---

## 2) 运行时总体架构（数据流）

```
User / LLM
  -> MCP Client (stdio)
    -> MCP Server（运行在 WSL Ubuntu）
      -> powershell.exe（Windows PowerShell，经由 WSL interop）
        -> Windows .exe（hdc.exe / cmd.exe / 其他）
          -> (可选) 设备端 shell（hdc shell <cmd>）
      <- 捕获 stdout/stderr/exitCode
    <- tools/call result
  <- LLM 使用输出继续推理/执行
```

---

## 3) MCP 协议层交互流程（最小闭环）

1. **Client 启动 Server**（stdio：子进程方式，stdin/stdout 传 JSON-RPC）。
2. **initialize**：Client → Server；Server 回 `InitializeResult`（capabilities、版本等）。
3. **tools/list**：Client 获取工具列表（Tool：`name/description/inputSchema/...`）。
4. **tools/call**：Client 调用工具；Server 回 `CallToolResult`：
   - `content`: `[{ "type": "text", "text": "..." }]`
   - `structuredContent`: `{ exitCode, stdout, stderr, ... }`（强烈建议）
   - `isError`: `true/false`

---

## 4) 工具设计（建议的最小集合）

### 4.1 `win.exec`（核心）

用途：在 Windows 侧执行一个 `.exe`，并把结果结构化返回。

建议输入（arguments）：
- `exe`：string（如 `C:\\Tools\\hdc\\hdc.exe` 或 `hdc.exe`）
- `args`：string[]（已分词的参数数组，**不要**让 Server 再做 shell 解析）
- `cwd`：string?（WSL 或 Windows 路径）
- `timeoutMs`：number?（默认值可由 Server 配置）
- `env`：object?（可选；建议只 allowlist 必要变量）

建议输出（structuredContent）：
- `exitCode`：number
- `stdout`：string
- `stderr`：string
- `durationMs`：number
- `command`：`{ exe, args, cwd? }`

Tool annotations（用于提示客户端 UI/策略，非强制）：
- `openWorldHint: true`（会触达系统/设备）
- `destructiveHint: true`（除非明确只读子命令）

### 4.2 `path.wsl_to_win` / `path.win_to_wsl`（建议）

用途：给“需要 Windows 路径的参数”做转换，避免让模型/用户手写转义。

- `path.wsl_to_win`: 使用 `wslpath -w`
- `path.win_to_wsl`: 使用 `wslpath -u`

### 4.3 `hdc.run` / `hdc.shell`（可选，但推荐）

目的：把 `hdc` 的易错点封装掉，尤其是 **`hdc shell` 的管道边界**。

- `hdc.run`：封装 `win.exec`，自动带上 `HDC_EXE` 与可选 `-t <connectKey>`
- `hdc.shell`：专门执行设备端命令，保证把整段命令作为**单一参数**传递给 `hdc shell`

`hdc.shell` 建议输入：
- `connectKey`: string
- `command`: string（设备端 shell 命令原文，例如 `ls ... | wc -l`）
- `timeoutMs`: number?
- `useBusybox`: boolean?（设备缺 `wc/grep` 时切到 `busybox wc -l` 等策略）

---

## 5) Server 内部执行流程（关键：`-EncodedCommand` + 参数数组）

### 5.1 为什么不直接拼 `-Command "<string>"`

跨层 quoting 很容易炸：`' " | { } \` 等字符在不同层含义不同。尤其当你需要把“设备端管道”传进去时，`|` 会被 PowerShell 当作主机管道解析，导致错误（PROMPT.md 已指出）。

因此推荐用 `-EncodedCommand`：把 PowerShell 脚本按 **UTF‑16LE** 编码再 Base64（微软文档明确要求）。

### 5.2 推荐的 PowerShell 启动参数

`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <base64>`

说明：
- `-NoProfile`：避免加载用户 profile 产生副作用
- `-NonInteractive`：避免 `Read-Host`/确认提示把 Server 卡死
- `-ExecutionPolicy Bypass`：只作用于当前会话（可按需保留/删除）

### 5.3 “传参不出坑”的两种方式

**方式 A（简单但要正确转义）**：在生成的 PS 脚本里构造数组并 splat

```powershell
$exe = 'C:\Tools\hdc\hdc.exe'
$args = @('-t','xxx','shell','ls /data | wc -l')
& $exe @args
exit $LASTEXITCODE
```

要点：所有外部输入都要正确转义为 PowerShell 字符串，避免注入/语法错误。

**方式 B（更稳，推荐）**：PS 脚本固定为“读 JSON → 执行”，请求数据走 stdin

```powershell
$req = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($req.cwd) { Set-Location -LiteralPath $req.cwd }
& $req.exe @($req.args)
exit $LASTEXITCODE
```

要点：
- 避免把参数“嵌入脚本字符串”从而减少转义错误
- 代价：stdin 被用于传请求数据；目标程序若需要 stdin，就要改用方式 A 或用临时文件/环境变量传请求

### 5.4 cwd 与路径转换策略

WSL 官方要点：
- WSL 下运行 Windows 程序必须带 `.exe`，例如 `notepad.exe`、`powershell.exe`
- CMD 内置命令用 `cmd.exe /C <cmd>` 调用
- `wslpath -w/-u` 用于路径互转

建议策略：
- `cwd` 一律在 Server 内做转换：WSL 路径 → Windows 路径，再在 PS 内 `Set-Location -LiteralPath`
- 对参数是否“路径”不要盲转：提供 `path.*` 工具或在 `hdc.file.*` 这类 wrapper 内按字段转

---

## 6) `hdc shell` 的管道边界规则（核心坑的流程化约束）

目标：让 `ls ... | wc -l` 在**设备端**执行，而不是在 **Windows PowerShell** 执行。

规则：凡是希望在设备端执行的命令，必须整体作为一个字符串参数传给 `hdc shell`。

- ✅ 正确：`hdc.exe ... shell "ls /data/... | wc -l"`
- ❌ 错误：`hdc.exe ... shell ls /data/... | wc -l`（`| wc -l` 会在 Windows 上执行）

因此 `hdc.shell` 工具在实现上要**强制**把 `command` 当作单一参数，而不是让调用者拼整行命令。

---

## 7) 部署/接入流程（面向不同客户端）

### 7.1 Server 运行位置

- **推荐**：MCP Server 运行在 WSL 内（最直接：能调用 `powershell.exe`/Windows `.exe`）。
- **Claude Desktop（Windows）**：让 Claude Desktop 用 `wsl.exe -d <Distro> -- <server>` 启动 WSL 内的 server 进程（具体配置项名称以客户端实现为准，但核心是“command= wsl.exe / args= ...”）。

### 7.2 Server 配置建议（环境变量）

- `WIN_PS_EXE`：默认 `powershell.exe`（可切 `pwsh.exe`）
- `HDC_EXE`：`hdc.exe` 或绝对路径（如 `C:\\Tools\\hdc\\hdc.exe`）
- `ALLOW_EXE`：逗号分隔 allowlist（默认只允许 `hdc.exe`，降低风险）
- `DEFAULT_TIMEOUT_MS`：默认超时

---

## 8) 安全与可用性建议（流程层面的“护栏”）

- **默认最小权限**：优先只暴露 `hdc.*`，或对 `win.exec` 做严格 allowlist。
- **非交互 + 超时**：任何工具调用都必须可超时；PowerShell 用 `-NonInteractive`。
- **结构化结果**：总是返回 `structuredContent`（`exitCode/stdout/stderr`），让模型能可靠分支。
- **破坏性操作二次确认**：例如 `hdc kill/start -r/install/uninstall` 等，要求 `confirm: true` 或显式 `dryRun` 支持（并把规则写进 tool 描述）。

---

## 9) 最小验收清单（建议逐项跑通）

- `win.exec`：能跑 `powershell.exe -NoProfile -Command "Get-Date"`、`cmd.exe /C dir`
- `hdc.run`：能跑 `hdc.exe -v` / `hdc list targets`
- `hdc.shell`：能跑 `echo hello`、`ls ... | grep ...`，确认管道在设备端执行
- 错误路径/进程超时/非零退出码：都能正确返回 `isError/exitCode/stderr`


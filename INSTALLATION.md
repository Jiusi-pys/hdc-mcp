# 安装与部署教学（WSL + Windows）

## 1. 前提条件

- **宿主机**：Windows 10/11，已启用 WSL2 并安装 Ubuntu（或其它 Linux 发行版）。
- **工具链**：在 Ubuntu 中能访问 `powershell.exe`（默认可用）、`wslpath`、`node`、`npm`。
- **hdc.exe**：位于 Windows 端，例如 `C:\Tools\hdc\hdc.exe`，且可通过 WSL 中 `hdc.exe` 命令调用。
- **Claude Desktop 客户端**：运行在 Windows（不是 WSL），会通过指定的 `command`/`args` 启动 WSL 中的 MCP server。

## 2. WSL 内部署 MCP Server

1. 进入 WSL Ubuntu，然后到项目目录（含 `package.json` 和 `server.js`）。

    ```bash
    cd /path/to/wsl-win-mcp-server
    ```

2. 安装依赖。

    ```bash
    npm install
    ```

3. 启动服务（可用 `tmux`/`screen` 保持后台）。

    ```bash
    node server.js
    ```

    - 默认等待来自 stdio 的 MCP 客户端连接（例如 Claude Desktop 启动的 stdio）。
    - 运行时可通过环境变量定制：
      - `WIN_PS_EXE=pwsh.exe`
      - `HDC_EXE=C:\Tools\hdc\hdc.exe`
      - `DEFAULT_TIMEOUT_MS=45000`
      - `ALLOW_EXE=hdc.exe,powershell.exe,cmd.exe`

## 3. 在各 MCP 客户端中添加此 Server

### 3.1 Claude Desktop（Windows）

Claude Desktop 在 Windows 上运行，通过配置文件 `claude_desktop_config.json` 启动 WSL 内的 stdio MCP server。

1. 在 Windows 打开（或新建）：

   `C:\Users\<你的用户名>\AppData\Roaming\Claude\claude_desktop_config.json`

2. 在 `mcpServers` 下添加一段（示例）：

   ```json
   {
     "mcpServers": {
       "wsl-win-hdc": {
         "command": "wsl.exe",
         "args": [
           "-d",
           "Ubuntu",
           "--",
           "node",
           "/home/<user>/hdc-mcp/server.js"
         ],
         "env": {
           "HDC_EXE": "C:\\Tools\\hdc\\hdc.exe",
           "WIN_PS_EXE": "powershell.exe",
           "DEFAULT_TIMEOUT_MS": "30000",
           "ALLOW_EXE": "hdc.exe,powershell.exe,cmd.exe"
         }
       }
     }
   }
   ```

3. 保存后重启 Claude Desktop，在工具/MCP 面板中启用 `wsl-win-hdc`。

### 3.2 Claude Code（VS Code 插件）

1. 在 VS Code 中按 `Ctrl+Shift+P` → “Preferences: Open Settings (JSON)”。
2. 在 `settings.json` 添加（或合并）：

   ```json
   {
     "claude.mcpServers": {
       "wsl-win-hdc": {
         "command": "wsl.exe",
         "args": [
           "-d",
           "Ubuntu",
           "--",
           "node",
           "/home/<user>/hdc-mcp/server.js"
         ],
         "env": {
           "HDC_EXE": "C:\\Tools\\hdc\\hdc.exe",
           "WIN_PS_EXE": "powershell.exe",
           "DEFAULT_TIMEOUT_MS": "30000",
           "ALLOW_EXE": "hdc.exe,powershell.exe,cmd.exe"
         }
       }
     }
   }
   ```

3. 重启 VS Code 或重新加载窗口，在 Claude Code 中启用 `wsl-win-hdc`。

### 3.3 Codex / 其他 MCP 客户端

不同 MCP 客户端的配置格式不完全相同，但核心字段都是类似的 `command` / `args` / `env`。可以参考如下伪配置：

```yaml
mcpServers:
  wsl-win-hdc:
    type: stdio
    command: wsl.exe
    args:
      - -d
      - Ubuntu
      - --
      - node
      - /home/<user>/hdc-mcp/server.js
    env:
      HDC_EXE: C:\Tools\hdc\hdc.exe
      WIN_PS_EXE: powershell.exe
      DEFAULT_TIMEOUT_MS: "30000"
      ALLOW_EXE: hdc.exe,powershell.exe,cmd.exe
```

在 Codex 的配置文件中，将上述 `command` / `args` / `env` 对应填入即可。

## 4. 工具使用示例（通过 MCP Client 模拟/推理）

```json
# win.exec（运行 Get-Date）
{"name":"win.exec","arguments":{"exe":"powershell.exe","args":["-NoProfile","-Command","Get-Date"]}}

# hdc.run（获取版本）
{"name":"hdc.run","arguments":{"args":["-v"]}}

# hdc.shell（设备管道）
{"name":"hdc.shell","arguments":{"connectKey":"ec29...","command":"ls /data/robot/usr/lib | wc -l"}}
```

## 5. 设备级管道/路径注意

- 管道必须在 `hdc.shell` 的 `command` 字符串内部完成（`\|` 不能分割到主机）。
- 若命令包含 Windows 路径，请先用 `path.wsl_to_win` 转换，以避免反斜杠转义问题。
- `win.exec` 的 `cwd` 以 WSL 路径输入，在内部会转换为 Windows 格式。

## 6. 故障排查小贴士

- **服务无响应**：确认 WSL 内 `node server.js` 没报错，stdout/ stderr 显示正在等待连接。
- **Claude Desktop 连接失败**：检查 `command`/`args` 路径是否正确，WSL 是否允许 `node` 执行。
- **hdc shell 报 `wc` 找不到**：确保 `command` 内已经把 `| wc -l` 传进 `hdc shell` 字符串，或加 `busybox` 前缀（`useBusybox`）。

## 7. 建议的下步

1. 根据 `FLOW.md` 加入更多工具（如 `hdc.file.recv`、`task` 工具）。
2. 搭建 Claude Desktop profile，并通过 `hdc.shell` 检查具体设备命令执行情况。
3. 将 Server 包装成 systemd/wslservice 脚本，确保重启后自动恢复。

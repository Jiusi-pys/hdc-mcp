# hdc mcp

Node.js MCP stdio server：在 WSL(Ubuntu) 中通过 `powershell.exe -EncodedCommand` 调用 Windows 程序（如 `hdc.exe`），并提供 `hdc.*`/`rk3588s.*` 工具供 Claude Code / Claude Desktop / Codex 调用。

- 安装与接入：`INSTALLATION.md`
- 设计流程：`FLOW.md`

## 快速开始（WSL 内）

```bash
npm install
node server.js
```

## 工具概览

- `win.exec`：运行任意 Windows `.exe`（经由 `powershell.exe -EncodedCommand`）
- `path.wsl_to_win` / `path.win_to_wsl`：路径互转
- `hdc.run`：运行 `hdc.exe ...`
- `hdc.list_targets`：列出设备/获取 connectKey
- `hdc.shell`：执行设备端命令（管道必须在同一 `command` 字符串里）
- `rk3588s.shell` / `rk3588s.dir_tree`：包含 `rk3588s` 关键词的快捷工具（需设置 `RK3588S_CONNECTKEY`）

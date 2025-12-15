# Project memory (Claude Code)

## Device vs local files

- **RK3588 / RK3588S / “board” / “device” 指的是外接设备**，不是本机/项目目录。
- 只要用户的问题是在问 **设备端文件系统/目录结构/进程/日志**，就应优先使用本项目的 **HDC MCP 工具**，不要先用本地 `ls/find/rg` 去“猜”设备端情况。

## How to use the HDC MCP tools

- **发现设备 / 获取 connectKey**：先调用 `hdc.list_targets`（或 `hdc.run` 的 `list targets [-v]`）。
- **执行设备端命令**：用 `hdc.shell`（管道必须写在同一个 `command` 字符串里）。
- **RK3588S 快捷工具**：
  - `rk3588s.shell`：当环境变量 `RK3588S_CONNECTKEY` 已配置时，优先用它执行设备端命令。
  - `rk3588s.dir_tree`：当用户说“看目录结构/目录树”时优先用它（默认用 `find`/`busybox find`）。

## Directory structure guideline

当用户说“看看 rk3588s 的目录结构”但没有给路径：

1. 先问清楚要看的路径（例如 `/`、`/data`、`/system`、某个工程目录），以及期望深度（默认 3 层）。
2. 如果已经配置了 `RK3588S_CONNECTKEY`，优先调用 `rk3588s.dir_tree`。
3. 否则：先 `hdc.list_targets -v` → 拿到 connectKey → 再 `hdc.shell` 执行 `busybox find ... -maxdepth ...`。

## Important shell boundary rule

设备端管道命令必须整体作为一个参数传入 `hdc shell`：

- ✅ `hdc.shell { command: "ls /path | wc -l" }`
- ❌ `hdc shell ls /path | wc -l`（`| wc -l` 会在主机 PowerShell 上执行）


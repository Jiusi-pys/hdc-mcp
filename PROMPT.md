# 目标

我需要创建一个 mcp 工具，可以提供给 codex、claude code、claude desktop 等工具调用。其作用是使得 windows 系统下 WSL 子系统 ubuntu 能过通过内置 powershell.exe 程序调用 windows 环境下的程序。

---

# 前提知识

当前宿主机运行环境为**windows 10 WSL ubuntu**，ubuntu内置`powershell.exe`程序使得`WSL ubuntu`能进入`powershell`环境执行**windows**程序。

**hdc help**
`hdc`是运行在windows系统下的一个与kaihongOS设备连接、控制的工具。
以下为`hdc`执行结果：
```powershell
 -h/help [verbose]                     - Print hdc help, 'verbose' for more other cmds
 -v/version                            - Print hdc version
 -t connectkey                         - Use device with given connect key

---------------------------------component commands:-------------------------------
session commands(on server):
 list targets [-v]                     - List all devices status, -v for detail
 start [-r]                            - Start server. If with '-r', will be restart server
 kill [-r]                             - Kill server. If with '-r', will be restart server

service commands(on daemon):
 target mount                          - Set /system /vendor partition read-write
 target boot [-bootloader|-recovery]   - Reboot the device or boot into bootloader\recovery.
 target boot [MODE]                    - Reboot the into MODE.
 smode [-r]                            - Restart daemon with root permissions, '-r' to cancel root
                                         permissions
 tmode usb                             - Reboot the device, listening on USB
 tmode port [port]                     - Reboot the device, listening on TCP port

---------------------------------task commands:-------------------------------------
file commands:
 file send [option] local remote       - Send file to device
 file recv [option] remote local       - Recv file from device
                                         option is -a|-s|-z
                                         -a: hold target file timestamp
                                         -sync: just update newer file
                                         -z: compress transfer
                                         -m: mode sync

forward commands:
 fport localnode remotenode            - Forward local traffic to remote device
 rport remotenode localnode            - Reserve remote traffic to local host
                                         node config name format 'schema:content'
                                         examples are below:
                                         tcp:<port>
                                         localfilesystem:<unix domain socket name>
                                         localreserved:<unix domain socket name>
                                         localabstract:<unix domain socket name>
                                         dev:<device name>
                                         jdwp:<pid> (remote only)
 fport ls                              - Display forward/reverse tasks
 fport rm taskstr                      - Remove forward/reverse task by taskstring

app commands:
 install [-r|-s] src                   - Send package(s) to device and install them
                                         src examples: single or multiple packages and directories
                                         (.hap .hsp)
                                         -r: replace existing application
                                         -s: install shared bundle for multi-apps
 uninstall [-k] [-s] package           - Remove application package from device
                                         -k: keep the data and cache directories
                                         -s: remove shared bundle

debug commands:
 hilog [-h]                            - Show device log, -h for detail
 shell [COMMAND...]                    - Run shell command (interactive shell if no command given)
 bugreport [FILE]                      - Return all information from the device, stored in file if FILE is specified
 jpid                                  - List pids of processes hosting a JDWP transport

security commands:
 keygen FILE                           - Generate public/private key; key stored in FILE and FILE.pub
```

**powershell.exe 教程**:
```markdown

**powershell‑wsl2 — 在 WSL2 调用 Windows PowerShell 的简明指令**

```powershell
powershell.exe -NoProfile [-NonInteractive] [-ExecutionPolicy <Policy>] -Command "<PowerShell命令>"
powershell.exe -NoProfile [-ExecutionPolicy <Policy>] -File "<Windows脚本路径>" [参数…]
pwsh.exe   # PowerShell 7，语法同上
```

### 要点说明

* WSL 支持直接运行 Windows 可执行文件；必须带 `.exe` 扩展名且大小写一致。因此在 WSL 下使用宿主机的 PowerShell 时直接调用 `powershell.exe` 或 `pwsh.exe` 即可。
* 这些 Windows 程序继承当前 WSL 会话的工作目录与权限，并能与 Linux 命令混合使用管道、重定向等标准操作。
* CMD 内置命令（如 `dir`）需借助 `cmd.exe /C` 调用；例如 `cmd.exe /C dir` 用于列出 Windows 目录。
* 需要在 WSL 路径与 Windows 路径间转换时，可使用 `wslpath -w`（WSL→Windows）和 `wslpath -u`（Windows→WSL）避免反斜杠转义。
* 执行 PowerShell 脚本时如遇执行策略限制，可使用 `-ExecutionPolicy Bypass` 临时绕过；在 `-Command` 里嵌入脚本时建议用 Bash 单引号包裹整段命令，避免不必要的转义。

### 示例

```powershell
# 获取当前时间
powershell.exe -NoProfile -Command "Get-Date"

# 调用 Windows 脚本并传参
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Scripts\deploy.ps1" arg1 arg2

# 在 PowerShell 中列出当前 WSL 工作目录
WINPWD=$(wslpath -w "$PWD"); powershell.exe -NoProfile -Command "Get-ChildItem -Path '$WINPWD'"

# 混合 Windows 和 Linux 命令：列出并过滤文件
ls -la | findstr.exe ".ps1":contentReference[oaicite:5]{index=5}
```

```

**注意事项**:
````markdown
# PowerShell + hdc shell 管道命令错误分析

## 一、错误现象

执行以下命令时报错：

```bash
powershell.exe -NoProfile -Command "& 'C:\Tools\hdc\hdc.exe' -t ec29004133314d38433031a77ccc3c00 shell ls /data/robot/usr/lib | findstr ros"
````

```bash
powershell.exe -NoProfile -Command "& 'C:\Tools\hdc\hdc.exe' -t ec29004133314d38433031a77ccc3c00 shell ls /data/robot/usr/lib | wc -l"
```

错误信息核心为：

```text
wc : The term 'wc' is not recognized as the name of a cmdlet, function, script file, or operable program
```

---

## 二、根本原因

### 1. Shell 边界错误

命令被解析为：

```text
PowerShell
 ├─ hdc.exe shell ls /data/robot/usr/lib
 └─ | wc -l   （在 Windows 本机执行）
```

而不是期望的：

```text
设备端 shell
 └─ ls /data/robot/usr/lib | wc -l
```

### 2. 具体问题点

* `|` 是 **PowerShell 管道**
* `wc`、`grep` 属于 **Linux / BusyBox 工具**
* PowerShell **不识别 `wc`**
* 未将管道命令整体交由 `hdc shell` 执行

---

## 三、正确执行原则

> **凡是希望在设备端执行的命令，必须整体作为字符串传入 `hdc shell`。**

---

## 四、正确写法示例

### 1. 在设备端执行管道（推荐）

```powershell
powershell.exe -NoProfile -Command `
"& 'C:\Tools\hdc\hdc.exe' -t ec29004133314d38433031a77ccc3c00 shell 'ls /data/robot/usr/lib | grep ros'"
```

```powershell
powershell.exe -NoProfile -Command `
"& 'C:\Tools\hdc\hdc.exe' -t ec29004133314d38433031a77ccc3c00 shell 'ls /data/robot/usr/lib | wc -l'"
```

如设备裁剪无 `wc`：

```powershell
"& 'C:\Tools\hdc\hdc.exe' -t xxx shell 'ls /data/robot/usr/lib | busybox wc -l'"
```

---

### 2. 在 Windows 端处理输出（明确分层）

```powershell
powershell.exe -NoProfile -Command `
"& 'C:\Tools\hdc\hdc.exe' -t xxx shell ls /data/robot/usr/lib" |
Select-String ros
```

```powershell
powershell.exe -NoProfile -Command `
"& 'C:\Tools\hdc\hdc.exe' -t xxx shell ls /data/robot/usr/lib" |
Measure-Object -Line
```

---

## 五、结论

* 错误本质：**主机 PowerShell 与设备 shell 的执行边界混淆**
* `| wc -l`、`| grep` 未被包入 `hdc shell`
* 导致 Linux 命令在 Windows 上执行而失败

```
```



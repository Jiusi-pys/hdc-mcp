import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

// Environment defaults / knobs
const DEFAULT_PS = process.env.WIN_PS_EXE || 'powershell.exe';
const DEFAULT_HDC_EXE = process.env.HDC_EXE || 'hdc.exe';
const DEFAULT_HDC_CONNECT_KEY = process.env.HDC_CONNECT_KEY || process.env.DEFAULT_CONNECT_KEY || '';
const RK3588S_CONNECT_KEY = process.env.RK3588S_CONNECTKEY || process.env.RK3588S_CONNECT_KEY || '';
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.DEFAULT_TIMEOUT_MS || '', 10) || 30000;
const ALLOW_EXE = (process.env.ALLOW_EXE || 'hdc.exe,powershell.exe,cmd.exe')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

// Zod schemas for tool inputs
const winExecSchema = z.object({
    exe: z.string().describe('Windows executable, e.g. hdc.exe or C:\\\\Tools\\\\hdc\\\\hdc.exe'),
    args: z.array(z.string()).optional().default([]),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    env: z.record(z.string(), z.string()).optional()
});

const pathSchema = z.object({
    path: z.string()
});

const hdcRunSchema = z.object({
    args: z.array(z.string()).optional().default([]),
    connectKey: z.string().optional(),
    timeoutMs: z.number().int().positive().optional()
});

const hdcShellSchema = z.object({
    connectKey: z.string().optional().describe('hdc connect key / device id (optional if HDC_CONNECT_KEY is set)'),
    command: z.string().describe('Device-side shell command, keep pipelines inside this string'),
    timeoutMs: z.number().int().positive().optional(),
    useBusybox: z.boolean().optional().describe('If true, wraps command with busybox sh -c "<command>"')
});

const hdcListTargetsSchema = z.object({
    verbose: z.boolean().optional().default(false),
    timeoutMs: z.number().int().positive().optional()
});

const rkShellSchema = z.object({
    command: z.string().describe('Device-side shell command for RK3588S, keep pipelines inside this string'),
    timeoutMs: z.number().int().positive().optional(),
    useBusybox: z.boolean().optional()
});

const rkDirTreeSchema = z.object({
    path: z.string().optional().default('/'),
    maxDepth: z.number().int().min(1).max(20).optional().default(3),
    dirsOnly: z.boolean().optional().default(true),
    timeoutMs: z.number().int().positive().optional()
});

const server = new McpServer(
    {
        name: 'wsl-win-bridge',
        version: '0.1.0'
    },
    {
        capabilities: {
            logging: {}
        }
    }
);

function encodePowerShellScript(script) {
    return Buffer.from(script, 'utf16le').toString('base64');
}

function quoteShSingle(str) {
    // POSIX shell single-quote escaping: ' -> '\'' (close quote, escaped quote, reopen)
    return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function normalizeAllowed(exe) {
    const lower = exe.toLowerCase();
    // On Linux (WSL), `path.basename()` won't treat `\` as a separator. Use win32 too.
    const basePosix = path.basename(lower);
    const baseWin32 = path.win32.basename(lower);
    const base = basePosix.length <= baseWin32.length ? basePosix : baseWin32;
    return { lower, base };
}

function ensureAllowedExe(exe) {
    if (!ALLOW_EXE.length) return;
    const { lower, base } = normalizeAllowed(exe);
    const ok = ALLOW_EXE.includes(lower) || ALLOW_EXE.includes(base);
    if (!ok) {
        throw new Error(`Executable "${exe}" not in allowlist: ${ALLOW_EXE.join(', ')}`);
    }
}

function toWindowsPathMaybe(inputPath) {
    if (!inputPath) return undefined;
    // If already looks like a Windows path, return as-is
    if (/^[a-zA-Z]:\\\\/.test(inputPath) || inputPath.includes('\\')) {
        return inputPath;
    }

    const res = spawnSync('wslpath', ['-w', inputPath], { encoding: 'utf8' });
    if (res.status !== 0) {
        throw new Error(res.stderr || `wslpath failed for ${inputPath}`);
    }
    return res.stdout.trim();
}

function wslToWinPath(inputPath) {
    const winPath = toWindowsPathMaybe(inputPath);
    if (!winPath) {
        throw new Error('Empty path');
    }
    return winPath;
}

function winToWslPath(inputPath) {
    if (!inputPath) throw new Error('Empty path');
    const res = spawnSync('wslpath', ['-u', inputPath], { encoding: 'utf8' });
    if (res.status !== 0) {
        throw new Error(res.stderr || `wslpath failed for ${inputPath}`);
    }
    return res.stdout.trim();
}

function buildPowerShellScript() {
    // Read request JSON from stdin, set cwd/env, run exe with arguments, propagate exit code.
    return `
$ErrorActionPreference = "Stop"
$raw = [Console]::In.ReadToEnd()
if (-not $raw) { exit 87 }
$req = $raw | ConvertFrom-Json

if (-not $req.exe) {
  Write-Error "Missing exe"
  exit 87
}

if ($req.cwd) {
  Set-Location -LiteralPath $req.cwd
}

if ($req.env) {
  foreach ($p in $req.env.PSObject.Properties) {
    $name = $p.Name
    if ($name) { $Env:$name = [string]$p.Value }
  }
}

$args = @()
if ($req.args) {
  foreach ($a in $req.args) {
    $args += [string]$a
  }
}

& $req.exe @args
exit $LASTEXITCODE
`;
}

async function runWinExec({ exe, args = [], cwd, timeoutMs, env }) {
    ensureAllowedExe(exe);
    const payload = {
        exe,
        args,
        cwd: cwd ? toWindowsPathMaybe(cwd) : undefined,
        env
    };

    const script = buildPowerShellScript();
    const encoded = encodePowerShellScript(script);
    const psArgs = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encoded
    ];

    const child = spawn(DEFAULT_PS, psArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
    }, timeoutMs || DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', chunk => {
        stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
        stderr += chunk.toString();
    });

    return await new Promise(resolve => {
        child.on('error', err => {
            clearTimeout(killTimer);
            resolve({
                exitCode: -1,
                stdout,
                stderr: `${stderr}\n${err?.message || ''}`,
                durationMs: Date.now() - started,
                timedOut: false
            });
        });

        child.on('close', code => {
            clearTimeout(killTimer);
            resolve({
                exitCode: timedOut ? null : code,
                stdout,
                stderr,
                durationMs: Date.now() - started,
                timedOut
            });
        });

        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
    });
}

function toContentText(result) {
    const { exitCode, timedOut } = result;
    if (timedOut) {
        return `Timed out after ${result.durationMs} ms`;
    }
    return `exitCode=${exitCode}\nstdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`;
}

function missingConnectKeyResult(hint) {
    return {
        exitCode: -1,
        stdout: '',
        stderr:
            hint ||
            'Missing connectKey. Provide arguments.connectKey, or set HDC_CONNECT_KEY / DEFAULT_CONNECT_KEY, or run hdc.list_targets.',
        durationMs: 0,
        timedOut: false
    };
}

async function runHdcRun({ args, connectKey, timeoutMs, useDefaultConnectKey = true }) {
    const resolved = connectKey || (useDefaultConnectKey ? DEFAULT_HDC_CONNECT_KEY : '');
    const exe = DEFAULT_HDC_EXE;
    const finalArgs = [];
    if (resolved) {
        finalArgs.push('-t', resolved);
    }
    finalArgs.push(...args);
    const result = await runWinExec({ exe, args: finalArgs, timeoutMs });
    return { exe, args: finalArgs, connectKey: resolved || undefined, ...result };
}

async function runHdcShell({ connectKey, command, timeoutMs, useBusybox }) {
    const resolved = connectKey || DEFAULT_HDC_CONNECT_KEY;
    if (!resolved) {
        return { exe: DEFAULT_HDC_EXE, args: [], ...missingConnectKeyResult() };
    }

    const exe = DEFAULT_HDC_EXE;
    const args = ['-t', resolved, 'shell'];
    const deviceCommand = useBusybox ? `busybox sh -c "${command.replace(/"/g, '\\"')}"` : command;
    args.push(deviceCommand);
    const result = await runWinExec({ exe, args, timeoutMs });
    return { exe, args, connectKey: resolved, ...result };
}

// Tool: win.exec
server.registerTool(
    'win.exec',
    {
        title: 'Run Windows executable via powershell.exe',
        description:
            'Runs a Windows .exe from WSL through powershell.exe -EncodedCommand. Pipes/redirects must be encoded into arguments, not host shell.',
        inputSchema: winExecSchema,
        annotations: {
            openWorldHint: true
        }
    },
    async params => {
        const result = await runWinExec({
            exe: params.exe,
            args: params.args || [],
            cwd: params.cwd,
            timeoutMs: params.timeoutMs,
            env: params.env
        });

        return {
            content: [
                {
                    type: 'text',
                    text: toContentText(result)
                }
            ],
            structuredContent: result,
            isError: result.timedOut || (result.exitCode ?? 1) !== 0
        };
    }
);

// Tool: path.wsl_to_win
server.registerTool(
    'path.wsl_to_win',
    {
        title: 'Convert WSL path to Windows path',
        description: 'Uses wslpath -w to convert a WSL/Linux path to Windows path.',
        inputSchema: pathSchema,
        annotations: { readOnlyHint: true }
    },
    async ({ path }) => {
        try {
            const converted = wslToWinPath(path);
            return {
                content: [{ type: 'text', text: converted }],
                structuredContent: { path: converted },
                isError: false
            };
        } catch (err) {
            return {
                content: [{ type: 'text', text: String(err) }],
                structuredContent: { error: String(err) },
                isError: true
            };
        }
    }
);

// Tool: path.win_to_wsl
server.registerTool(
    'path.win_to_wsl',
    {
        title: 'Convert Windows path to WSL path',
        description: 'Uses wslpath -u to convert a Windows path to WSL/Linux path.',
        inputSchema: pathSchema,
        annotations: { readOnlyHint: true }
    },
    async ({ path }) => {
        try {
            const converted = winToWslPath(path);
            return {
                content: [{ type: 'text', text: converted }],
                structuredContent: { path: converted },
                isError: false
            };
        } catch (err) {
            return {
                content: [{ type: 'text', text: String(err) }],
                structuredContent: { error: String(err) },
                isError: true
            };
        }
    }
);

// Tool: hdc.run
server.registerTool(
    'hdc.run',
    {
        title: 'Run hdc.exe command on Windows side',
        description:
            'Runs hdc.exe (Windows) from WSL. If your task mentions RK3588/RK3588S/device, use hdc.* tools (not local ls/find).',
        inputSchema: hdcRunSchema,
        annotations: {
            openWorldHint: true
        }
    },
    async ({ args = [], connectKey, timeoutMs }) => {
        const result = await runHdcRun({ args, connectKey, timeoutMs, useDefaultConnectKey: true });
        return {
            content: [{ type: 'text', text: toContentText(result) }],
            structuredContent: result,
            isError: result.timedOut || (result.exitCode ?? 1) !== 0
        };
    }
);

// Tool: hdc.list_targets
server.registerTool(
    'hdc.list_targets',
    {
        title: 'List connected HDC targets',
        description: 'Lists devices/targets via `hdc list targets` (use this to discover connectKey before hdc.shell).',
        inputSchema: hdcListTargetsSchema,
        annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ verbose, timeoutMs }) => {
        const args = verbose ? ['list', 'targets', '-v'] : ['list', 'targets'];
        const result = await runHdcRun({ args, connectKey: undefined, timeoutMs, useDefaultConnectKey: false });
        return {
            content: [{ type: 'text', text: toContentText(result) }],
            structuredContent: result,
            isError: result.timedOut || (result.exitCode ?? 1) !== 0
        };
    }
);

// Tool: hdc.shell
server.registerTool(
    'hdc.shell',
    {
        title: 'Run device-side shell via hdc shell',
        description:
            'Executes a device shell command via `hdc shell` and keeps pipelines on the device. If user mentions RK3588/RK3588S, prefer this tool over local ls/find.',
        inputSchema: hdcShellSchema,
        annotations: {
            openWorldHint: true
        }
    },
    async ({ connectKey, command, timeoutMs, useBusybox }) => {
        const result = await runHdcShell({ connectKey, command, timeoutMs, useBusybox });

        return {
            content: [{ type: 'text', text: toContentText(result) }],
            structuredContent: result,
            isError: result.timedOut || (result.exitCode ?? 1) !== 0
        };
    }
);

// Tool: rk3588s.shell (alias, improves tool selection by keyword)
server.registerTool(
    'rk3588s.shell',
    {
        title: 'RK3588S device shell (via hdc)',
        description:
            'Device shell for RK3588S. Requires env RK3588S_CONNECTKEY (or RK3588S_CONNECT_KEY). Use this when the user asks about rk3588s filesystem.',
        inputSchema: rkShellSchema,
        annotations: { openWorldHint: true }
    },
    async ({ command, timeoutMs, useBusybox }) => {
        if (!RK3588S_CONNECT_KEY) {
            const result = missingConnectKeyResult(
                'Missing RK3588S_CONNECTKEY. Set it in MCP server env, or use hdc.list_targets + hdc.shell with connectKey.'
            );
            return {
                content: [{ type: 'text', text: toContentText(result) }],
                structuredContent: result,
                isError: true
            };
        }

        const result = await runHdcShell({
            connectKey: RK3588S_CONNECT_KEY,
            command,
            timeoutMs,
            useBusybox
        });

        return {
            content: [{ type: 'text', text: toContentText(result) }],
            structuredContent: result,
            isError: result.timedOut || (result.exitCode ?? 1) !== 0
        };
    }
);

// Tool: rk3588s.dir_tree (directory structure helper)
server.registerTool(
    'rk3588s.dir_tree',
    {
        title: 'RK3588S directory structure (via hdc)',
        description:
            'Lists a directory structure on RK3588S using find/busybox find with maxDepth. Requires env RK3588S_CONNECTKEY.',
        inputSchema: rkDirTreeSchema,
        annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ path: devicePath, maxDepth, dirsOnly, timeoutMs }) => {
        if (!RK3588S_CONNECT_KEY) {
            const result = missingConnectKeyResult(
                'Missing RK3588S_CONNECTKEY. Set it in MCP server env, or use hdc.list_targets + hdc.shell with connectKey.'
            );
            return {
                content: [{ type: 'text', text: toContentText(result) }],
                structuredContent: result,
                isError: true
            };
        }

        const quotedPath = quoteShSingle(devicePath);
        const typeFlag = dirsOnly ? '-type d ' : '';
        const commandsToTry = [
            `cd ${quotedPath} && busybox find . -maxdepth ${maxDepth} ${typeFlag}-print`,
            `cd ${quotedPath} && find . -maxdepth ${maxDepth} ${typeFlag}-print`,
            `cd ${quotedPath} && ls -la`
        ];

        let last = null;
        for (const cmd of commandsToTry) {
            // Don't wrap with busybox sh -c here; we are already explicitly calling busybox/find.
            const res = await runHdcShell({
                connectKey: RK3588S_CONNECT_KEY,
                command: cmd,
                timeoutMs,
                useBusybox: false
            });
            last = { ...res, attemptedCommand: cmd };
            if (!res.timedOut && res.exitCode === 0) {
                return {
                    content: [{ type: 'text', text: toContentText(last) }],
                    structuredContent: last,
                    isError: false
                };
            }
        }

        return {
            content: [{ type: 'text', text: toContentText(last) }],
            structuredContent: last,
            isError: true
        };
    }
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(err => {
    // Avoid writing to stdout (reserved for MCP). Stderr is acceptable for diagnostics.
    console.error(err);
    process.exit(1);
});

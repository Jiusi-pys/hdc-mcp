import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

// Environment defaults / knobs
const DEFAULT_PS = process.env.WIN_PS_EXE || 'powershell.exe';
const DEFAULT_HDC_EXE = process.env.HDC_EXE || 'hdc.exe';
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
    env: z.record(z.string()).optional()
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
    connectKey: z.string().describe('hdc connect key / device id'),
    command: z.string().describe('Device-side shell command, keep pipelines inside this string'),
    timeoutMs: z.number().int().positive().optional(),
    useBusybox: z.boolean().optional().describe('If true, wraps command with busybox sh -c "<command>"')
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
        description: 'Wraps win.exec with an hdc.exe allowlist. Pipes must be device-side when using `hdc shell`.',
        inputSchema: hdcRunSchema,
        annotations: {
            openWorldHint: true
        }
    },
    async ({ args = [], connectKey, timeoutMs }) => {
        const exe = DEFAULT_HDC_EXE;
        const finalArgs = [];
        if (connectKey) {
            finalArgs.push('-t', connectKey);
        }
        finalArgs.push(...args);

        const result = await runWinExec({
            exe,
            args: finalArgs,
            timeoutMs
        });

        return {
            content: [{ type: 'text', text: toContentText(result) }],
            structuredContent: { exe, args: finalArgs, ...result },
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
            'Executes a device shell command through hdc.exe shell, ensuring the entire command (including pipes) stays on the device.',
        inputSchema: hdcShellSchema,
        annotations: {
            openWorldHint: true
        }
    },
    async ({ connectKey, command, timeoutMs, useBusybox }) => {
        const exe = DEFAULT_HDC_EXE;
        const args = [];
        if (connectKey) {
            args.push('-t', connectKey);
        }
        const deviceCommand = useBusybox
            ? `busybox sh -c "${command.replace(/"/g, '\\"')}"`
            : command;
        args.push('shell', deviceCommand);

        const result = await runWinExec({
            exe,
            args,
            timeoutMs
        });

        return {
            content: [{ type: 'text', text: toContentText(result) }],
            structuredContent: { exe, args, ...result },
            isError: result.timedOut || (result.exitCode ?? 1) !== 0
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

import { spawn, spawnSync } from "node:child_process";

// 参考 D:\code3\MuseDock@3cf8d392436983e9fa93f9cdf7aa3186780cd5dd/start-server.js：
// 保留单进程编排、带前缀输出和统一退出；workspace 与端口清理按映述调整。
const npmCli = process.env.npm_execpath;
const children = [];
let stopping = false;

if (!npmCli) throw new Error("请通过 npm run dev 或 npm run restart 运行此脚本");

if (process.argv.includes("--restart")) {
  if (process.platform !== "win32") {
    throw new Error("npm run restart 当前只支持 Windows");
  }
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "$processIds = @(Get-NetTCPConnection -State Listen -LocalPort 5175,3102 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); if ($processIds.Count) { Stop-Process -Id $processIds -Force; Write-Output ($processIds -join ',') }",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr.trim() || "结束旧进程失败");
  if (result.stdout.trim()) console.log(`已结束占用开发端口的进程：${result.stdout.trim()}`);
}

function start(name, workspace) {
  const child = spawn(process.execPath, [npmCli, "run", "dev", "--workspace", workspace], {
    env: { ...process.env, NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout.on("data", (data) => process.stdout.write(`[${name}] ${data}`));
  child.stderr.on("data", (data) => process.stderr.write(`[${name}] ${data}`));
  child.on("error", (error) => {
    console.error(`[${name}] 启动失败：${error.message}`);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping && code !== 0 && !signal) {
      console.error(`[${name}] 进程异常退出，退出码：${code}`);
      shutdown(code ?? 1);
    }
  });
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill();
  process.exit(code);
}

start("api", "@yingshu/server");
start("web", "@yingshu/web");
console.log("开发服务已启动：前端 http://localhost:5175，后端 http://localhost:3102");

process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());

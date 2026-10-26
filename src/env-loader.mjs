// devin-byok 独立运行：启动时自加载 gateway/.env
// 必须是模块依赖链的第一个 import（ESM import 按序执行，晚于本模块的模块才能读到 env）
import fs from "node:fs";

const envPath = new URL("../.env", import.meta.url);
try {
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(String.fromCharCode(10))) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
  console.log("[devin-byok] .env loaded");
} catch {
  console.log("[devin-byok] no .env found (using process env)");
}

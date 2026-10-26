// devin-byok 首次设置：生成 MITM 证书并安装根 CA 到系统信任库
// 用法: node setup-cert.mjs [--domain server.codeium.com] [--certs-dir <dir>] [--install/--no-install]
//
// 生成到 ~/.devin-byok/certs/（可用 --certs-dir 覆盖）：
//   rootCA.pem / rootCA-key.pem / <domain>.pem / <domain>-key.pem
// 安装信任:
//   Windows: certutil -addstore -f Root（CurrentUser，免管理员）
//   macOS:   security add-trusted-cert -k 用户 login keychain
//   Linux:   复制到 CA anchors + update-ca-certificates（需要 sudo/pkexec）
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "node:child_process";

const require = createRequire(import.meta.url);
const forge = require("./src/vendor/node-forge");

// ── 参数解析 ──
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const DOMAIN = argValue("--domain", "server.codeium.com");
const CERTS_DIR = argValue("--certs-dir", path.join(os.homedir(), ".devin-byok", "certs"));
const DO_INSTALL = !args.includes("--no-install");

const CA_CN = "devin-byok Root CA";

function createRootCA() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
  const attrs = [
    { name: "commonName", value: CA_CN },
    { name: "organizationName", value: "devin-byok" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}

function createServerCert(domain, caCertPem, caKeyPem) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(9));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  cert.setSubject([{ name: "commonName", value: domain }]);
  const caCert = forge.pki.certificateFromPem(caCertPem);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: domain }] },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(caKeyPem), forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}

function run(cmd) {
  return new Promise((resolve) => exec(cmd, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
}

async function isTrusted() {
  if (process.platform === "win32") {
    const r = await run('certutil -store Root "' + CA_CN + '"');
    return !r.err;
  }
  if (process.platform === "darwin") {
    const r = await run('security find-certificate -c "' + CA_CN + '"');
    return !r.err;
  }
  const isDebian = fs.existsSync("/etc/debian_version");
  const target = isDebian
    ? "/usr/local/share/ca-certificates/devin-byok.crt"
    : "/etc/pki/ca-trust/source/anchors/devin-byok.crt";
  return fs.existsSync(target);
}

async function installRootCA(certPath) {
  if (process.platform === "win32") {
    // CurrentUserRoot 免管理员；-user 限定当前用户存储
    const r = await run('certutil -user -addstore -f Root "' + certPath + '"');
    if (r.err) {
      // 兜底：机器存储（需要管理员）
      const r2 = await run('certutil -addstore -f Root "' + certPath + '"');
      if (r2.err) throw new Error(r2.stderr || r2.err.message);
      return "installed to LocalMachine Root";
    }
    return "installed to CurrentUser Root";
  }
  if (process.platform === "darwin") {
    const userKc = process.env.HOME + "/Library/Keychains/login.keychain-db";
    const r = await run('security add-trusted-cert -r trustRoot -p ssl -k "' + userKc + '" "' + certPath + '"');
    if (r.err) {
      const script = 'do shell script "security add-trusted-cert -d -r trustRoot -p ssl -k /Library/Keychains/System.keychain ' + "'" + certPath + "'" + '" with administrator privileges';
      const r2 = await run("osascript -e '" + script.replace(/'/g, "'\\''") + "'");
      if (r2.err) throw new Error(r2.stderr || r2.err.message);
      return "installed to System keychain";
    }
    return "installed to user login keychain";
  }
  const isDebian = fs.existsSync("/etc/debian_version");
  const dest = isDebian
    ? "/usr/local/share/ca-certificates/devin-byok.crt"
    : "/etc/pki/ca-trust/source/anchors/devin-byok.crt";
  const updateCmd = isDebian ? "update-ca-certificates" : "update-ca-trust";
  const r = await run('pkexec sh -c "cp ' + "'" + certPath + "' '" + dest + "'" + ' && ' + updateCmd + '"');
  if (r.err) throw new Error(r.stderr || r.err.message);
  return "installed to " + dest;
}

// ── 主流程 ──
fs.mkdirSync(CERTS_DIR, { recursive: true });
const caCertPath = path.join(CERTS_DIR, "rootCA.pem");
const caKeyPath = path.join(CERTS_DIR, "rootCA-key.pem");
const serverCertPath = path.join(CERTS_DIR, DOMAIN + ".pem");
const serverKeyPath = path.join(CERTS_DIR, DOMAIN + "-key.pem");

let ca;
if (fs.existsSync(caCertPath) && fs.existsSync(caKeyPath)) {
  ca = { cert: fs.readFileSync(caCertPath, "utf8"), key: fs.readFileSync(caKeyPath, "utf8") };
  console.log("[setup] 复用已有 rootCA: " + caCertPath);
} else {
  console.log("[setup] 生成 rootCA（10 年有效期）...");
  ca = createRootCA();
  fs.writeFileSync(caCertPath, ca.cert, "utf8");
  fs.writeFileSync(caKeyPath, ca.key, "utf8");
  console.log("[setup] rootCA 已生成: " + caCertPath);
}

console.log("[setup] 签发 " + DOMAIN + " 服务器证书...");
const server = createServerCert(DOMAIN, ca.cert, ca.key);
fs.writeFileSync(serverCertPath, server.cert, "utf8");
fs.writeFileSync(serverKeyPath, server.key, "utf8");
console.log("[setup] 服务器证书: " + serverCertPath);

if (!DO_INSTALL) {
  console.log("[setup] --no-install，跳过信任库安装");
} else if (await isTrusted()) {
  console.log("[setup] rootCA 已在系统信任库，跳过安装");
} else {
  try {
    const msg = await installRootCA(caCertPath);
    console.log("[setup] ✅ " + msg);
  } catch (e) {
    console.error("[setup] ❌ 自动安装失败: " + e.message);
    console.error("[setup] 请手动安装 " + caCertPath + " 到系统信任库（Windows: 双击 → 安装证书 → 受信任的根证书颁发机构）");
    process.exitCode = 1;
  }
}

console.log("");
console.log("[setup] 完成。下一步：");
console.log("  1. cp .env.example .env  并填入你的 API key");
console.log("  2. 在 .env 里设置 MITM_CERTS_DIR=" + CERTS_DIR.replace(/\\/g, "/"));
console.log("  3. node src/hybrid-server.js  启动网关");

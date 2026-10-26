// 端到端测试：模拟 devin-cli 的 GetChatMessage 请求（走 MITM 代理）
// 用法: node test-e2e.mjs
import https from "node:https";
import { URL } from "node:url";
import crypto from "node:crypto";
import zlib from "node:zlib";

const PROXY = "http://127.0.0.1:3006";
const TARGET_HOST = "server.codeium.com";

// ── proto 编码（最小 GetChatMessageRequest）──
function varint(n) {
  const out = [];
  let v = BigInt(n);
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v > 0n) b |= 128; out.push(b); } while (v > 0n);
  return Buffer.from(out);
}
function tag(field, wt) { return varint((field << 3) | wt); }
function strField(field, s) { const b = Buffer.from(s, "utf8"); return Buffer.concat([tag(field, 2), varint(b.length), b]); }
function msgField(field, b) { return Buffer.concat([tag(field, 2), varint(b.length), b]); }
function vintField(field, n) { return Buffer.concat([tag(field, 0), varint(n)]); }

// ChatMessageSource.USER=1
const userMsg = Buffer.concat([
  strField(1, "test-user-msg-001"),  // message_id
  vintField(2, 1),                    // source=USER
  strField(3, "你好，请用一句话介绍你自己"),  // prompt
]);

// ExaCodeiumCommonPb_Metadata 最小体（field 4=api_key）
const metadata = Buffer.concat([strField(4, "devin-session-token$mock")]);

const requestBody = Buffer.concat([
  msgField(1, metadata),              // metadata
  strField(2, "You are Devin, a test system prompt."),  // prompt (system)
  msgField(3, userMsg),               // chat_message_prompts[0]
  strField(21, "swe-1-6"),            // chat_model_uid → BYOK 槽位 1
  msgField(16, Buffer.from(strField(1, "00000000-0000-0000-0000-000000000040"))),  // cascade_id
  strField(22, crypto.randomUUID()),  // execution_id
]);

// Connect envelope（不压缩，flags=0）
const envelope = Buffer.concat([Buffer.from([0]), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(requestBody.length); return b; })(), requestBody]);

// ── 走 HTTPS 代理发请求（Node 标准代理 CONNECT）──
const proxyUrl = new URL(PROXY);

// 手动实现 CONNECT 隧道 + TLS MITM 验证
import net from "node:net";
import tls from "node:tls";

const sock = net.connect(parseInt(proxyUrl.port), proxyUrl.hostname, () => {
  sock.write(`CONNECT ${TARGET_HOST}:443 HTTP/1.1\r\nHost: ${TARGET_HOST}:443\r\n\r\n`);
});

let header = Buffer.alloc(0);
sock.on("data", function onConnect(chunk) {
  header = Buffer.concat([header, chunk]);
  const idx = header.indexOf("\r\n\r\n");
  if (idx === -1) return;
  const statusLine = header.slice(0, header.indexOf("\r\n")).toString();
  if (!statusLine.includes("200")) {
    console.error("CONNECT failed:", statusLine);
    sock.destroy();
    process.exit(1);
  }
  sock.removeListener("data", onConnect);
  const rest = header.slice(idx + 4);

  // TLS 握手（信任系统库；rootCA 已在 CurrentUser Root）
  const tlsSock = tls.connect({
    socket: sock,
    servername: TARGET_HOST,
    rejectUnauthorized: false,  // 测试脚本放宽；devin-cli 走系统信任库
  }, () => {
    console.log("[test] TLS established, cipher:", tlsSock.getCipher().name);
    console.log("[test] cert subject:", tlsSock.getPeerCertificate().subject?.CN);
    // 发 GetChatMessage
    const httpReq = [
      "POST /exa.api_server_pb.ApiServerService/GetChatMessage HTTP/1.1",
      "Host: " + TARGET_HOST,
      "content-type: application/connect+proto",
      "connect-protocol-version: 1",
      "authorization: Basic " + Buffer.from("devin-session-token$mock:").toString("base64"),
      "content-length: " + envelope.length,
      "",
      "",
    ].join("\r\n");
    tlsSock.write(httpReq);
    if (rest.length) tlsSock.write(rest);
    tlsSock.write(envelope);
  });

  let respBuf = Buffer.alloc(0);
  tlsSock.on("data", (d) => {
    respBuf = Buffer.concat([respBuf, d]);
    // 解析 HTTP 响应头
    if (!respBuf.includes(Buffer.from("\r\n\r\n"))) return;
    // 累积 body，尝试解析 Connect envelopes
    const headerEnd = respBuf.indexOf(Buffer.from("\r\n\r\n"));
    const head = respBuf.slice(0, headerEnd).toString();
    const body = respBuf.slice(headerEnd + 4);
    // chunked 编码处理
    parseChunks(body, head);
  });

  let textAcc = "";
  let done = false;
  function parseChunks(body, head) {
    if (!head.includes("200")) {
      console.error("[test] HTTP error:", head.split("\r\n")[0]);
      process.exit(1);
    }
    // 逐 chunk 解析（chunked）
    let pos = 0;
    while (pos < body.length) {
      const lineEnd = body.indexOf(Buffer.from("\r\n"), pos);
      if (lineEnd === -1) return;
      const sizeStr = body.slice(pos, lineEnd).toString().trim();
      const size = parseInt(sizeStr, 16);
      if (isNaN(size)) return; // 不完整
      if (size === 0) {
        // 结束
        if (!done) {
          done = true;
          console.log("\n[test] === 流结束 ===");
          console.log("[test] 累计文本:", JSON.stringify(textAcc));
          process.exit(0);
        }
        return;
      }
      if (pos + size > body.length - 2) return; // 不完整
      const payload = body.slice(lineEnd + 2, lineEnd + 2 + size);
      // Connect envelope: 1B flags + 4BE len
      if (payload.length >= 5) {
        const flags = payload[0];
        const len = payload.readUInt32BE(1);
        if (payload.length >= 5 + len) {
          let proto = payload.slice(5, 5 + len);
          if (flags === 1) {
            try { proto = zlib.gunzipSync(proto); } catch {}
          }
          // field 3 = delta_text
          parseDeltaText(proto);
        }
      }
      pos = lineEnd + 2 + size + 2;
    }
  }

  function parseDeltaText(proto) {
    // 简易解析 field 3 (delta_text)
    let pos = 0;
    while (pos < proto.length) {
      // 读 tag
      const t = readVarint(proto, pos);
      pos = t.next;
      const field = Number(t.value >> 3n);
      const wt = Number(t.value & 7n);
      if (field === 0) break;
      if (wt === 0) { const v = readVarint(proto, pos); pos = v.next; if (field === 5) { console.log("[test] stop_reason:", v.value); } }
      else if (wt === 2) { const l = readVarint(proto, pos); pos = l.next; const val = proto.slice(pos, pos + Number(l.value)); pos += Number(l.value); if (field === 3) { const s = val.toString("utf8"); textAcc += s; process.stdout.write(s); } }
      else if (wt === 1) { pos += 8; }
      else if (wt === 5) { pos += 4; }
      else break;
    }
  }

  function readVarint(buf, pos) {
    let v = 0n, shift = 0n;
    while (pos < buf.length) {
      const b = buf[pos++];
      v |= BigInt(b & 127) << shift;
      if ((b & 128) === 0) break;
      shift += 7n;
    }
    return { value: v, next: pos };
  }
});

sock.on("error", (e) => { console.error("[test] socket error:", e.message); process.exit(1); });
setTimeout(() => { console.error("[test] timeout"); process.exit(1); }, 60000);

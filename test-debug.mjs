// 调试版：打印每个 Connect envelope 的原始 field 明细
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { URL } from "node:url";

const PROXY = "http://127.0.0.1:3006";
const TARGET_HOST = "server.codeium.com";
const proxyUrl = new URL(PROXY);
const CRLF = String.fromCharCode(13, 10);

function varint(n) { const out = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v > 0n) b |= 128; out.push(b); } while (v > 0n); return Buffer.from(out); }
function tag(f, w) { return varint((f << 3) | w); }
function strField(f, s) { const b = Buffer.from(s, "utf8"); return Buffer.concat([tag(f, 2), varint(b.length), b]); }
function msgField(f, b) { return Buffer.concat([tag(f, 2), varint(b.length), b]); }
function vintField(f, n) { return Buffer.concat([tag(f, 0), varint(n)]); }

const userMsg = Buffer.concat([strField(1, "t1"), vintField(2, 1), strField(3, "回复两个字：收到")]);
const metadata = Buffer.concat([strField(4, "devin-session-token$mock")]);
const requestBody = Buffer.concat([
  msgField(1, metadata),
  strField(2, "You are a test."),
  msgField(3, userMsg),
  strField(21, "swe-1-6"),
  msgField(16, Buffer.from(strField(1, "00000000-0000-0000-0000-000000000040"))),
  strField(22, crypto.randomUUID()),
]);
const env = Buffer.concat([Buffer.from([0]), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(requestBody.length); return b; })(), requestBody]);

const sock = net.connect(parseInt(proxyUrl.port), proxyUrl.hostname, () => {
  sock.write("CONNECT " + TARGET_HOST + ":443 HTTP/1.1" + CRLF + "Host: " + TARGET_HOST + ":443" + CRLF + CRLF);
});

let header = Buffer.alloc(0);
sock.on("data", function onConnect(chunk) {
  header = Buffer.concat([header, chunk]);
  const idx = header.indexOf(CRLF + CRLF);
  if (idx === -1) return;
  const statusLine = header.slice(0, header.indexOf(CRLF)).toString();
  if (!statusLine.includes("200")) { console.error("CONNECT failed:", statusLine); process.exit(1); }
  sock.removeListener("data", onConnect);
  const rest = header.slice(idx + 4);

  const tlsSock = tls.connect({ socket: sock, servername: TARGET_HOST, rejectUnauthorized: false }, () => {
    const httpReq = [
      "POST /exa.api_server_pb.ApiServerService/GetChatMessage HTTP/1.1",
      "Host: " + TARGET_HOST,
      "content-type: application/connect+proto",
      "connect-protocol-version: 1",
      "authorization: Basic " + Buffer.from("devin-session-token$mock:").toString("base64"),
      "content-length: " + env.length,
    ].join(CRLF) + CRLF + CRLF;
    tlsSock.write(httpReq);
    if (rest.length) tlsSock.write(rest);
    tlsSock.write(env);
  });

  let respBuf = Buffer.alloc(0);
  let done = false;
  tlsSock.on("data", (d) => {
    respBuf = Buffer.concat([respBuf, d]);
    const headerEnd = respBuf.indexOf(CRLF + CRLF);
    if (headerEnd === -1) return;
    const head = respBuf.slice(0, headerEnd).toString();
    if (!head.includes("200")) { console.error("HTTP err:", head.split(CRLF)[0]); process.exit(1); }
    processChunked(respBuf.slice(headerEnd + 4));
  });

  function processChunked(body) {
    let pos = 0;
    while (pos < body.length) {
      const lineEnd = body.indexOf(CRLF, pos);
      if (lineEnd === -1) return;
      const size = parseInt(body.slice(pos, lineEnd).toString().trim(), 16);
      if (isNaN(size)) return;
      if (size === 0) {
        if (!done) { done = true; console.log("=== END ==="); process.exit(0); }
        return;
      }
      if (lineEnd + 2 + size > body.length) return;
      const payload = body.slice(lineEnd + 2, lineEnd + 2 + size);
      if (payload.length >= 5) {
        const flags = payload[0];
        const len = payload.readUInt32BE(1);
        if (payload.length >= 5 + len) {
          let proto = payload.slice(5, 5 + len);
          if (flags === 1) { try { proto = zlib.gunzipSync(proto); } catch {} }
          dumpFields(proto);
        }
      }
      pos = lineEnd + 2 + size + 2;
    }
  }

  function dumpFields(proto) {
    let pos = 0;
    const parts = [];
    while (pos < proto.length) {
      const t = readVarint(proto, pos); pos = t.next;
      const field = Number(t.value >> 3n), wt = Number(t.value & 7n);
      if (field === 0) break;
      if (wt === 0) { const v = readVarint(proto, pos); pos = v.next; parts.push("f" + field + "=" + v.value); }
      else if (wt === 2) { const l = readVarint(proto, pos); pos = l.next; const val = proto.slice(pos, pos + Number(l.value)); pos += Number(l.value); parts.push("f" + field + "(" + val.length + "b)=" + JSON.stringify(val.toString("utf8").slice(0, 60))); }
      else if (wt === 1) { pos += 8; parts.push("f" + field + "(fixed64)"); }
      else if (wt === 5) { pos += 4; parts.push("f" + field + "(fixed32)"); }
      else break;
    }
    console.log("[" + parts.join(" ") + "]");
  }

  function readVarint(buf, pos) {
    let v = 0n, shift = 0n;
    while (pos < buf.length) { const b = buf[pos++]; v |= BigInt(b & 127) << shift; if ((b & 128) === 0) break; shift += 7n; }
    return { value: v, next: pos };
  }
});

sock.on("error", (e) => { console.error("socket error:", e.message); process.exit(1); });
setTimeout(() => { console.error("timeout"); process.exit(1); }, 60000);

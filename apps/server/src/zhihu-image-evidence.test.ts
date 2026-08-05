import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertAllowedZhihuImageUrl, fetchZhihuImageEvidence } from "./zhihu-image-evidence.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test("只接受无凭据的标准端口 zhimg HTTPS 地址", () => {
  assert.equal(assertAllowedZhihuImageUrl("https://picx.zhimg.com/a.png#x").href, "https://picx.zhimg.com/a.png");
  for (const url of [
    "http://picx.zhimg.com/a.png",
    "https://evilzhimg.com/a.png",
    "https://picx.zhimg.com:8443/a.png",
    "https://user:pass@picx.zhimg.com/a.png",
  ]) {
    assert.throws(() => assertAllowedZhihuImageUrl(url), /受控 zhimg HTTPS/);
  }
});

test("逐跳复核重定向并返回可冻结的安全图片身份", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return calls.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://pic1.zhimg.com/final.png" } })
      : new Response(PNG, { headers: { "content-type": "image/png", "content-length": String(PNG.byteLength) } });
  };
  const result = await fetchZhihuImageEvidence(["https://picx.zhimg.com/start.png"], { fetchImpl: fetchImpl as typeof fetch });

  assert.deepEqual(calls, ["https://picx.zhimg.com/start.png", "https://pic1.zhimg.com/final.png"]);
  assert.deepEqual(result, [Object.freeze({
    base64: Buffer.from(PNG).toString("base64"),
    sha256: createHash("sha256").update(PNG).digest("hex"),
    mime: "image/png",
    sourceUrl: "https://pic1.zhimg.com/final.png",
  })]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0]), true);
  assert.deepEqual(Object.keys(result[0]!), ["base64", "sha256", "mime", "sourceUrl"]);
});

test("拒绝跳转到外部主机、超限响应和伪造图片", async () => {
  await assert.rejects(
    fetchZhihuImageEvidence(["https://picx.zhimg.com/a"], {
      fetchImpl: (async () => new Response(null, { status: 302, headers: { location: "https://example.com/a" } })) as typeof fetch,
    }),
    /受控 zhimg HTTPS/,
  );

  await assert.rejects(
    fetchZhihuImageEvidence(["https://picx.zhimg.com/a"], {
      maxImageBytes: 8,
      fetchImpl: (async () => new Response(PNG, { headers: { "content-type": "image/png" } })) as typeof fetch,
    }),
    /体积限制/,
  );

  await assert.rejects(
    fetchZhihuImageEvidence(["https://picx.zhimg.com/a"], {
      fetchImpl: (async () => new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0x00]), {
        headers: { "content-type": "image/png" },
      })) as typeof fetch,
    }),
    /内容签名与 Content-Type 不一致/,
  );
});

test("超时会中断挂起请求", async () => {
  const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  })) as typeof fetch;

  await assert.rejects(
    fetchZhihuImageEvidence(["https://picx.zhimg.com/a"], { fetchImpl, timeoutMs: 10 }),
    /知乎图片抓取超时/,
  );
});

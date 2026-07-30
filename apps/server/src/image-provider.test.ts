import assert from "node:assert/strict";
import test from "node:test";

import {
  generateOpenAiImage,
  IMAGE_GENERATION_SIZE,
  MAX_GENERATION_RESPONSE_BYTES,
  MAX_IMAGE_BYTES,
  type BoundHttpRequest,
} from "./image-provider.js";

const config = { baseUrl: "https://api.example/v1", apiKey: "secret-key", model: "image-model", providerId: "test" };
const publicLookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as never;

function response(statusCode: number, body = "", headers: Record<string, string> = {}) {
  let cancelled = false;
  return {
    value: {
      statusCode,
      headers,
      body: (async function* () { if (body) yield Buffer.from(body); })(),
      cancel: () => { cancelled = true; },
    },
    cancelled: () => cancelled,
  };
}

test("OpenAI 图片兼容请求支持 base64、固定合同和绑定 IP 的 URL 下载", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const base64 = await generateOpenAiImage({
    prompt: "  竖屏人物图  ", config, lookupImpl: publicLookup,
    fetchImpl: (async (input, init) => {
      assert.equal(String(input), "https://api.example/v1/images/generations");
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret-key");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ data: [{ b64_json: Buffer.from("image").toString("base64"), revised_prompt: "revised" }] });
    }) as typeof fetch,
  });
  assert.deepEqual(requestBody, {
    model: "image-model", prompt: "竖屏人物图", size: IMAGE_GENERATION_SIZE,
    watermark: false, response_format: "url",
  });
  assert.equal(Buffer.from(base64.bytes).toString(), "image");
  assert.equal(base64.revisedPrompt, "revised");

  const calls: Array<{ url: string; address: string }> = [];
  const requestImpl: BoundHttpRequest = async (url, address) => {
    calls.push({ url: String(url), address });
    return response(url.pathname === "/one" ? 302 : 200, url.pathname === "/two" ? "downloaded-image" : "", {
      ...(url.pathname === "/one" ? { location: "/two" } : {}),
    }).value;
  };
  const downloaded = await generateOpenAiImage({
    prompt: "scene", config, lookupImpl: publicLookup, requestImpl,
    fetchImpl: (async () => Response.json({ data: [{ url: "https://cdn.example/one" }] })) as typeof fetch,
  });
  assert.equal(Buffer.from(downloaded.bytes).toString(), "downloaded-image");
  assert.deepEqual(calls, [
    { url: "https://cdn.example/one", address: "93.184.216.34" },
    { url: "https://cdn.example/two", address: "93.184.216.34" },
  ]);
});

test("下载 socket 只使用已校验公网 IP，不给连接层二次解析私网的机会", async () => {
  let connected = false;
  await generateOpenAiImage({
    prompt: "x", config,
    lookupImpl: publicLookup,
    fetchImpl: (async () => Response.json({ data: [{ url: "https://rebinding.example/image" }] })) as typeof fetch,
    requestImpl: async (url, address) => {
      assert.equal(url.hostname, "rebinding.example");
      assert.equal(address, "93.184.216.34");
      // 若下载器把 hostname 交回连接层，这个测试替身会模拟二次解析到 10.0.0.8；当前合同只接收已绑定 IP。
      connected = true;
      return response(200, "safe-image").value;
    },
  });
  assert.equal(connected, true);
});

test("图片 URL 每跳拒绝私网并限制重定向与 30 MiB 流", async () => {
  await assert.rejects(generateOpenAiImage({
    prompt: "x", config, lookupImpl: publicLookup,
    fetchImpl: (async () => Response.json({ data: [{ url: "http://127.0.0.1/private" }] })) as typeof fetch,
  }), /本机或私有网络/);

  await assert.rejects(generateOpenAiImage({
    prompt: "x", config,
    lookupImpl: (async () => [{ address: "10.0.0.8", family: 4 }]) as never,
    fetchImpl: (async () => Response.json({ data: [{ url: "https://private.example/image" }] })) as typeof fetch,
  }), /本机或私有网络/);

  let redirect = 0;
  let redirectCancelled = 0;
  await assert.rejects(generateOpenAiImage({
    prompt: "x", config, lookupImpl: publicLookup,
    fetchImpl: (async () => Response.json({ data: [{ url: "https://cdn.example/0" }] })) as typeof fetch,
    requestImpl: async () => ({
      ...response(302, "", { location: `/${++redirect}` }).value,
      cancel: () => { redirectCancelled += 1; },
    }),
  }), /重定向次数超过 5 次/);
  assert.equal(redirectCancelled, 6);

  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  await assert.rejects(generateOpenAiImage({
    prompt: "x", config, lookupImpl: publicLookup,
    fetchImpl: (async () => Response.json({ data: [{ url: "https://cdn.example/large" }] })) as typeof fetch,
    requestImpl: async () => ({
      statusCode: 200,
      headers: {},
      body: (async function* () {
        for (let bytes = 0; bytes <= MAX_IMAGE_BYTES; bytes += chunk.byteLength) yield chunk;
      })(),
      cancel: () => { cancelled = true; },
    }),
  }), /超过 30 MiB/);
  assert.equal(cancelled, true);
});

test("生成响应在 JSON.parse 前拒绝超大 Content-Length 和超限流", async () => {
  let declaredCancelled = false;
  const declared = new Response("not-json", { headers: { "content-length": String(MAX_GENERATION_RESPONSE_BYTES + 1) } });
  const declaredCancel = declared.body!.cancel.bind(declared.body);
  declared.body!.cancel = async (...args) => { declaredCancelled = true; return declaredCancel(...args); };
  await assert.rejects(generateOpenAiImage({
    prompt: "x", config, fetchImpl: (async () => declared) as typeof fetch,
  }), /图片模型响应超过大小限制/);
  assert.equal(declaredCancelled, true);

  let streamCancelled = false;
  const oversized = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(MAX_GENERATION_RESPONSE_BYTES + 1)); },
    cancel() { streamCancelled = true; },
  }));
  await assert.rejects(generateOpenAiImage({
    prompt: "x", config, fetchImpl: (async () => oversized) as typeof fetch,
  }), /图片模型响应超过大小限制/);
  assert.equal(streamCancelled, true);
});

test("provider 错误不泄露密钥、地址或签名 URL", async () => {
  const error = await generateOpenAiImage({
    prompt: "x", config,
    fetchImpl: (async () => { throw new Error("https://signed.example/a?token=leak secret-key"); }) as typeof fetch,
  }).then(() => undefined, (caught: unknown) => caught as Error);
  assert(error);
  assert.equal(error.message, "图片模型请求失败");
  assert.doesNotMatch(error.message, /secret-key|signed|token/);
});

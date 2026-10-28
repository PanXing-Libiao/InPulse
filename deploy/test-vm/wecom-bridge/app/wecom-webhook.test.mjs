import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import test from "node:test";

import {
  WEBHOOK_MAX_IMAGE_BYTES,
  WebhookDeliveryError,
  WebhookRateLimiter,
  buildWebhookPayload,
  decryptWebhookUrl,
  sendWebhookMessage,
} from "./wecom-webhook.mjs";

const AAD = Buffer.from("app.project_wecom_groups.webhook_url", "utf8");

function encryptedUrl(url, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]);
}

function fetchJson(body, status = 200) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

test("decrypts a Webhook URL only with the Webhook AAD and key version", () => {
  const key = randomBytes(32);
  const ciphertext = encryptedUrl(
    "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefghijklmnop",
    key,
  );
  assert.match(
    decryptWebhookUrl(ciphertext, 7, new Map([[7, key]])),
    /key=abcdefghijklmnop$/,
  );
  assert.throws(
    () => decryptWebhookUrl(ciphertext, 8, new Map()),
    /加密主密钥版本不可用/,
  );
});

test("strips BOT-only routing fields from a Webhook payload", () => {
  const payload = buildWebhookPayload({
    msgtype: "markdown",
    markdown: { content: "**项目动态**" },
    chatid: "secret-chat",
    chat_type: 2,
  });
  assert.deepEqual(payload, {
    msgtype: "markdown",
    markdown: { content: "**项目动态**" },
  });
});

test("accepts template cards and image payloads up to 2 MB", () => {
  assert.equal(
    buildWebhookPayload({
      msgtype: "template_card",
      template_card: { card_type: "text_notice" },
    }).msgtype,
    "template_card",
  );
  const small = buildWebhookPayload({
    msgtype: "image",
    image: {
      base64: Buffer.from("jpeg").toString("base64"),
      md5: "a".repeat(32),
    },
  });
  assert.equal(small.msgtype, "image");
  assert.equal(small.chatid, undefined);
});

test("rejects images above the 2 MB Webhook limit", () => {
  assert.throws(
    () =>
      buildWebhookPayload({
        msgtype: "image",
        image: {
          base64: Buffer.alloc(WEBHOOK_MAX_IMAGE_BYTES + 1).toString("base64"),
          md5: "b".repeat(32),
        },
      }),
    /超过企业微信 2 MB 限制/,
  );
});

test("posts JSON to the requested URL and accepts errcode 0", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  await sendWebhookMessage(
    "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test",
    { msgtype: "markdown", markdown: { content: "hello" } },
    { fetchImpl, timeoutMs: 1000 },
  );
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.redirect, "error");
  assert.deepEqual(JSON.parse(captured.init.body), {
    msgtype: "markdown",
    markdown: { content: "hello" },
  });
});

test("classifies rate limits as retryable and permanent errcodes as failed", async () => {
  await assert.rejects(
    () =>
      sendWebhookMessage(
        "https://example.invalid",
        {
          msgtype: "markdown",
          markdown: { content: "x" },
        },
        {
          fetchImpl: fetchJson({
            errcode: 45009,
            errmsg: "api freq out of limit",
          }),
        },
      ),
    (error) =>
      error instanceof WebhookDeliveryError &&
      error.retryable === true &&
      error.errcode === 45009,
  );
  await assert.rejects(
    () =>
      sendWebhookMessage(
        "https://example.invalid",
        {
          msgtype: "markdown",
          markdown: { content: "x" },
        },
        { fetchImpl: fetchJson({ errcode: 93000, errmsg: "invalid webhook" }) },
      ),
    (error) =>
      error instanceof WebhookDeliveryError && error.retryable === false,
  );
});

test("retries 429 / 5xx / network errors and fails other HTTP statuses", async () => {
  const message = { msgtype: "markdown", markdown: { content: "x" } };
  for (const status of [429, 503]) {
    await assert.rejects(
      () =>
        sendWebhookMessage("https://example.invalid", message, {
          fetchImpl: fetchJson({}, status),
        }),
      (error) => error.retryable === true,
    );
  }
  await assert.rejects(
    () =>
      sendWebhookMessage("https://example.invalid", message, {
        fetchImpl: async () => new Response("bad", { status: 400 }),
      }),
    (error) =>
      error.retryable === false &&
      !String(error.message).includes("example.invalid"),
  );
  await assert.rejects(
    () =>
      sendWebhookMessage("https://example.invalid", message, {
        fetchImpl: async () => {
          throw new Error("network secret URL");
        },
      }),
    (error) =>
      error.retryable === true && !String(error.message).includes("secret URL"),
  );
});

test("rate-limits each Webhook target independently", () => {
  const limiter = new WebhookRateLimiter(2, 60000);
  limiter.record("a", 1000);
  limiter.record("a", 2000);
  assert.equal(limiter.canSend("a", 3000), false);
  assert.equal(limiter.canSend("b", 3000), true);
  assert.equal(limiter.retryAfterMs("a", 3000), 58000);
  assert.equal(limiter.canSend("a", 61000), true);
});

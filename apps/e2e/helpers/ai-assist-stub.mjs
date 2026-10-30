import { createServer } from "node:http";

/**
 * ADR-067 E2E 用的 OpenAI 兼容 stub 上游（只监听本机回环，CI 不访问外网）。
 *
 * 从请求 text 里提取「负责人」与「AIE2E-」唯一标记，生成一份可被固定模板解析器
 * 接受的合法草稿：标记每次运行都不同，保证文档摘要不同、不会触发
 * 「同一文档已导入过」的 409；负责人必须是真实存在的 E2E 用户，由夹具写入。
 */
const port = Number.parseInt(process.env.E2E_AI_STUB_PORT ?? "3199", 10);
const model = process.env.E2E_AI_STUB_MODEL ?? "e2e-stub-model";

function extractOwner(text) {
  const labeled = /负责人[:：]\s*([A-Za-z0-9_-]+)/.exec(text);
  if (labeled) return labeled[1];
  const ascii = /owner\s*[:=]\s*([A-Za-z0-9_-]+)/i.exec(text);
  return ascii ? ascii[1] : "e2e_owner";
}

function extractMarker(text) {
  const marker = /AIE2E-[A-Z0-9]+/.exec(text);
  return marker ? marker[0] : "AIE2E-FALLBACK";
}

/** ADR-073 修订：草稿要写出创建者，姓名由服务端注进 system 提示词（本次导入人）。 */
function extractCreatorName(systemText) {
  const named = /本次导入人的姓名是「([^」]+)」/.exec(systemText);
  return named ? named[1] : "";
}

function buildContent(mode, text, creatorName) {
  const owner = extractOwner(text);
  const marker = extractMarker(text);
  const lines = [];
  if (mode === "WHOLE_PROJECT") {
    lines.push("# 项目：AI 导入项目 " + marker);
    lines.push("- 项目编码：AIP" + marker.slice(6, 14));
    // ADR-073 修订：先写创建者（取自提示词），再写文档里的全部任务负责人。
    lines.push(
      "- 项目成员：" +
        [creatorName, owner].filter((item) => item.length > 0).join(", "),
    );
    lines.push("");
  }
  lines.push("## 模块：AI 导入模块 " + marker);
  lines.push("- 说明：E2E stub 生成的模块。");
  lines.push("");
  lines.push("### 任务：AI 导入任务");
  lines.push("- 负责人：" + owner);
  return lines.join("\n");
}

/**
 * ADR-076 迭代总结改写的应答：把「本次要求」与「事实正文」两侧各自的唯一标记回显
 * 进正文，供 E2E 断言两份文本真的到达了上游；结构固定为标题 + 两条列表 + 段落，
 * 覆盖弹窗的三种段落渲染。事实那一行刻意按真实模型的习惯带 `**` 行内强调，
 * 用来钉住「弹窗按纯文本清洗标记」，而不是把星号原样亮给用户。
 */
function buildSummaryContent(text) {
  const requirement = messageSection(text, "【本次要求】");
  const facts = messageSection(text, "【当前总结正文（唯一事实来源）】");
  const requirementMarker = (requirement.match(/AIE2EREQ[A-Z0-9]*/) ?? [""])[0];
  const factsMarker = (facts.match(/AIE2EFACT[A-Z0-9]*/) ?? [""])[0];
  return [
    "## 给领导看的改写稿 " + requirementMarker,
    "",
    "- 事实命中：**" + factsMarker + "**",
    "- 要求原文：" + requirement.trim(),
    "",
    "按「" + requirement.trim() + "」改写，事实与分节结构保持不变。",
  ].join("\n");
}

/** 取两段式 user message 里某一节的内容（到下一个【标记】为止）。 */
function messageSection(text, heading) {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length);
  const next = rest.indexOf("\n\n【");
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  let raw = "";
  request.on("data", (chunk) => {
    raw += chunk;
  });
  request.on("end", () => {
    // API 按 OpenAI chat/completions 形状发送 messages：system 是规则（含模式），
    // user 才是抽取出来的用户原文；模式从 system 的模式约束里判定。
    let mode = "IN_PROJECT";
    let text = "";
    let creatorName = "";
    let systemText = "";
    try {
      const body = JSON.parse(raw);
      const messages =
        body && Array.isArray(body.messages) ? body.messages : [];
      const userMessage = messages.find(
        (message) => message && message.role === "user",
      );
      if (userMessage && typeof userMessage.content === "string") {
        text = userMessage.content;
      }
      const systemMessage = messages.find(
        (message) => message && message.role === "system",
      );
      if (systemMessage && typeof systemMessage.content === "string") {
        systemText = systemMessage.content;
        creatorName = extractCreatorName(systemMessage.content);
        if (systemMessage.content.includes("当前模式：整项目导入")) {
          mode = "WHOLE_PROJECT";
        }
      }
    } catch {
      // 故意保持宽松：stub 只需要 user message 里的标记行。
    }
    // 推理模型的真实形状：正文为空、内容全在 reasoning_content，finish_reason=length。
    // 用户文本里带这个标记时照此应答，供 E2E 断言界面提示的是长度上限。
    if (text.includes("AIE2E-OUTPUT-LIMIT")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-e2e-output-limit",
          object: "chat.completion",
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                reasoning_content: "推理占满了输出预算",
              },
              finish_reason: "length",
            },
          ],
          usage: {
            prompt_tokens: 32,
            completion_tokens: 8192,
            total_tokens: 8224,
            completion_tokens_details: { reasoning_tokens: 8192 },
          },
        }),
      );
      return;
    }

    // ADR-076：同一上游换一份提示词（迭代总结改写）。stub 按两段式 user message
    // 里的标记回一份可逐段编辑的正文；带限流标记时回 429，供界面断言上游限流提示。
    if (systemText.includes("InPulse 迭代总结的改写助手")) {
      if (/AIE2ERATELIMIT/.test(text)) {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-e2e-summary",
          object: "chat.completion",
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: buildSummaryContent(text),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
      return;
    }

    const payload = {
      id: "chatcmpl-e2e-stub",
      object: "chat.completion",
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: buildContent(mode, text, creatorName),
          },
          finish_reason: "stop",
        },
      ],
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log("ai-assist stub listening on http://127.0.0.1:" + String(port));
});

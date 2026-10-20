// ADR-091：把 app.project_wraps 的冻结快照渲染为项目封箱纪念海报。
// 海报只使用快照里的数字、项目名与时间线；渲染失败不应改写业务状态。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";

const here = dirname(fileURLToPath(import.meta.url));
const logoPath = join(here, "assets", "libiao-robotics-logo.png");
const FONT_ALIAS = "InPulse Poster CJK";
const FONT_DIR = join(here, "assets", "fonts");
const CJK_FONT_CANDIDATES = [
  join(FONT_DIR, "NotoSansSC-Regular.ttf"),
  join(FONT_DIR, "NotoSansSC-Black.ttf"),
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
  "/usr/share/fonts/opentype/source-han-sans/SourceHanSansSC-Regular.otf",
];
let fontsReady = false;
let fontFamily = FONT_ALIAS + ", sans-serif";

function ensureFonts() {
  if (fontsReady) return;
  let registered = 0;
  for (const candidate of CJK_FONT_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    try {
      if (GlobalFonts.registerFromPath(candidate, FONT_ALIAS)) registered += 1;
    } catch {
      // 单个字体不可用时继续尝试其它平台候选。
    }
  }
  if (registered === 0) {
    throw new Error(
      "未找到可用的 Noto / Source Han CJK 字体，拒绝使用专有字体渲染海报",
    );
  }
  fontsReady = true;
}

function escapeXml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function asNonNegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error("项目封箱快照字段非法: " + field);
  }
  return Math.floor(number);
}

function asDateText(value, field) {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error("项目封箱快照时间非法: " + field);
  }
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return parts.replace(/-/g, ".");
}

function normalizeParticipant(value, index) {
  if (value === null || typeof value !== "object") {
    throw new Error("项目封箱快照参与者非法: " + String(index));
  }
  const userId = Number(value.userId);
  const name = String(
    value.name === null || value.name === undefined ? "" : value.name,
  ).trim();
  if (!Number.isSafeInteger(userId) || userId <= 0 || name.length === 0) {
    throw new Error("项目封箱快照参与者字段非法: " + String(index));
  }
  return {
    userId,
    name,
    role: value.role === "LEADER" ? "LEADER" : "MEMBER",
    completedTaskCount: asNonNegativeInteger(
      value.completedTaskCount,
      "participants.completedTaskCount",
    ),
  };
}

/** 校验桥接收到的 JSONB；未知模板版本直接拒绝，不能把新字段猜成旧版。 */
export function normalizeWrapSnapshot(raw) {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("项目封箱快照不是对象");
  }
  if (Number(value.version) !== 1) {
    throw new Error("不支持的项目封箱模板版本: " + String(value.version));
  }
  const project = value.project;
  const stats = value.stats;
  const timeline = value.timeline;
  if (!project || !stats || !timeline || !Array.isArray(value.participants)) {
    throw new Error("项目封箱快照缺少必要字段");
  }
  const id = Number(project.id);
  const code = String(
    project.code === null || project.code === undefined ? "" : project.code,
  ).trim();
  const name = String(
    project.name === null || project.name === undefined ? "" : project.name,
  ).trim();
  if (!Number.isSafeInteger(id) || id <= 0 || name.length === 0) {
    throw new Error("项目封箱快照项目字段非法");
  }
  return {
    version: 1,
    project: { id, code, name },
    stats: {
      completedTaskCount: asNonNegativeInteger(
        stats.completedTaskCount,
        "stats.completedTaskCount",
      ),
      publishedRecordCount: asNonNegativeInteger(
        stats.publishedRecordCount,
        "stats.publishedRecordCount",
      ),
      activeMemberCount: asNonNegativeInteger(
        stats.activeMemberCount,
        "stats.activeMemberCount",
      ),
      activeModuleCount: asNonNegativeInteger(
        stats.activeModuleCount,
        "stats.activeModuleCount",
      ),
      activeFeatureCount: asNonNegativeInteger(
        stats.activeFeatureCount,
        "stats.activeFeatureCount",
      ),
      openTaskCount: asNonNegativeInteger(
        stats.openTaskCount,
        "stats.openTaskCount",
      ),
      durationDays: Math.max(
        1,
        asNonNegativeInteger(stats.durationDays, "stats.durationDays"),
      ),
      completionPercent: asNonNegativeInteger(
        stats.completionPercent,
        "stats.completionPercent",
      ),
    },
    participants: value.participants.map(normalizeParticipant),
    timeline: {
      foundedAt: asDateText(timeline.foundedAt, "timeline.foundedAt"),
      firstRecordAt: asDateText(
        timeline.firstRecordAt,
        "timeline.firstRecordAt",
      ),
      lastTaskCompletedAt: asDateText(
        timeline.lastTaskCompletedAt,
        "timeline.lastTaskCompletedAt",
      ),
      sealedAt: asDateText(timeline.sealedAt, "timeline.sealedAt"),
    },
  };
}

function textUnits(value) {
  let units = 0;
  for (const char of Array.from(String(value))) {
    units += /[\u0000-\u00ff]/.test(char) ? 0.56 : 1;
  }
  return units;
}

function fitText(value, maxUnits) {
  const text = String(
    value === null || value === undefined ? "" : value,
  ).trim();
  if (textUnits(text) <= maxUnits) return text;
  const chars = Array.from(text);
  let kept = "";
  for (const char of chars) {
    if (textUnits(kept + char + "…") > maxUnits) break;
    kept += char;
  }
  return (kept || chars.slice(0, 1).join("")) + "…";
}

function countFontSize(value) {
  const length = String(value).length;
  if (length >= 5) return 145;
  if (length === 4) return 178;
  if (length === 3) return 205;
  return 232;
}

function logoMarkup() {
  if (!existsSync(logoPath)) {
    return '<text x="78" y="125" font-size="58" font-weight="900" fill="#111111">Libiao Robotics</text>';
  }
  const base64 = readFileSync(logoPath).toString("base64");
  return (
    '<image x="78" y="48" width="232" height="94" href="data:image/png;base64,' +
    base64 +
    '"/>'
  );
}

function statMarkup(x, value, unit, label) {
  return [
    "<g>",
    '<text x="' +
      String(x) +
      '" y="936" font-size="35" font-weight="800" fill="#111111">' +
      escapeXml(value),
    '<tspan font-size="14" dx="3">' + escapeXml(unit) + "</tspan></text>",
    '<text x="' +
      String(x) +
      '" y="961" font-size="13" letter-spacing="1.1" fill="#646057">' +
      escapeXml(label) +
      "</text>",
    "</g>",
  ].join("");
}

function timelineMarkup(x, label, value) {
  return [
    "<g>",
    '<circle cx="' +
      String(x) +
      '" cy="1129" r="8" fill="#ffc400" stroke="#111111" stroke-width="3"/>',
    '<text x="' +
      String(x) +
      '" y="1163" font-size="16" font-weight="700" fill="#111111">' +
      escapeXml(label) +
      "</text>",
    '<text x="' +
      String(x) +
      '" y="1186" font-size="13" letter-spacing="0.6" fill="#646057">' +
      escapeXml(value) +
      "</text>",
    "</g>",
  ].join("");
}

function buildSvg(snapshot, recipientName) {
  const stats = snapshot.stats;
  const done = String(stats.completedTaskCount);
  const projectName = fitText(snapshot.project.name, 24);
  const projectCode = fitText(snapshot.project.code, 28);
  const recipient = fitText(recipientName || "", 18);
  const footerLine = recipientName
    ? "这一箱，有你的名字。"
    : "下一次开工，Pulse 会记得。";
  const metaThird =
    recipient.length > 0 ? "FOR " + recipient : "INPULSE / PROJECT";
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350" font-family="' +
      escapeXml(fontFamily) +
      '">',
    "<defs>",
    '<linearGradient id="paper" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f8f3e7"/><stop offset="1" stop-color="#eee5d2"/></linearGradient>',
    '<pattern id="grid" width="72" height="72" patternUnits="userSpaceOnUse"><path d="M 72 0 L 0 0 0 72" fill="none" stroke="#111111" stroke-opacity="0.055" stroke-width="1"/></pattern>',
    '<clipPath id="heroClip"><rect x="78" y="520" width="642" height="342"/></clipPath>',
    "</defs>",
    '<rect width="1080" height="1350" fill="url(#paper)"/>',
    '<rect width="1080" height="1350" fill="url(#grid)"/>',
    '<rect width="18" height="1350" fill="#ffc400"/>',
    logoMarkup(),
    '<g text-anchor="end" font-family="' +
      escapeXml(fontFamily) +
      '" fill="#5d5a51">',
    '<text x="1002" y="68" font-size="15" font-weight="700" letter-spacing="2.2" fill="#111111">交付纪念</text>',
    '<text x="1002" y="91" font-size="13" letter-spacing="1.8">' +
      escapeXml(snapshot.timeline.sealedAt) +
      "</text>",
    '<text x="1002" y="113" font-size="12" letter-spacing="1.6">' +
      escapeXml(metaThird) +
      "</text>",
    "</g>",
    '<circle cx="88" cy="196" r="8" fill="#ffc400"/>',
    '<text x="106" y="202" font-family="' +
      escapeXml(fontFamily) +
      '" font-size="16" font-weight="700" letter-spacing="3" fill="#111111">PROJECT COMPLETE / 项目封箱</text>',
    '<g font-family="' + escapeXml(fontFamily) + '" fill="#111111">',
    '<text x="75" y="312" font-size="108" font-weight="900" letter-spacing="-7">事情做完了，</text>',
    '<rect x="68" y="348" width="600" height="52" fill="#ffc400" transform="rotate(-1.2 68 348)"/>',
    '<text x="75" y="432" font-size="108" font-weight="900" letter-spacing="-7">故事还在。</text>',
    "</g>",
    '<line x1="78" y1="482" x2="152" y2="482" stroke="#111111" stroke-width="1.5"/>',
    '<text x="174" y="487" font-family="' +
      escapeXml(fontFamily) +
      '" font-size="22" letter-spacing="1.5" fill="#57534a">主体交付完成 · 正式进入维护</text>',
    '<rect x="78" y="520" width="642" height="342" fill="#111111"/>',
    '<g clip-path="url(#heroClip)"><circle cx="690" cy="518" r="214" fill="none" stroke="#ffc400" stroke-width="72"/></g>',
    '<text x="111" y="578" font-family="' +
      escapeXml(fontFamily) +
      '" font-size="15" font-weight="700" letter-spacing="2.6" fill="#ffc400">TASKS DELIVERED</text>',
    '<text x="107" y="778" font-family="' +
      escapeXml(fontFamily) +
      '" font-size="' +
      String(countFontSize(done)) +
      '" font-weight="900" letter-spacing="-8" fill="#f8f4e9">' +
      escapeXml(done) +
      '<tspan font-size="31" letter-spacing="0" dx="8">个</tspan></text>',
    '<text x="111" y="825" font-family="' +
      escapeXml(fontFamily) +
      '" font-size="24" font-weight="700" fill="#f8f4e9">任务，全部落地</text>',
    '<text x="692" y="837" text-anchor="end" font-family="' +
      escapeXml(fontFamily) +
      '" font-size="11" letter-spacing="1.8" fill="#7f7b70">ONE BY ONE / UNTIL DONE</text>',
    '<rect x="740" y="520" width="262" height="164" fill="#ffc400"/>',
    '<text x="764" y="610" font-size="64" font-weight="800" fill="#111111"><tspan font-family="' +
      escapeXml(fontFamily) +
      '">' +
      escapeXml(String(stats.publishedRecordCount)) +
      '</tspan><tspan font-family="' +
      escapeXml(fontFamily) +
      '" font-size="17" font-weight="700" dx="5">篇</tspan></text>',
    '<text x="764" y="660" font-size="14" letter-spacing="1.2" fill="#34312b">迭代记录，留下来路</text>',
    '<rect x="740" y="698" width="262" height="164" fill="#ddd3bf"/>',
    '<text x="764" y="788" font-size="64" font-weight="800" fill="#111111"><tspan font-family="' +
      escapeXml(fontFamily) +
      '">' +
      escapeXml(String(stats.openTaskCount)) +
      '</tspan><tspan font-family="' +
      escapeXml(fontFamily) +
      '" font-size="17" font-weight="700" dx="5">项</tspan></text>',
    '<text x="764" y="838" font-size="14" letter-spacing="1.2" fill="#34312b">未收尾，干净封箱</text>',
    '<line x1="78" y1="890" x2="1002" y2="890" stroke="#111111" stroke-width="2.5"/>',
    statMarkup(78, String(stats.activeMemberCount), "人", "参与伙伴"),
    statMarkup(312, String(stats.durationDays), "天", "从立项到封箱"),
    statMarkup(546, String(stats.activeFeatureCount), "个", "功能上线"),
    statMarkup(780, String(stats.completionPercent), "%", "任务收尾"),
    '<line x1="78" y1="985" x2="1002" y2="985" stroke="#111111" stroke-opacity="0.25"/>',
    '<text x="78" y="1026" font-family="' +
      escapeXml(fontFamily) +
      '" font-size="13" letter-spacing="2.5" fill="#5d5a51">PROJECT / INPULSE</text>',
    '<text x="76" y="1074" font-family="' +
      escapeXml(fontFamily) +
      '" font-size="38" font-weight="900" letter-spacing="-1.5" fill="#111111">' +
      escapeXml(projectName) +
      "</text>",
    '<text x="78" y="1102" font-family="' +
      escapeXml(fontFamily) +
      '" font-size="13" letter-spacing="1.8" fill="#5d5a51">' +
      escapeXml(projectCode) +
      " / PROJECT WRAP</text>",
    '<line x1="78" y1="1129" x2="770" y2="1129" stroke="#111111" stroke-width="1.3"/>',
    timelineMarkup(78, "立项", snapshot.timeline.foundedAt),
    timelineMarkup(270, "首个记录", snapshot.timeline.firstRecordAt),
    timelineMarkup(462, "最后任务", snapshot.timeline.lastTaskCompletedAt),
    timelineMarkup(654, "封箱", snapshot.timeline.sealedAt),
    '<circle cx="900" cy="1128" r="88" fill="none" stroke="#111111" stroke-width="2.2"/>',
    '<circle cx="900" cy="1128" r="73" fill="none" stroke="#111111" stroke-width="1" stroke-dasharray="5 7"/>',
    '<text x="900" y="1138" text-anchor="middle" font-family="' +
      escapeXml(fontFamily) +
      '" font-size="38" font-weight="900" fill="#111111">封箱</text>',
    '<text x="900" y="1161" text-anchor="middle" font-family="' +
      escapeXml(fontFamily) +
      '" font-size="9" letter-spacing="1.7" fill="#5d5a51">SEALED / INPULSE</text>',
    '<rect x="0" y="1260" width="1080" height="90" fill="#111111"/>',
    '<text x="78" y="1310" font-family="' +
      escapeXml(fontFamily) +
      '" font-size="17" letter-spacing="1.2" fill="#f8f4e9">' +
      escapeXml(footerLine) +
      "</text>",
    '<text x="1002" y="1310" text-anchor="end" font-family="' +
      escapeXml(fontFamily) +
      '" font-size="12" letter-spacing="2.2" fill="#f8f4e9">LIBIAO ROBOTICS × INPULSE</text>',
    "</svg>",
  ].join("");
}

export async function renderWrapPoster(input) {
  ensureFonts();
  const snapshot = normalizeWrapSnapshot(input && input.snapshot);
  const recipientName = String(
    input && input.recipientName ? input.recipientName : "",
  ).trim();
  const svg = buildSvg(snapshot, recipientName);
  const image = await loadImage(Buffer.from(svg, "utf8"));
  const canvas = createCanvas(1080, 1350);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, 1080, 1350);
  let buffer = canvas.toBuffer("image/jpeg", 90);
  if (buffer.length > 1800000) buffer = canvas.toBuffer("image/jpeg", 80);
  return {
    buffer,
    base64: buffer.toString("base64"),
    md5: createHash("md5").update(buffer).digest("hex"),
    mimeType: "image/jpeg",
    width: 1080,
    height: 1350,
    snapshot,
  };
}

export function imageMessageFromPoster(poster) {
  return {
    msgtype: "image",
    image: {
      base64: poster.base64,
      md5: poster.md5,
    },
  };
}

export function buildGroupWrapText(snapshot) {
  const value = normalizeWrapSnapshot(snapshot);
  return [
    "**叮——最后一盏灯灭了。**",
    "【" +
      fitText(value.project.name, 26) +
      "】项目封箱：事情做完了，故事还在。",
  ].join(String.fromCharCode(10));
}

export function buildPersonalWrapText(snapshot) {
  const value = normalizeWrapSnapshot(snapshot);
  const stats = value.stats;
  return [
    "**这一箱，有你的名字。**",
    "「" +
      fitText(value.project.name, 26) +
      "」已完成封箱：" +
      String(stats.completedTaskCount) +
      " 个任务、" +
      String(stats.publishedRecordCount) +
      " 篇记录、" +
      String(stats.activeMemberCount) +
      " 个人、" +
      String(stats.durationDays) +
      " 天。",
    "谢谢你把它送到这里。",
  ].join(String.fromCharCode(10));
}

export function posterBufferInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("项目封箱海报 buffer 为空");
  }
  return {
    md5: createHash("md5").update(buffer).digest("hex"),
    base64: buffer.toString("base64"),
  };
}

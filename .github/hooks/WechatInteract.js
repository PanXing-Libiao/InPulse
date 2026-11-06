// preToolUse / postToolUse hook：把「VS Code 正在等你选择」和「提问已收场」落盘给企微桥接读取。
//
// 为什么用 hook 而不是读 transcript：vscode_askQuestions 在用户回答前不返回、不写 turn_end，
// 它的 tool.execution_start 也只先进内存缓冲，要等 flush() 才落盘（实测等待 90 秒文件零增长，
// 答完才把 start/complete 一起写下来）。hook 在核心生成 confirmationMessages 之前触发，
// 是唯一早于阻塞的可靠信号。
//
// 为什么还要 PostToolUse：轮播一关就再也作不了答，可扩展侧完全感知不到这一点。没有这条
// 完成事件，用户先在电脑上答了、再从手机回数字，会收到一句「已提交」而实际上什么也没发生。
//
// 三条铁律：
//   1. 任何情况下都必须 exit 0。exit 2 会被当成 deny，直接把工具调用拒掉；
//      其他非零会被当成 warning 弹给用户。
//   2. stdout 必须保持为空，否则会被当成 hook 输出解析。
//   3. 只对 vscode_askQuestions 写事件；其余工具静默通过，免得平白增加 I/O。
//
// 目录约定与 src/wechatBridgeInteractions.ts 里的 INTERACTIONS_DIR_NAME 必须一致。

const fs = require('fs');
const path = require('path');

/** 必须与 src/wechatBridgeInteractions.ts 的 INTERACTIONS_DIR_NAME 相同 */
const INTERACTIONS_DIR_NAME = 'wechatPending';

/** 必须与 src/wechatBridgeInteractions.ts 的 INTERACTION_DONE_KIND 相同 */
const INTERACTION_DONE_KIND = 'done';

/** 只认这一个工具：它是唯一确定会阻塞等用户回答的 */
const ASK_QUESTIONS_TOOL_NAME = 'vscode_askQuestions';

/** 单条事件上限，防止异常大的参数把文件撑爆 */
const MAX_LINE_BYTES = 256 * 1024;

function readStdin() {
	try {
		return fs.readFileSync(0, 'utf8');
	} catch {
		return '';
	}
}

function main() {
	const raw = readStdin();
	if (!raw) {
		return;
	}
	let input;
	try {
		input = JSON.parse(raw);
	} catch {
		return;
	}
	if (!input) {
		return;
	}
	const isPre = input.hook_event_name === 'PreToolUse';
	const isPost = input.hook_event_name === 'PostToolUse';
	if (!isPre && !isPost) {
		return;
	}
	if (input.tool_name !== ASK_QUESTIONS_TOOL_NAME) {
		return;
	}
	// transcript_path 形如 <storage>/<扩展 id>/transcripts/<sessionId>.jsonl，
	// 往上一层就是扩展数据目录，sidecar 放它下面，扩展侧按同一规则反推，不用写死扩展 id。
	const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : '';
	if (!transcriptPath) {
		return;
	}
	const dataDir = path.dirname(path.dirname(transcriptPath));
	const targetDir = path.join(dataDir, INTERACTIONS_DIR_NAME);
	const sessionId = typeof input.session_id === 'string' && input.session_id
		? input.session_id
		: path.basename(transcriptPath, '.jsonl');

	let line;
	if (isPost) {
		// 完成事件不带 toolCallId：提问工具是串行的，同一会话此刻只可能有一个待答提问
		line = `${JSON.stringify({
			kind: INTERACTION_DONE_KIND,
			toolName: input.tool_name,
			at: new Date().toISOString(),
		})}\n`;
	} else {
		const toolCallId = typeof input.tool_use_id === 'string' ? input.tool_use_id : '';
		if (!toolCallId) {
			return;
		}
		line = `${JSON.stringify({
			toolCallId,
			toolName: input.tool_name,
			arguments: input.tool_input,
			at: new Date().toISOString(),
		})}\n`;
	}
	const targetFile = path.join(targetDir, `${sessionId}.jsonl`);
	if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
		return;
	}

	try {
		fs.mkdirSync(targetDir, { recursive: true });
		fs.appendFileSync(targetFile, line, 'utf8');
	} catch {
		// 桥接读不到就当没发生，绝不能让 hook 影响工具调用
	}
}

try {
	main();
} catch {
	// 同上：吞掉所有异常
}

process.exit(0);

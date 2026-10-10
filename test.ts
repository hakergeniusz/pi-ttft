/**
 * Smoke test: runs index.ts against a fake ExtensionAPI, fake ExtensionContext and a
 * stubbed clock. No network, no real model, no real pi. `bun test.ts`.
 *
 * Covers: TTFT/throughput measurement from the event sequence, avg vs last, the
 * `avg|last|reset|on|off` command surface, and the footer render (segments, and
 * their placement next to the built-in token stats).
 */

import { stripTerminalSequences } from "@earendil-works/pi-tui";

const { default: activate } = await import("./index.ts");

// --- stubbed clock ----------------------------------------------------------

let clock = 0;
const realNow = performance.now.bind(performance);
performance.now = () => clock;
/** Advance the stubbed clock. */
const advance = (ms: number): void => {
	clock += ms;
};

// --- fake pi ----------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => unknown;

const handlers = new Map<string, Handler>();
const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void>; description?: string }>();
const notifications: { message: string; type?: string }[] = [];

const fakePi = {
	on(event: string, handler: Handler) {
		handlers.set(event, handler);
		return () => {};
	},
	registerCommand(name: string, options: (typeof commands extends Map<string, infer V> ? V : never)) {
		commands.set(name, options);
	},
	getSettings: () => ({ compaction: { enabled: true } }),
};

// --- fake ctx / ui ----------------------------------------------------------

let footerFactory: ((tui: unknown, theme: unknown, footerData: unknown) => { render(width: number): string[] }) | null =
	null;
let footerDisabled = false;

const usage = (output: number, cacheRead = 0) => ({
	input: 100,
	output,
	cacheRead,
	cacheWrite: 0,
	totalTokens: 100 + output + cacheRead,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const entries: unknown[] = [];

const fakeCtx = {
	mode: "tui",
	hasUI: true,
	model: { id: "test-model", provider: "opencode", contextWindow: 100000, reasoning: true },
	thinkingLevel: "high",
	sessionManager: {
		getCwd: () => "/home/hakergeniusz",
		getEntries: () => entries,
		getSessionId: () => "session-1",
		getLeafId: () => "leaf-1",
		getSessionName: () => undefined,
	},
	modelRegistry: {
		isUsingOAuth: () => false,
		getProvider: () => undefined,
	},
	getContextUsage: () => ({ tokens: 1000, contextWindow: 100000, percent: 1 }),
	ui: {
		notify: (message: string, type?: string) => notifications.push({ message, type }),
		setFooter: (factory: unknown) => {
			footerDisabled = factory === undefined;
			footerFactory = factory === undefined ? null : (factory as typeof footerFactory);
		},
	},
};

const themeCalls: { color: string; text: string }[] = [];
const fakeTheme = {
	fg: (color: string, text: string) => {
		themeCalls.push({ color, text });
		return text;
	},
	bold: (text: string) => text,
};

const fakeFooterData = {
	getGitBranch: () => "main",
	getExtensionStatuses: () => new Map<string, string>([["caveman", "caveman lite"]]),
	getAvailableProviderCount: () => 2,
	onBranchChange: () => () => {},
};

// --- helpers ----------------------------------------------------------------

const fire = (event: string, payload: unknown): void => {
	const handler = handlers.get(event);
	if (!handler) throw new Error(`no handler registered for ${event}`);
	handler(payload, fakeCtx);
};

/** One full assistant response: request start, first token at +ttft, end at +generate. */
const respond = (options: { ttft: number; generate: number; output: number }): void => {
	fire("before_provider_headers", { type: "before_provider_headers", headers: {} });
	fire("message_start", { type: "message_start", message: { role: "assistant" } });
	advance(options.ttft);
	fire("message_update", {
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "hello" },
	});
	advance(options.generate);
	fire("message_end", { type: "message_end", message: { role: "assistant", usage: usage(options.output) } });
};

const renderFooter = (width = 120): string[] => {
	if (!footerFactory) throw new Error("footer was never installed");
	const component = footerFactory({}, fakeTheme, fakeFooterData);
	return component.render(width).map(stripTerminalSequences);
};

/** Did the theme paint a segment with this color? */
const painted = (color: string, prefix: string): boolean =>
	themeCalls.some((call) => call.color === color && call.text.startsWith(prefix));

const runCommand = async (args: string): Promise<void> => {
	const command = commands.get("ttft");
	if (!command) throw new Error("no /ttft command");
	await command.handler(args, fakeCtx);
};

let failures = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
	if (condition) {
		console.log(`ok   ${name}`);
	} else {
		failures += 1;
		console.log(`FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
	}
};

// --- run --------------------------------------------------------------------

activate(fakePi as never);

fire("session_start", { type: "session_start" }, fakeCtx);
check("footer installed on session_start", footerFactory !== null && !footerDisabled);
check("no speed segments before any response", !renderFooter()[1].includes("t/s"));

// Response 1: 1200 ms TTFT, 2000 ms generation of 100 tokens -> 50 t/s.
respond({ ttft: 1200, generate: 2000, output: 100 });
// Response 2: 400 ms TTFT, 1000 ms generation of 25 tokens -> 25 t/s.
respond({ ttft: 400, generate: 1000, output: 25 });

// Mirror the two responses as session entries so the built-in token stats have data too.
entries.push(
	{ type: "message", message: { role: "assistant", usage: usage(100, 900) } },
	{ type: "message", message: { role: "assistant", usage: usage(25, 900) } },
);

const statsLine = renderFooter()[1];
check("TTFT segment shows the average of 1200 and 400 ms", statsLine.includes("T800ms"), statsLine);
check("throughput segment shows the average of 50 and 25 t/s", statsLine.includes("38t/s"), statsLine);
check(
	"speed segments sit next to the token stats",
	new RegExp("^↑\\S+ ↓\\S+ R\\S+ CH[\\d.]+% T800ms 38t/s \\S").test(statsLine),
	statsLine,
);
check("git branch still on the first line", renderFooter()[0].includes("(main)"), renderFooter()[0]);
check("extension statuses still rendered", renderFooter()[2] === "caveman lite", renderFooter()[2]);
check("model and thinking level still on the right", statsLine.endsWith("(opencode) test-model • high"), statsLine);

// last vs avg
await runCommand("last");
const lastLine = renderFooter()[1];
check("last mode shows the newest sample", lastLine.includes("T400ms") && lastLine.includes("25t/s"), lastLine);
await runCommand("avg");
check("avg mode restored", renderFooter()[1].includes("T800ms"));

// /ttft report
await runCommand("");
const report = notifications[notifications.length - 1].message;
check("report mentions the sample count", report.includes("avg of 2"), report);
check("report lists per-model averages", report.includes("test-model: 800ms · 38t/s (2)"), report);

// reset
await runCommand("reset");
check("reset clears the segments", !renderFooter()[1].includes("t/s"), renderFooter()[1]);
await runCommand("");
check("report after reset says nothing measured", notifications[notifications.length - 1].message.includes("No completed"));

// off / on
await runCommand("off");
check("off restores the built-in footer", footerDisabled && footerFactory === null);
await runCommand("on");
check("on reinstalls the footer", footerFactory !== null && !footerDisabled);

// narrow terminal: the stats line must still fit the width
const narrow = renderFooter(40)[1];
check("narrow render fits the width", narrow.length <= 40, { width: narrow.length, narrow });

// unknown usage: fall back to a character estimate (4 chars per token)
advance(50);
fire("before_provider_headers", { type: "before_provider_headers", headers: {} });
fire("message_start", { type: "message_start", message: { role: "assistant" } });
advance(300);
for (let i = 0; i < 10; i++) {
	fire("message_update", {
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "abcdefgh" },
	});
}
advance(400);
fire("message_end", { type: "message_end", message: { role: "assistant", usage: usage(0) } });
check("estimated-token response is measured", renderFooter()[1].includes("t/s"), renderFooter()[1]);

// A reply that lands in under 50 ms has no meaningful rate: TTFT only.
const rateBefore = "50t/s";
respond({ ttft: 5000, generate: 5, output: 3 });
const shortLine = renderFooter()[1];
check("short generation still moves the TTFT average", shortLine.includes("T2.6s"), shortLine);
check("short generation does not move the rate average", shortLine.includes(rateBefore), shortLine);

// thresholds: TTFT > 45 s red, > 15 s yellow; throughput < 10 t/s red, < 25 t/s yellow
let themeMark = 0;
const threshold = async (
	name: string,
	sample: { ttft: number; generate: number; output: number },
	expected: { ttft?: string; tps?: string },
): Promise<void> => {
		await runCommand("reset");
		respond(sample);
		themeMark = themeCalls.length;
		renderFooter();
		const calls = themeCalls.slice(themeMark);
		const ttft = calls.find((call) => /^T[\d.]+(ms|s)$/.test(call.text));
		const tps = calls.find((call) => /^\d+(\.\d+)?t\/s$/.test(call.text));
		check(
			name,
			(ttft?.color ?? undefined) === expected.ttft && (tps?.color ?? undefined) === expected.tps,
			{ ttft, tps },
		);
	};

await threshold("TTFT over 45 s is red", { ttft: 50000, generate: 1000, output: 50 }, { ttft: "error" });
await threshold("TTFT over 15 s is yellow", { ttft: 20000, generate: 1000, output: 50 }, { ttft: "warning" });
await threshold("TTFT under 15 s is plain", { ttft: 5000, generate: 1000, output: 50 }, {});
await threshold("throughput under 10 t/s is red", { ttft: 500, generate: 2000, output: 10 }, { tps: "error" });
await threshold("throughput under 25 t/s is yellow", { ttft: 500, generate: 2000, output: 30 }, { tps: "warning" });
await threshold("throughput over 25 t/s is plain", { ttft: 500, generate: 1000, output: 50 }, {});

// aborts (no first token) must not produce a sample
const before = renderFooter()[1];
fire("before_provider_headers", { type: "before_provider_headers", headers: {} });
fire("message_end", { type: "message_end", message: { role: "assistant", usage: usage(500) } });
check("request without a first token is dropped", renderFooter()[1] === before);

performance.now = realNow;

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
if (failures > 0) process.exit(1);
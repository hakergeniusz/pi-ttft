/**
 * pi-ttft — average time-to-first-token and decode throughput in the footer.
 *
 * pi's built-in footer shows cumulative tokens (`↑117k ↓88K R11M CH99.1%`) but says
 * nothing about *speed*. This extension adds two segments to that same stats line:
 *
 *   ↑117k ↓88K R11M CH99.1% T1.2s 45t/s 11.5%/1.0M (auto)
 *              TTFT ^^^^^^  ^^^^^
 *              T    time to first token, averaged over this chat
 *              t/s  output tokens per second after the first token, averaged too
 *
 * Measurement, per assistant response:
 *   t0  `before_provider_headers` — headers are assembled, the HTTP call is next.
 *       This is the honest start of the request. `message_start` only fires once
 *       response headers are back, which would hide all network and queue time.
 *   t1  first token: the first `*_delta` (or `*_start`) seen on a `message_update`.
 *       Thinking deltas count — for a reasoning model the reasoning block is the
 *       first thing the user waits for.
 *   t2  `message_end`.
 *   TTFT = t1 - t0; throughput = output tokens / (t2 - t1).
 *
 * The built-in stats line has no extension hook, so the footer itself is replaced.
 * `MetricsFooter` below mirrors the layout of pi 1.1.0's `FooterComponent.render()`.
 * Two parts of that component read AgentSession internals extensions cannot reach:
 * the virtual-model route arrow and the live auto-compaction flag. Auto-compaction
 * is read from settings instead; the route arrow is dropped. README lists the rest.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** `avg` (default) averages every completed response in this chat; `last` shows the newest. */
type DisplayMode = "avg" | "last";

/**
 * Generation windows shorter than this contribute no throughput sample: a 3-token
 * reply that lands in 7 ms reports 400+ t/s and poisons the average. Their TTFT
 * still counts, since that measurement does not depend on the window length.
 */
const MIN_GENERATE_WINDOW_MS = 50;

/**
 * Footer segments change colour past these. Override with
 * PI_TTFT_WARN_TTFT_MS / PI_TTFT_SLOW_TTFT_MS / PI_TTFT_WARN_TPS / PI_TTFT_SLOW_TPS.
 */
const TTFT_WARN_MS = Number(process.env.PI_TTFT_WARN_TTFT_MS ?? 15000);
const TTFT_SLOW_MS = Number(process.env.PI_TTFT_SLOW_TTFT_MS ?? 45000);
const TPS_WARN = Number(process.env.PI_TTFT_WARN_TPS ?? 25);
const TPS_SLOW = Number(process.env.PI_TTFT_SLOW_TPS ?? 10);

/** Paint a footer segment, or leave it plain. */
function paint(theme: Theme, text: string, color?: "error" | "warning"): string {
	return color ? theme.fg(color, text) : text;
}

// ============================================================================
// Metrics
// ============================================================================

interface Sample {
	/** Milliseconds from request start to first token. */
	ttftMs: number;
	/** Output tokens per second after the first token; undefined for too-short generations. */
	tps?: number;
	/** Output tokens for the sample (usage-reported, or estimated). */
	tokens: number;
	/** Model id the sample came from. */
	model: string;
}

/** One in-flight provider request. */
interface Pending {
	/** t0: headers assembled, HTTP call imminent. */
	t0: number;
	/** t1: first token seen. */
	firstAt?: number;
	/** Text and thinking characters, used to estimate tokens when usage is missing. */
	chars: number;
	model: string;
}

class Metrics {
	private samples: Sample[] = [];
	private pending: Pending | null = null;

	/** A retry fires before_provider_headers again; restart so backoff is not timed as generation. */
	beginRequest(model: string): void {
		this.pending = { t0: performance.now(), chars: 0, model };
	}

	/** Fallback for paths that never emit before_provider_headers. */
	beginFallback(model: string): void {
		if (this.pending) return;
		this.pending = { t0: performance.now(), chars: 0, model };
	}

	noteDelta(deltaType: string, delta: string): void {
		const pending = this.pending;
		if (!pending) return;
		pending.chars += delta.length;
		if (pending.firstAt !== undefined) return;
		const isFirstToken =
			deltaType.endsWith("_delta") ||
			deltaType === "text_start" ||
			deltaType === "thinking_start" ||
			deltaType === "toolcall_start";
		if (isFirstToken) pending.firstAt = performance.now();
	}

	endResponse(usage: Usage | undefined): void {
		const pending = this.pending;
		this.pending = null;
		if (!pending || pending.firstAt === undefined) return;

		const ttftMs = pending.firstAt - pending.t0;
		const generateMs = performance.now() - pending.firstAt;
		if (ttftMs < 0 || generateMs <= 0) return;

		const tokens = usage?.output && usage.output > 0 ? usage.output : Math.round(pending.chars / 4);
		if (tokens <= 0) return;

		const tps = generateMs >= MIN_GENERATE_WINDOW_MS ? (tokens / generateMs) * 1000 : undefined;
		this.samples.push({ ttftMs, tps, tokens, model: pending.model });
	}

	clear(): void {
		this.samples = [];
		this.pending = null;
	}

	get count(): number {
		return this.samples.length;
	}

	/** What the footer should print now, or undefined before the first completed response. */
	current(mode: DisplayMode): { ttftMs: number; tps?: number } | undefined {
		if (this.samples.length === 0) return undefined;
		if (mode === "last") {
			const sample = this.samples[this.samples.length - 1];
			return sample ? { ttftMs: sample.ttftMs, tps: sample.tps } : undefined;
		}
		let ttft = 0;
		let tps = 0;
		let tpsCount = 0;
		for (const sample of this.samples) {
			ttft += sample.ttftMs;
			if (sample.tps === undefined) continue;
			tps += sample.tps;
			tpsCount += 1;
		}
		return { ttftMs: ttft / this.samples.length, tps: tpsCount > 0 ? tps / tpsCount : undefined };
	}

	/** Per-model averages, for /ttft. */
	byModel(): { model: string; count: number; ttftMs: number; tps?: number; tokens: number }[] {
		const buckets = new Map<
			string,
			{ count: number; ttftMs: number; tps: number; tpsCount: number; tokens: number }
		>();
		for (const sample of this.samples) {
			const bucket = buckets.get(sample.model) ?? { count: 0, ttftMs: 0, tps: 0, tpsCount: 0, tokens: 0 };
			bucket.count += 1;
			bucket.ttftMs += sample.ttftMs;
			bucket.tokens += sample.tokens;
			if (sample.tps !== undefined) {
				bucket.tps += sample.tps;
				bucket.tpsCount += 1;
			}
			buckets.set(sample.model, bucket);
		}
		return Array.from(buckets, ([model, bucket]) => ({
			model,
			count: bucket.count,
			ttftMs: bucket.ttftMs / bucket.count,
			tps: bucket.tpsCount > 0 ? bucket.tps / bucket.tpsCount : undefined,
			tokens: bucket.tokens,
		})).sort((a, b) => b.count - a.count);
	}
}

// ============================================================================
// Formatting
// ============================================================================

function formatTtft(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.round(ms / 1000)}s`;
}

function formatTps(tps: number): string {
	if (tps >= 100) return `${Math.round(tps)}`;
	if (tps >= 10) return `${tps.toFixed(0)}`;
	return `${tps.toFixed(1)}`;
}

/** Same compact token formatting the built-in footer uses. */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

// ============================================================================
// Footer component
// ============================================================================

/** Accumulated token usage, matching pi's internal UsageTotals shape. */
interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface SessionStats {
	totals: UsageTotals;
	latestCacheHitRate: number | undefined;
	contextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
}

function addUsage(totals: UsageTotals, usage: Usage | undefined): void {
	if (!usage) return;
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.cost += usage.cost?.total ?? 0;
}

/**
 * Drop-in replacement for pi's FooterComponent with two extra stats segments.
 * Layout mirrors pi 1.1.0 `modes/interactive/components/footer.ts`.
 */
class MetricsFooter implements Component {
	private ctx: ExtensionContext;
	private theme: Theme;
	private footerData: ReadonlyFooterDataProvider;
	private metrics: Metrics;
	private getSettings: () => { compaction?: { enabled?: boolean } };
	private getDisplayMode: () => DisplayMode;
	private cache: { key: string; stats: SessionStats } | null = null;
	private compactionCache: { at: number; enabled: boolean } | null = null;
	private unsubscribe: () => void;

	constructor(options: {
		ctx: ExtensionContext;
		theme: Theme;
		footerData: ReadonlyFooterDataProvider;
		metrics: Metrics;
		getSettings: () => { compaction?: { enabled?: boolean } };
		getDisplayMode: () => DisplayMode;
	}) {
		this.ctx = options.ctx;
		this.theme = options.theme;
		this.footerData = options.footerData;
		this.metrics = options.metrics;
		this.getSettings = options.getSettings;
		this.getDisplayMode = options.getDisplayMode;
		this.unsubscribe = this.footerData.onBranchChange(() => {});
	}

	dispose(): void {
		this.unsubscribe();
	}

	invalidate(): void {
		this.cache = null;
	}

	

	/** Auto-compaction lives on AgentSession; extensions only see the settings copy. */
	private autoCompactEnabled(): boolean {
		const now = Date.now();
		if (this.compactionCache && now - this.compactionCache.at < 1000) return this.compactionCache.enabled;
		let enabled = true;
		try {
			enabled = this.getSettings()?.compaction?.enabled ?? true;
		} catch {
			enabled = true;
		}
		this.compactionCache = { at: now, enabled };
		return enabled;
	}

	/** Kimi Coding is subscription-backed despite using API-key authentication. */
	private usingSubscription(): boolean {
		const model = this.ctx.model;
		if (!model) return false;
		if (model.provider === "kimi-coding") return true;
		try {
			const registry = this.ctx.modelRegistry;
			if (!registry?.isUsingOAuth?.(model)) return false;
			return registry.getProvider(model.provider)?.auth?.oauth?.isSubscription === true;
		} catch {
			return false;
		}
	}

	/** Usage totals and context usage change only with the entry count, leaf, or model. */
	private getSessionStats(): SessionStats {
		const sessionManager = this.ctx.sessionManager;
		const entries = sessionManager.getEntries();
		const model = this.ctx.model;
		const key = `${entries.length}:${sessionManager.getLeafId()}:${sessionManager.getSessionId()}:${model?.id ?? ""}`;
		if (this.cache && this.cache.key === key) return this.cache.stats;

		const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		let latestCacheHitRate: number | undefined;
		for (const entry of entries) {
			if (entry.type === "usage") {
				addUsage(totals, entry.usage);
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				const usage = entry.message.usage;
				addUsage(totals, usage);
				const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
				latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult") {
				addUsage(totals, entry.message.usage);
			} else if (entry.type === "branch_summary" || entry.type === "compaction") {
				addUsage(totals, entry.usage);
			}
		}

		const stats: SessionStats = { totals, latestCacheHitRate, contextUsage: this.ctx.getContextUsage() };
		this.cache = { key, stats };
		return stats;
	}

	/** The two segments this extension exists for; empty before the first response. */
	private speedParts(): string[] {
		const current = this.metrics.current(this.getDisplayMode());
		if (!current) return [];
		const ttft = `T${formatTtft(current.ttftMs)}`;
		const ttftColor: "error" | "warning" | undefined =
			current.ttftMs > TTFT_SLOW_MS ? "error" : current.ttftMs > TTFT_WARN_MS ? "warning" : undefined;
		const parts = [paint(this.theme, ttft, ttftColor)];
		if (current.tps !== undefined) {
			const tps = `${formatTps(current.tps)}t/s`;
			const tpsColor: "error" | "warning" | undefined =
				current.tps < TPS_SLOW ? "error" : current.tps < TPS_WARN ? "warning" : undefined;
			parts.push(paint(this.theme, tps, tpsColor));
		}
		return parts;
	}

	render(width: number): string[] {
		try {
			return this.renderStats(width);
		} catch (error) {
			return [this.theme.fg("dim", `pi-ttft: ${(error as Error).message}`)];
		}
	}

	private renderStats(width: number): string[] {
		const theme = this.theme;
		const model = this.ctx.model;
		const { totals, latestCacheHitRate, contextUsage } = this.getSessionStats();

		const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined
			? contextPercentValue.toFixed(1)
			: "?";

		// First line: cwd with ~ substitution, git branch, session name.
		let pwd = this.ctx.sessionManager.getCwd();
		const home = process.env.HOME || process.env.USERPROFILE;
		if (home) {
			const relativeToHome = relative(resolve(home), resolve(pwd));
			if (relativeToHome === "") pwd = "~";
			else if (!relativeToHome.startsWith("..") && !isAbsolute(relativeToHome)) pwd = `~${sep}${relativeToHome}`;
		}
		const branch = this.footerData.getGitBranch();
		if (branch) pwd = `${pwd} (${branch})`;
		const sessionName = this.ctx.sessionManager.getSessionName();
		if (sessionName) pwd = `${pwd} • ${sessionName}`;

		// Second line, left: token stats, then TTFT and throughput.
		const statsParts: string[] = [];
		if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
		if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
		if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
		if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
		if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}
		const usingSubscription = this.usingSubscription();
		if (totals.cost || usingSubscription) {
			statsParts.push(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		}
		statsParts.push(...this.speedParts());

		const autoIndicator = this.autoCompactEnabled() ? " (auto)" : "";
		const contextDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) statsParts.push(theme.fg("error", contextDisplay));
		else if (contextPercentValue > 70) statsParts.push(theme.fg("warning", contextDisplay));
		else statsParts.push(contextDisplay);
		if (process.env.PI_EXPERIMENTAL === "1") {
			statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
		}

		let statsLeft = statsParts.join(" ");
		let statsLeftWidth = visibleWidth(statsLeft);
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Second line, right: model id and thinking level.
		const modelName = model?.id || "no-model";
		let rightSideWithoutProvider = modelName;
		if (model?.reasoning) {
			const thinkingLevel = this.ctx.thinkingLevel || "off";
			rightSideWithoutProvider =
				thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
		}

		const minPadding = 2;
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && model) {
			rightSide = `(${model.provider}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		let statsLine: string;
		if (statsLeftWidth + minPadding + rightSideWidth <= width) {
			statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
		} else {
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				statsLine = statsLeft;
			}
		}

		// Dim each half separately: statsLeft carries its own color codes for the context percent.
		const lines = [
			truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
			theme.fg("dim", statsLeft) + theme.fg("dim", statsLine.slice(statsLeft.length)),
		];

		// Extension statuses (ctx.ui.setStatus) share one dim line, sorted by key.
		const statuses = this.footerData.getExtensionStatuses();
		if (statuses.size > 0) {
			const statusLine = Array.from(statuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text))
				.join(" ");
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}

// ============================================================================
// Extension
// ============================================================================

function footerFactory(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	metrics: Metrics,
	getDisplayMode: () => DisplayMode,
): Parameters<ExtensionContext["ui"]["setFooter"]>[0] {
	return (_tui, theme, footerData) =>
		new MetricsFooter({
			ctx,
			theme,
			footerData,
			metrics,
			getSettings: () => pi.getSettings(),
			getDisplayMode,
		});
}

export default function (pi: ExtensionAPI): void {
	const metrics = new Metrics();
	let displayMode: DisplayMode = process.env.PI_TTFT_DISPLAY === "last" ? "last" : "avg";
	let footerEnabled = process.env.PI_TTFT_FOOTER !== "0";

	pi.on("session_start", (_event, ctx) => {
		metrics.clear();
		if (footerEnabled && ctx.mode === "tui") {
			ctx.ui.setFooter(footerFactory(ctx, pi, metrics, () => displayMode));
		}
	});

	// t0: headers are ready, the HTTP call is next.
	pi.on("before_provider_headers", (_event, ctx) => {
		metrics.beginRequest(ctx.model?.id ?? "no-model");
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		metrics.beginFallback(ctx.model?.id ?? "no-model");
	});

	pi.on("message_update", (event) => {
		const assistantEvent = event.assistantMessageEvent;
		if (!assistantEvent.type.endsWith("_delta")) return;
		const delta = (assistantEvent as { delta?: unknown }).delta;
		if (typeof delta === "string") metrics.noteDelta(assistantEvent.type, delta);
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		metrics.endResponse(event.message.usage);
	});

	pi.registerCommand("ttft", {
		description: "TTFT and throughput: [avg|last|reset|on|off]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "reset") {
				metrics.clear();
				ctx.ui.notify("TTFT stats reset", "info");
				return;
			}

			if (arg === "on" || arg === "off") {
				footerEnabled = arg === "on";
				ctx.ui.setFooter(
					footerEnabled && ctx.mode === "tui" ? footerFactory(ctx, pi, metrics, () => displayMode) : undefined,
				);
				ctx.ui.notify(`TTFT footer ${footerEnabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (arg === "avg" || arg === "last") {
				displayMode = arg;
				ctx.ui.notify(`TTFT footer shows the ${arg === "avg" ? "average" : "latest"} response`, "info");
				return;
			}

			const current = metrics.current(displayMode);
			if (!current) {
				ctx.ui.notify("No completed responses measured yet", "info");
				return;
			}
			const scope = displayMode === "avg" ? `avg of ${metrics.count}` : "last";
			const speed = (tps: number | undefined): string =>
				tps === undefined ? "" : ` · ${formatTps(tps)}t/s`;
			let message = `TTFT ${scope}: ${formatTtft(current.ttftMs)}${speed(current.tps)}`;
			for (const bucket of metrics.byModel()) {
				message +=
					` · ${bucket.model}: ${formatTtft(bucket.ttftMs)}${speed(bucket.tps)} (${bucket.count})`;
			}
			ctx.ui.notify(message, "info");
		},
	});
}
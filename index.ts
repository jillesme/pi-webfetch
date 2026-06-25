/**
 * webfetch - Fetch a URL and return readable content for the LLM.
 *
 * Strategy:
 *   1. curl -L with `Accept: text/markdown` first. Many doc sites
 *      (Cloudflare, Astro Starlight, etc.) serve a clean Markdown
 *      variant when asked, which is far cheaper on context than HTML.
 *   2. If the server returns markdown -> use it verbatim.
 *   3. If the server returns HTML -> convert it to Markdown with turndown.
 *   4. Otherwise pass the body through as plain text.
 *
 * Headless-browser fallback (client-side-rendered apps):
 *   curl gets an empty shell for React/Vite/Next CSR pages (tiny <body>,
 *   a mount node like <div id="root">, module scripts). When that is
 *   detected (`looksClientSideRendered()`), we re-render the DOM with a
 *   headless browser and convert the rendered HTML instead.
 *
 *   We never bundle or download Chromium. The render path prefers
 *   `playwright-core` (an optional dependency) driving an already-installed
 *   browser (Chrome/Edge/Chromium via Playwright "channels"), and falls
 *   back to spawning the system Chrome directly with `--dump-dom`. If no
 *   browser is available the curl result is used as-is.
 *
 * Output is truncated to pi's standard limits; the full body is written
 * to a temp file when truncated.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import TurndownService from "turndown";
import { createDocument } from "@mixmark-io/domino";

const USER_AGENT =
	"Mozilla/5.0 (compatible; pi-webfetch/0.1; +https://github.com/earendil-works)";
const CURL_MAX_TIME = 30; // seconds
const CURL_MAX_BYTES = 25 * 1024 * 1024; // hard cap on downloaded body
const RENDER_TIMEOUT = 20_000; // ms budget for the headless-browser render
// Playwright "channels" point at already-installed browsers (no download).
const PLAYWRIGHT_CHANNELS = ["chrome", "chrome-beta", "msedge", "chromium"] as const;

const WebFetchParams = Type.Object({
	url: Type.String({ description: "Absolute URL to fetch (http/https)" }),
	format: Type.Optional(
		StringEnum(["auto", "markdown", "html", "text"] as const, {
			description:
				"auto (default): prefer markdown, fall back to stripped text. " +
				"markdown: request the markdown variant. " +
				"html: return raw HTML. " +
				"text: always strip HTML to plain text.",
		}),
	),
	render: Type.Optional(
		StringEnum(["auto", "always", "never"] as const, {
			description:
				"Headless-browser rendering for JS-heavy pages. " +
				"auto (default): only render when the page looks client-side-rendered. " +
				"always: always render with a headless browser. " +
				"never: never render (curl only). Ignored when format=html.",
		}),
	),
});

type WebFetchFormat = "auto" | "markdown" | "html" | "text";
type WebFetchRender = "auto" | "always" | "never";

interface WebFetchDetails {
	url: string;
	finalUrl?: string;
	httpCode?: number;
	contentType?: string;
	bytes?: number;
	mode?: "markdown" | "html" | "text";
	converted?: "turndown";
	maybeClientSideApp?: boolean;
	rendered?: "playwright" | "chrome-dump-dom";
	renderError?: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
	error?: string;
}

interface CurlResult {
	body: string;
	httpCode: number;
	contentType: string;
	finalUrl: string;
}

function runCurl(
	url: string,
	acceptMarkdown: boolean,
	signal: AbortSignal | undefined,
): Promise<CurlResult> {
	return new Promise(async (resolvePromise, reject) => {
		const tmpDir = await mkdtemp(join(tmpdir(), "pi-webfetch-"));
		const bodyFile = join(tmpDir, "body");

		const args = [
			"-sSL",
			"-A",
			USER_AGENT,
			"--max-time",
			String(CURL_MAX_TIME),
			"--max-filesize",
			String(CURL_MAX_BYTES),
		];
		if (acceptMarkdown) {
			args.push("-H", "Accept: text/markdown");
		}
		// Write body to file; emit metadata on stdout.
		args.push("-o", bodyFile, "-w", "%{content_type}\n%{http_code}\n%{url_effective}");
		args.push(url);

		execFile("curl", args, { signal, maxBuffer: 1024 * 1024 }, async (err, stdout) => {
			if (err) {
				reject(new Error(`curl failed: ${err.message}`));
				return;
			}
			const [contentType = "", httpCodeRaw = "", finalUrl = ""] = stdout
				.trim()
				.split("\n");
			let body = "";
			try {
				body = await readFile(bodyFile, "utf8");
			} catch {
				// no body
			}
			resolvePromise({
				body,
				httpCode: Number.parseInt(httpCodeRaw, 10) || 0,
				contentType: contentType.trim(),
				finalUrl: finalUrl.trim() || url,
			});
		});
	});
}

function isMarkdown(contentType: string): boolean {
	return /text\/markdown|text\/x-markdown/i.test(contentType);
}

function isHtml(contentType: string): boolean {
	return /text\/html|application\/xhtml/i.test(contentType);
}

let turndownSingleton: TurndownService | undefined;
function getTurndown(): TurndownService {
	if (!turndownSingleton) {
		turndownSingleton = new TurndownService({
			headingStyle: "atx",
			codeBlockStyle: "fenced",
			bulletListMarker: "-",
		});
		// Drop noise that has no business in a text representation.
		// turndown parses HTML into a real DOM (via domino) and removes these
		// nodes there, so we don't need to pre-strip them with regex.
		turndownSingleton.remove(["script", "style", "noscript", "head", "svg"]);
	}
	return turndownSingleton;
}

/**
 * Convert an HTML document to Markdown. turndown handles the parsing and
 * structure; we only collapse excess blank lines in its output.
 */
function htmlToMarkdown(html: string): string {
	const md = getTurndown().turndown(html);
	return md.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Locate an installed Chrome/Chromium/Edge executable for the direct
 * `--dump-dom` fallback. We never download a browser; this only finds one
 * that already exists. Override with PI_WEBFETCH_CHROME.
 */
function findChromeExecutable(): string | undefined {
	const override = process.env.PI_WEBFETCH_CHROME;
	if (override && existsSync(override)) return override;

	const candidates: string[] =
		process.platform === "darwin"
			? [
					"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
					"/Applications/Chromium.app/Contents/MacOS/Chromium",
					"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
				]
			: process.platform === "win32"
				? [
						`${process.env["PROGRAMFILES"]}\\Google\\Chrome\\Application\\chrome.exe`,
						`${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
						`${process.env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
					]
				: [
						"/usr/bin/google-chrome",
						"/usr/bin/google-chrome-stable",
						"/usr/bin/chromium",
						"/usr/bin/chromium-browser",
						"/usr/bin/microsoft-edge",
						"/snap/bin/chromium",
					];

	return candidates.find((p) => p && existsSync(p));
}

/**
 * Render a URL with `playwright-core` driving an already-installed browser.
 * Returns the rendered HTML, or null if playwright-core isn't installed or
 * no usable browser channel/executable could be launched.
 */
async function renderWithPlaywright(
	url: string,
	signal: AbortSignal | undefined,
): Promise<string | null> {
	let chromium: typeof import("playwright-core").chromium;
	try {
		({ chromium } = await import("playwright-core"));
	} catch {
		return null; // optional dependency not installed
	}

	const exe = findChromeExecutable();
	const attempts: Array<{ channel?: string; executablePath?: string }> = [
		...PLAYWRIGHT_CHANNELS.map((channel) => ({ channel })),
		...(exe ? [{ executablePath: exe }] : []),
	];

	let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
	for (const attempt of attempts) {
		if (signal?.aborted) return null;
		try {
			browser = await chromium.launch({ headless: true, ...attempt });
			break;
		} catch {
			// channel/executable not present; try the next one
		}
	}
	if (!browser) return null;

	const onAbort = () => void browser?.close().catch(() => {});
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const page = await browser.newPage({ userAgent: USER_AGENT });
		try {
			await page.goto(url, { waitUntil: "networkidle", timeout: RENDER_TIMEOUT });
		} catch {
			// networkidle can time out on pages that long-poll; fall back to
			// whatever has loaded so far rather than failing the render.
		}
		return await page.content();
	} finally {
		signal?.removeEventListener("abort", onAbort);
		await browser.close().catch(() => {});
	}
}

/**
 * Zero-dependency fallback: drive the system Chrome with `--dump-dom`, which
 * prints the serialized DOM after the page loads. Used when playwright-core
 * isn't installed. Returns null if no Chrome is found or it errors.
 */
function renderWithChromeDumpDom(
	url: string,
	signal: AbortSignal | undefined,
): Promise<string | null> {
	const exe = findChromeExecutable();
	if (!exe) return Promise.resolve(null);

	return new Promise((resolve) => {
		const args = [
			"--headless=new",
			"--disable-gpu",
			"--no-sandbox",
			`--user-agent=${USER_AGENT}`,
			`--virtual-time-budget=${RENDER_TIMEOUT}`,
			"--dump-dom",
			url,
		];
		execFile(
			exe,
			args,
			{ signal, timeout: RENDER_TIMEOUT + 5_000, maxBuffer: CURL_MAX_BYTES },
			(err, stdout) => {
				if (err || !stdout) {
					resolve(null);
					return;
				}
				resolve(stdout);
			},
		);
	});
}

/**
 * Render a URL to fully-hydrated HTML using an already-installed browser.
 * Tries playwright-core first, then a direct system-Chrome `--dump-dom`.
 */
async function renderViaBrowser(
	url: string,
	signal: AbortSignal | undefined,
): Promise<{ html: string; engine: "playwright" | "chrome-dump-dom" } | null> {
	const pwHtml = await renderWithPlaywright(url, signal);
	if (pwHtml) return { html: pwHtml, engine: "playwright" };
	if (signal?.aborted) return null;
	const chromeHtml = await renderWithChromeDumpDom(url, signal);
	if (chromeHtml) return { html: chromeHtml, engine: "chrome-dump-dom" };
	return null;
}

/**
 * Heuristic: does this HTML look like an empty client-side-rendered shell
 * (React + Vite, etc.) where the real content only exists after JS runs?
 * Used to flag pages that would benefit from a future headless-chrome
 * fallback. Parses a real DOM (no regex) and returns true when the visible
 * body text is tiny but the page ships a mount node and/or ES modules.
 */
function looksClientSideRendered(html: string): boolean {
	let doc: ReturnType<typeof createDocument>;
	try {
		doc = createDocument(html, true);
	} catch {
		return false;
	}

	const body = doc.body;
	const visibleText = (body?.textContent ?? "").replace(/\s+/g, " ").trim();

	const hasMountNode = ["root", "app", "__next", "___gatsby"].some((id) => {
		const el = doc.getElementById(id);
		return el != null && (el.textContent ?? "").trim().length === 0;
	});
	const hasModuleScript = doc.querySelectorAll('script[type="module"]').length > 0;
	const hasViteMarker = Array.from(doc.querySelectorAll("script[src]")).some((s) => {
		const src = (s as { getAttribute(name: string): string | null }).getAttribute("src") ?? "";
		return src.includes("/@vite/client") || /\/src\/main\.(t|j)sx?/.test(src);
	});

	return visibleText.length < 200 && (hasMountNode || hasModuleScript || hasViteMarker);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "webfetch",
		label: "Web Fetch",
		description:
			"Fetch a web page and return its readable content. Requests a Markdown " +
			"version first (Accept: text/markdown), which many docs sites serve and " +
			`which is far cheaper on context than HTML. Output is truncated to ${DEFAULT_MAX_LINES} ` +
			`lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever first); the full body is saved to a ` +
			"temp file when truncated. Use the 'format' parameter to force markdown/html/text.",
		promptSnippet: "Fetch a URL as Markdown (preferred), HTML, or plain text",
		promptGuidelines: [
			"Use webfetch to read web pages and online documentation instead of curl in bash.",
		],
		parameters: WebFetchParams,

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const url = params.url.trim();
			const format: WebFetchFormat = params.format ?? "auto";
			const render: WebFetchRender = params.render ?? "auto";

			if (!/^https?:\/\//i.test(url)) {
				throw new Error(`Invalid URL (must be http/https): ${url}`);
			}

			onUpdate?.({ content: [{ type: "text", text: `Fetching ${url} ...` }] });

			const wantMarkdown = format === "auto" || format === "markdown";
			const result = await runCurl(url, wantMarkdown, signal);

			const details: WebFetchDetails = {
				url,
				finalUrl: result.finalUrl,
				httpCode: result.httpCode,
				contentType: result.contentType,
				bytes: Buffer.byteLength(result.body, "utf8"),
			};

			if (result.httpCode === 0) {
				details.error = "No HTTP response";
				throw new Error(`webfetch: no response from ${url}`);
			}
			if (result.httpCode >= 400) {
				details.error = `HTTP ${result.httpCode}`;
				throw new Error(`webfetch: HTTP ${result.httpCode} for ${url}`);
			}

			let bodyIsHtml = isHtml(result.contentType);
			let body = result.body;

			if (bodyIsHtml && looksClientSideRendered(result.body)) {
				details.maybeClientSideApp = true;
			}

			// Headless-browser fallback: render JS-heavy pages before converting.
			// auto -> only when the page looks client-side-rendered; always ->
			// whenever the body is HTML; never / format=html -> skip.
			const shouldRender =
				format !== "html" &&
				render !== "never" &&
				bodyIsHtml &&
				(render === "always" || details.maybeClientSideApp);
			if (shouldRender) {
				onUpdate?.({
					content: [
						{ type: "text", text: `Rendering ${url} with a headless browser ...` },
					],
				});
				try {
					const rendered = await renderViaBrowser(url, signal);
					if (rendered) {
						body = rendered.html;
						bodyIsHtml = true;
						details.rendered = rendered.engine;
						details.bytes = Buffer.byteLength(body, "utf8");
						// We rendered the DOM, so the "may be incomplete" warning no
						// longer applies even if the shell-detection heuristic (module
						// scripts, short text) would still match the rendered page.
						details.maybeClientSideApp = false;
					} else {
						details.renderError = "no headless browser available";
					}
				} catch (err) {
					details.renderError = err instanceof Error ? err.message : String(err);
				}
			}

			// Decide how to present the body.
			let text: string;
			if (format === "html") {
				details.mode = "html";
				text = body;
			} else if (isMarkdown(result.contentType) && !details.rendered) {
				details.mode = "markdown";
				text = body;
			} else if (bodyIsHtml) {
				// markdown / auto / text on an HTML body: convert with turndown.
				details.mode = format === "text" ? "text" : "markdown";
				details.converted = "turndown";
				text = htmlToMarkdown(body);
			} else {
				// Non-HTML, non-markdown body (json, plain text, etc.): pass through.
				details.mode = "text";
				text = body;
			}

			const truncation = truncateHead(text, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			let resultText = truncation.content;

			if (truncation.truncated) {
				const tmpDir = await mkdtemp(join(tmpdir(), "pi-webfetch-out-"));
				const tempFile = join(tmpDir, "content.txt");
				await writeFile(tempFile, text, "utf8");
				details.truncation = truncation;
				details.fullOutputPath = tempFile;

				const omittedLines = truncation.totalLines - truncation.outputLines;
				const omittedBytes = truncation.totalBytes - truncation.outputBytes;
				resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				resultText += ` ${omittedLines} lines (${formatSize(omittedBytes)}) omitted.`;
				resultText += ` Full output saved to: ${tempFile}]`;
			}

			let header = `# ${url}\n[${details.mode} | HTTP ${result.httpCode} | ${result.contentType} | ${formatSize(details.bytes ?? 0)}]\n`;
			if (details.rendered) {
				header += `[rendered with headless browser (${details.rendered})]\n`;
			}
			if (details.maybeClientSideApp) {
				header += details.renderError
					? `[warning: page looks like a client-side-rendered app and headless rendering failed (${details.renderError}); the body may be incomplete]\n`
					: "[warning: page looks like a client-side-rendered app (little static content); " +
						"the body may be incomplete until a headless browser renders it]\n";
			}
			header += "\n";

			return {
				content: [{ type: "text", text: header + resultText }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("webfetch "));
			text += theme.fg("accent", args.url);
			if (args.format && args.format !== "auto") {
				text += theme.fg("dim", ` (${args.format})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			}
			const details = result.details as WebFetchDetails | undefined;
			if (!details) {
				return new Text(theme.fg("dim", "done"), 0, 0);
			}
			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			let text = theme.fg("success", `✓ ${details.mode}`);
			if (details.rendered) {
				text += theme.fg("accent", ` ⚡rendered`);
			}
			if (details.converted === "turndown") {
				text += theme.fg("dim", " (turndown)");
			}
			text += theme.fg("muted", ` HTTP ${details.httpCode} · ${formatSize(details.bytes ?? 0)}`);
			if (details.truncation?.truncated) {
				text += theme.fg("warning", " (truncated)");
			}
			if (details.maybeClientSideApp) {
				text += theme.fg("warning", " ⚠ client-side app?");
			}

			if (expanded) {
				if (details.rendered) {
					text += `\n${theme.fg("dim", `rendered via ${details.rendered}`)}`;
				}
				if (details.renderError) {
					text += `\n${theme.fg("warning", `render: ${details.renderError}`)}`;
				}
				if (details.finalUrl && details.finalUrl !== details.url) {
					text += `\n${theme.fg("dim", `→ ${details.finalUrl}`)}`;
				}
				if (details.contentType) {
					text += `\n${theme.fg("dim", details.contentType)}`;
				}
				if (details.fullOutputPath) {
					text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
				}
			}
			return new Text(text, 0, 0);
		},
	});
}

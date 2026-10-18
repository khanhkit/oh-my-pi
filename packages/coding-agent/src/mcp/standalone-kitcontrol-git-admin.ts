import { isAbsolute } from "node:path";
import type { StandaloneTool, StandaloneToolContext, StandaloneToolResult } from "./standalone-harness";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const BRIDGE_TIMEOUT_MS = 30_000;

function terminateProcessTree(proc: ReturnType<typeof Bun.spawn>): void {
	if (process.platform !== "win32" && proc.pid) {
		try {
			process.kill(-proc.pid, "SIGTERM");
			return;
		} catch {
			// Fall through to the direct child when no process group is available.
		}
	}
	try {
		proc.kill("SIGTERM");
	} catch {
		// Process may already be gone.
	}
}

function bridgeExecutable(): string {
	const bridge = process.env.OMP_KITCONTROL_GIT_ADMIN_BRIDGE;
	if (!bridge || !isAbsolute(bridge)) {
		throw new Error("OMP_KITCONTROL_GIT_ADMIN_BRIDGE must be configured as an absolute path");
	}
	return bridge;
}

function bridgeEnvironment(): Record<string, string> {
	const env: Record<string, string> = {
		PATH: "/usr/bin:/bin",
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
	};
	if (process.env.KITCONTROL_ROOT) env.KITCONTROL_ROOT = process.env.KITCONTROL_ROOT;
	return env;
}

async function readBoundedResponse(
	stream: ReadableStream<Uint8Array>,
	proc: ReturnType<typeof Bun.spawn>,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) {
				terminateProcessTree(proc);
				throw new Error("Git administration bridge response exceeds size limit");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

function isFullSha(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function hasExactKeys(response: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(response).sort();
	const wanted = [...expected].sort();
	return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validateSuccessResponse(response: Record<string, unknown>, action: unknown): Record<string, unknown> {
	if (action === "stage") {
		if (
			!hasExactKeys(response, ["ok", "action", "head", "staged_count"]) ||
			response.ok !== true ||
			response.action !== "stage" ||
			!isFullSha(response.head) ||
			!Number.isInteger(response.staged_count) ||
			(response.staged_count as number) < 1 ||
			(response.staged_count as number) > 128
		) {
			throw new Error("Git administration bridge returned invalid stage response");
		}
		return { ok: true, action: "stage", head: response.head, staged_count: response.staged_count };
	}
	if (action === "commit") {
		if (
			!hasExactKeys(response, ["ok", "action", "old_head", "new_head", "committed_count"]) ||
			response.ok !== true ||
			response.action !== "commit" ||
			!isFullSha(response.old_head) ||
			!isFullSha(response.new_head) ||
			!Number.isInteger(response.committed_count) ||
			(response.committed_count as number) < 1 ||
			(response.committed_count as number) > 128
		) {
			throw new Error("Git administration bridge returned invalid commit response");
		}
		return {
			ok: true,
			action: "commit",
			old_head: response.old_head,
			new_head: response.new_head,
			committed_count: response.committed_count,
		};
	}
	throw new Error("Git administration request action is invalid");
}

async function invokeGitAdminBridge(
	request: Record<string, unknown>,
	ctx: StandaloneToolContext,
): Promise<Record<string, unknown>> {
	if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error("Aborted");
	const encoded = JSON.stringify(request);
	if (Buffer.byteLength(encoded, "utf8") > MAX_REQUEST_BYTES) {
		throw new Error("Git administration request exceeds size limit");
	}

	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn([bridgeExecutable()], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
			detached: process.platform !== "win32",
			env: bridgeEnvironment(),
		});
	} catch {
		throw new Error("Git administration bridge unavailable");
	}

	const stdin = proc.stdin;
	if (stdin && typeof stdin !== "number") {
		stdin.write(encoded);
		stdin.end();
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	let rejectAbort: (() => void) | undefined;
	const abort = () => terminateProcessTree(proc);
	ctx.signal?.addEventListener("abort", abort, { once: true });
	try {
		const output = readBoundedResponse(proc.stdout as ReadableStream<Uint8Array>, proc);
		const completed = Promise.all([output, proc.exited] as const);
		const outcome = await Promise.race([
			completed,
			new Promise<"timeout">(resolveTimeout => {
				timer = setTimeout(() => {
					terminateProcessTree(proc);
					resolveTimeout("timeout");
				}, BRIDGE_TIMEOUT_MS);
			}),
			new Promise<never>((_, reject) => {
				if (ctx.signal?.aborted) reject(ctx.signal.reason ?? new Error("Aborted"));
				else {
					rejectAbort = () => reject(ctx.signal?.reason ?? new Error("Aborted"));
					ctx.signal?.addEventListener("abort", rejectAbort, { once: true });
				}
			}),
		]);
		if (outcome === "timeout") {
			await proc.exited.catch(() => undefined);
			throw new Error("Git administration bridge timed out");
		}
		const [buffer, code] = outcome;
		if (code !== 0) {
			throw new Error(`Git administration bridge rejected request (${code})`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder().decode(buffer));
		} catch {
			throw new Error("Git administration bridge returned malformed JSON");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("Git administration bridge returned invalid response");
		}
		const response = parsed as Record<string, unknown>;
		if (response.ok !== true) {
			throw new Error("Git administration request denied");
		}
		return validateSuccessResponse(response, request.action);
	} finally {
		if (timer) clearTimeout(timer);
		ctx.signal?.removeEventListener("abort", abort);
		if (rejectAbort) ctx.signal?.removeEventListener("abort", rejectAbort);
	}
}

export async function runStandaloneGitAdmin(
	args: Record<string, unknown>,
	ctx: StandaloneToolContext,
): Promise<StandaloneToolResult> {
	try {
		const response = await invokeGitAdminBridge(args, ctx);
		return { text: JSON.stringify(response) };
	} catch (error) {
		return { text: error instanceof Error ? error.message : String(error), isError: true };
	}
}

export function createGitAdminTool(): StandaloneTool {
	return {
		name: "git_admin",
		description:
			"Stage or commit exact tracked paths in a current durable KitControl worktree through the dedicated machine-side Git administration transaction channel. This tool does not expose arbitrary Git commands or push.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["stage", "commit"] },
				cwd: { type: "string", description: "Exact current durable worktree root." },
				expected_head: { type: "string", pattern: "^[0-9a-f]{40}$" },
				paths: { type: "array", minItems: 1, maxItems: 128, items: { type: "string" } },
				message: { type: "string", minLength: 1, maxLength: 4096 },
			},
			required: ["action", "cwd", "expected_head", "paths"],
			additionalProperties: false,
		},
		write: true,
		privileged: true,
		async run(args, ctx) {
			return runStandaloneGitAdmin(args, ctx);
		},
	};
}

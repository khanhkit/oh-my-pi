import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { StandaloneTool, StandaloneToolContext, StandaloneToolResult } from "./standalone-harness";

export const GOALKEEPER_LIFECYCLE_ACTIONS = [
	"supervisor_bootstrap",
	"onboard",
	"spawn",
	"bootstrap",
	"assess",
	"recover",
	"bind",
	"claim",
	"heartbeat",
	"block",
	"escalation_propose",
	"escalation_claim",
	"escalation_resolve",
	"close",
	"release",
	"park",
] as const;

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

function configuredAbsolutePath(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback;
	if (!value || !isAbsolute(value)) {
		throw new Error(`${name} must be configured as an absolute path`);
	}
	return value;
}

function terminate(proc: ReturnType<typeof spawn>): void {
	if (process.platform !== "win32" && proc.pid) {
		try {
			process.kill(-proc.pid, "SIGTERM");
			return;
		} catch {
			// Fall through to the direct child when a process group is unavailable.
		}
	}
	try {
		proc.kill("SIGTERM");
	} catch {
		// Process may already be gone.
	}
}

async function invokeLifecycleBridge(
	request: Record<string, unknown>,
	ctx: StandaloneToolContext,
): Promise<Record<string, unknown>> {
	const bridge = configuredAbsolutePath("OMP_KITCONTROL_GOALKEEPER_LIFECYCLE_BRIDGE");
	const python = configuredAbsolutePath("OMP_KITCONTROL_GOALKEEPER_LIFECYCLE_PYTHON", "/usr/bin/python3");
	const encoded = JSON.stringify(request);
	if (Buffer.byteLength(encoded, "utf8") > MAX_REQUEST_BYTES) {
		throw new Error("GoalKeeper lifecycle request exceeds size limit");
	}
	if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error("Aborted");

	return await new Promise<Record<string, unknown>>((resolve, reject) => {
		let settled = false;
		let stdout = "";
		let stdoutBytes = 0;
		const proc = spawn(python, [bridge], {
			stdio: ["pipe", "pipe", "ignore"],
			detached: process.platform !== "win32",
			env: process.env,
		});

		const finishReject = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			terminate(proc);
			reject(error);
		};
		const finishResolve = (value: Record<string, unknown>) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		const onAbort = () => finishReject(ctx.signal?.reason instanceof Error ? ctx.signal.reason : new Error("Aborted"));
		const timer = setTimeout(() => finishReject(new Error("GoalKeeper lifecycle bridge timed out")), DEFAULT_TIMEOUT_MS);
		const cleanup = () => {
			clearTimeout(timer);
			ctx.signal?.removeEventListener("abort", onAbort);
		};

		ctx.signal?.addEventListener("abort", onAbort, { once: true });
		proc.on("error", () => finishReject(new Error("GoalKeeper lifecycle bridge unavailable")));
		proc.stdout?.on("data", (chunk: Buffer | string) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			stdoutBytes += Buffer.byteLength(text, "utf8");
			if (stdoutBytes > MAX_RESPONSE_BYTES) {
				finishReject(new Error("GoalKeeper lifecycle bridge response exceeds size limit"));
				return;
			}
			stdout += text;
		});
		proc.on("close", code => {
			if (settled) return;
			if (code !== 0) {
				finishReject(new Error(`GoalKeeper lifecycle bridge rejected request (${code ?? "signal"})`));
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(stdout);
			} catch {
				finishReject(new Error("GoalKeeper lifecycle bridge returned malformed JSON"));
				return;
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				finishReject(new Error("GoalKeeper lifecycle bridge returned invalid response"));
				return;
			}
			const response = parsed as Record<string, unknown>;
			if (response.ok !== true) {
				finishReject(new Error(typeof response.error === "string" ? response.error : "GoalKeeper lifecycle request denied"));
				return;
			}
			finishResolve(response);
		});

		proc.stdin?.end(encoded, "utf8");
	});
}

export async function runStandaloneGoalkeeperLifecycle(
	args: Record<string, unknown>,
	ctx: StandaloneToolContext,
): Promise<StandaloneToolResult> {
	try {
		const response = await invokeLifecycleBridge(args, ctx);
		return { text: JSON.stringify(response) };
	} catch (error) {
		return {
			text: error instanceof Error ? error.message : String(error),
			isError: true,
		};
	}
}

export function createGoalkeeperLifecycleTool(): StandaloneTool {
	return {
		name: "goalkeeper_lifecycle",
		description:
			"Perform an enumerated KitControl GoalKeeper lifecycle transition through the dedicated machine-side authority channel. Filesystem authority is resolved by KitControl; do not supply generation/session/task-run/claim credentials.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: [...GOALKEEPER_LIFECYCLE_ACTIONS] },
				project: { type: "string" },
				worker: { type: "string" },
				issue: { type: "string" },
				worktree: { type: "string", description: "Verified-unowned durable worktree binding target." },
				validated: { type: "boolean", description: "Required true for validated recovery." },
				reason: { type: "string" },
				for_seconds: { type: "integer", minimum: 0 },
				blockers: { type: "array", items: { type: "string" } },
				next: { type: "array", items: { type: "string" } },
				do_not: { type: "array", items: { type: "string" } },
				parent: { type: "string" },
				id: { type: "string" },
				architect_ref: { type: "string" },
				resolution: {
					type: "object",
					properties: {
						decision: { type: "string" },
						rationale: { type: "string" },
						constraints: { type: "array", items: { type: "string" } },
						evidence: { type: "array", items: { type: "string" } },
						action: { type: "string" },
						affected_workers: { type: "array", items: { type: "string" } },
					},
					required: ["decision", "rationale", "constraints", "evidence", "action", "affected_workers"],
					additionalProperties: false,
				},
				outcome: { type: "string", enum: ["DONE", "CANCELLED", "SUPERSEDED", "SPLIT", "ABANDONED"] },
				deactivate: { type: "boolean" },
				dry_run: { type: "boolean" },
				retry: { type: "boolean" },
			},
			required: ["action", "project"],
			additionalProperties: false,
		},
		write: true,
		async run(args, ctx) {
			return runStandaloneGoalkeeperLifecycle(args, ctx);
		},
	};
}

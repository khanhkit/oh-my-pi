import { spawn } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
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
	"close",
	"release",
	"park",
] as const;

export const ARCHITECT_LIFECYCLE_ACTIONS = ["escalation_claim", "escalation_resolve"] as const;

export interface TrustedLifecycleConfig {
	readonly role: "KitGoalKeeper" | "KitArchitect" | "KitDev";
	readonly project: string;
	readonly authorityRoot: string;
	readonly bridgePath: string;
	readonly bridgeRoot: string;
	readonly interpreterPath: string;
	readonly interpreterRoot: string;
}

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const FIXED_CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";

function isWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertMachineProject(project: string): void {
	if (!/^[A-Za-z0-9._-]+$/.test(project) || project === "." || project === "..") {
		throw new Error("machine lifecycle project binding is invalid");
	}
}

async function validateTrustedFile(
	label: "bridge" | "interpreter",
	filePath: string,
	trustedRoot: string,
	workspaceRoot: string,
): Promise<string> {
	if (!isAbsolute(filePath) || !isAbsolute(trustedRoot)) {
		throw new Error(`${label} path and trusted root must be absolute`);
	}
	const lexicalFile = resolve(filePath);
	const lexicalRoot = resolve(trustedRoot);
	const [fileLeaf, rootLeaf] = await Promise.all([lstat(lexicalFile), lstat(lexicalRoot)]);
	if (fileLeaf.isSymbolicLink()) throw new Error(`trusted ${label} must not be a symlink`);
	if (rootLeaf.isSymbolicLink()) throw new Error(`trusted ${label} root must not be a symlink`);

	const [fileReal, rootReal, workspaceReal] = await Promise.all([
		realpath(lexicalFile),
		realpath(lexicalRoot),
		realpath(workspaceRoot),
	]);
	if (fileReal !== lexicalFile || rootReal !== lexicalRoot) {
		throw new Error(`trusted ${label} path must not traverse symlinks`);
	}
	if (!isWithin(rootReal, fileReal)) {
		throw new Error(`${label} path is outside its trusted machine root`);
	}
	if (isWithin(workspaceReal, fileReal) || isWithin(workspaceReal, rootReal)) {
		throw new Error(`${label} path must be outside the model-writable workspace`);
	}

	const [fileStat, rootStat] = await Promise.all([stat(fileReal), stat(rootReal)]);
	if (!fileStat.isFile()) throw new Error(`trusted ${label} must be a regular file`);
	if (!rootStat.isDirectory()) throw new Error(`trusted ${label} root must be a directory`);
	const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
	for (const [kind, value] of [
		[`${label} file`, fileStat],
		[`${label} root`, rootStat],
	] as const) {
		if (currentUid !== undefined && value.uid !== 0 && value.uid !== currentUid) {
			throw new Error(`trusted ${kind} has unexpected ownership`);
		}
		if ((value.mode & 0o022) !== 0) {
			throw new Error(`trusted ${kind} is mutable by group or other users`);
		}
	}
	if ((fileStat.mode & 0o111) === 0) {
		throw new Error(`trusted ${label} is not executable`);
	}
	return fileReal;
}

function childEnvironment(): NodeJS.ProcessEnv {
	return {
		PATH: FIXED_CHILD_PATH,
		HOME: process.env.HOME,
		USER: process.env.USER,
		LOGNAME: process.env.LOGNAME,
		LANG: process.env.LANG ?? "C.UTF-8",
		LC_ALL: process.env.LC_ALL,
		TZ: process.env.TZ,
	};
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
	config: TrustedLifecycleConfig,
): Promise<Record<string, unknown>> {
	assertMachineProject(config.project);
	const [bridge, interpreter] = await Promise.all([
		validateTrustedFile("bridge", config.bridgePath, config.bridgeRoot, ctx.cwd),
		validateTrustedFile("interpreter", config.interpreterPath, config.interpreterRoot, ctx.cwd),
	]);
	if (!isAbsolute(config.authorityRoot)) {
		throw new Error("machine KitControl authority root must be absolute");
	}
	const encoded = JSON.stringify(request);
	if (Buffer.byteLength(encoded, "utf8") > MAX_REQUEST_BYTES) {
		throw new Error("lifecycle request exceeds size limit");
	}
	if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error("Aborted");

	return await new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
		let settled = false;
		let stdout = "";
		let stdoutBytes = 0;
		const proc = spawn(interpreter, [bridge, "--authority-root", config.authorityRoot, "--project", config.project], {
			stdio: ["pipe", "pipe", "ignore"],
			detached: process.platform !== "win32",
			env: childEnvironment(),
		});

		const cleanup = () => {
			clearTimeout(timer);
			ctx.signal?.removeEventListener("abort", onAbort);
		};
		const finishReject = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			terminate(proc);
			rejectPromise(error);
		};
		const finishResolve = (value: Record<string, unknown>) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolvePromise(value);
		};
		const onAbort = () =>
			finishReject(ctx.signal?.reason instanceof Error ? ctx.signal.reason : new Error("Aborted"));
		const timer = setTimeout(() => finishReject(new Error("lifecycle bridge timed out")), DEFAULT_TIMEOUT_MS);

		ctx.signal?.addEventListener("abort", onAbort, { once: true });
		proc.on("error", () => finishReject(new Error("lifecycle bridge unavailable")));
		proc.stdin?.on("error", error => {
			if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
				finishReject(new Error("lifecycle bridge stdin failed"));
			}
		});
		proc.stdout?.on("data", (chunk: Buffer | string) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			stdoutBytes += Buffer.byteLength(text, "utf8");
			if (stdoutBytes > MAX_RESPONSE_BYTES) {
				finishReject(new Error("lifecycle bridge response exceeds size limit"));
				return;
			}
			stdout += text;
		});
		proc.on("close", code => {
			if (settled) return;
			if (code !== 0) {
				finishReject(new Error(`lifecycle bridge rejected request (${code ?? "signal"})`));
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(stdout);
			} catch {
				finishReject(new Error("lifecycle bridge returned malformed JSON"));
				return;
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				finishReject(new Error("lifecycle bridge returned invalid response"));
				return;
			}
			const response = parsed as Record<string, unknown>;
			if (response.ok !== true) {
				finishReject(new Error(typeof response.error === "string" ? response.error : "lifecycle request denied"));
				return;
			}
			finishResolve(response);
		});
		proc.stdin?.end(encoded, "utf8");
	});
}

async function runLifecycle(
	args: Record<string, unknown>,
	ctx: StandaloneToolContext,
	config: TrustedLifecycleConfig,
): Promise<StandaloneToolResult> {
	try {
		const response = await invokeLifecycleBridge(args, ctx, config);
		return { text: JSON.stringify(response) };
	} catch (error) {
		return { text: error instanceof Error ? error.message : String(error), isError: true };
	}
}

const resolutionSchema = {
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
} as const;

function privilegedTool(
	name: "goalkeeper_lifecycle" | "architect_lifecycle" | "kitcontrol_lifecycle",
	description: string,
	actions: readonly string[],
	properties: Record<string, unknown>,
	config: TrustedLifecycleConfig,
): StandaloneTool {
	const allowedActions = new Set(actions);
	return {
		name,
		description,
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: [...actions] },
				...properties,
			},
			required: ["action"],
			additionalProperties: false,
		},
		write: true,
		execution: true,
		privileged: true,
		async run(args, ctx) {
			if (typeof args.action !== "string" || !allowedActions.has(args.action)) {
				return { text: `Unsupported lifecycle action for ${config.role}`, isError: true };
			}
			return runLifecycle(args, ctx, config);
		},
	};
}

export function createGoalkeeperLifecycleTool(config: TrustedLifecycleConfig): StandaloneTool {
	if (config.role !== "KitGoalKeeper")
		throw new Error("GoalKeeper lifecycle tool requires KitGoalKeeper machine role");
	return privilegedTool(
		"goalkeeper_lifecycle",
		"Perform an enumerated KitControl GoalKeeper lifecycle transition using machine-bound role and project authority.",
		GOALKEEPER_LIFECYCLE_ACTIONS,
		{
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
			outcome: { type: "string", enum: ["DONE", "CANCELLED", "SUPERSEDED", "SPLIT", "ABANDONED"] },
			deactivate: { type: "boolean" },
			dry_run: { type: "boolean" },
			retry: { type: "boolean" },
		},
		config,
	);
}

export function createArchitectLifecycleTool(config: TrustedLifecycleConfig): StandaloneTool {
	if (config.role !== "KitArchitect") throw new Error("Architect lifecycle tool requires KitArchitect machine role");
	return privilegedTool(
		"architect_lifecycle",
		"Claim or resolve KitControl escalations using machine-bound Architect role and project authority.",
		ARCHITECT_LIFECYCLE_ACTIONS,
		{
			id: { type: "string" },
			resolution: resolutionSchema,
		},
		config,
	);
}

/**
 * Common machine-private KitControl lifecycle surface for every engineering
 * actor role. Role names affect responsibility, not the action permission set.
 * Preserve the old tool names as compatibility aliases for existing clients.
 * Never add this tool to the shared HTTP standalone registry.
 */
export function createUnifiedLifecycleTool(config: TrustedLifecycleConfig): StandaloneTool {
	const goalkeeper = createGoalkeeperLifecycleTool({ ...config, role: "KitGoalKeeper" });
	const architect = createArchitectLifecycleTool({ ...config, role: "KitArchitect" });
	const goalProperties = (goalkeeper.parameters as { properties: Record<string, unknown> }).properties;
	const architectProperties = (architect.parameters as { properties: Record<string, unknown> }).properties;
	const { action: _goalAction, ...goalFields } = goalProperties;
	const { action: _archAction, ...archFields } = architectProperties;
	return privilegedTool(
		"kitcontrol_lifecycle",
		"Perform a guarded KitControl board/lifecycle action. Shared by all roles on a trusted host-only transport.",
		[...GOALKEEPER_LIFECYCLE_ACTIONS, ...ARCHITECT_LIFECYCLE_ACTIONS],
		{ ...goalFields, ...archFields },
		config,
	);
}

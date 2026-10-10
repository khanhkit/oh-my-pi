import { randomUUID } from "node:crypto";
import type { StandaloneToolContext, StandaloneToolResult } from "./standalone-harness";

export interface StandaloneBashArgs {
	command: string;
	worker?: string;
	session_epoch?: number;
	execution_id?: string;
}

export interface StandaloneBashOptions {
	rtkExecutable?: string;
	timeoutMs?: number;
	bridgeExecutable?: string;
	fenceRequired?: boolean;
	bridgeTimeoutMs?: number;
	heartbeatMs?: number;
}

export interface RtkRewriteResult {
	command: string;
	rewritten: boolean;
	reason: string;
}

export interface ExecutionIdentity {
	worker: string;
	sessionEpoch: number;
	executionId: string;
}

function terminateProcessTree(proc: { pid: number; kill(signal?: number | NodeJS.Signals): void }): void {
	if (process.platform !== "win32") {
		try {
			process.kill(-proc.pid, "SIGTERM");
			return;
		} catch {
			// Fall back to terminating only the direct child if process groups are unavailable.
		}
	}
	try {
		proc.kill("SIGTERM");
	} catch {
		// The process may have already exited.
	}
}

export function resolveExecutionIdentity(args: StandaloneBashArgs): ExecutionIdentity | undefined {
	const hasWorker = args.worker !== undefined;
	const hasEpoch = args.session_epoch !== undefined;
	const hasExecutionId = args.execution_id !== undefined;

	if (!hasWorker && !hasEpoch && !hasExecutionId) return undefined;
	if (!hasWorker || !hasEpoch) throw new Error("worker and session_epoch must be provided together");
	if (typeof args.worker !== "string" || !/^KitDev[1-9][0-9]*$/.test(args.worker)) {
		throw new Error("worker must be a valid KitDev worker name");
	}
	if (!Number.isSafeInteger(args.session_epoch) || args.session_epoch! <= 0) {
		throw new Error("session_epoch must be a positive integer");
	}
	if (hasExecutionId && (typeof args.execution_id !== "string" || args.execution_id.length === 0)) {
		throw new Error("execution_id must be a non-empty string");
	}

	return {
		worker: args.worker,
		sessionEpoch: args.session_epoch!,
		executionId: args.execution_id ?? randomUUID(),
	};
}

export async function rewriteWithRtk(
	command: string,
	options: StandaloneBashOptions & { signal?: AbortSignal } = {},
): Promise<RtkRewriteResult> {
	let proc: ReturnType<typeof Bun.spawn> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	if (options.signal?.aborted) return { command, rewritten: false, reason: "aborted" };
	try {
		proc = Bun.spawn([options.rtkExecutable ?? "rtk", "rewrite", command], {
			stdout: "pipe",
			stderr: "ignore",
			detached: process.platform !== "win32",
		});
		onAbort = () => terminateProcessTree(proc!);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const stdoutPromise = new Response(proc.stdout as ReadableStream<Uint8Array>).text();
		const completed = Promise.all([stdoutPromise, proc.exited] as const);
		const timeout = new Promise<"timeout">(resolve => {
			timer = setTimeout(() => {
				if (proc) terminateProcessTree(proc);
				resolve("timeout");
			}, options.timeoutMs ?? 250);
		});
		const result = await Promise.race([completed, timeout]);
		if (options.signal?.aborted) {
			await proc.exited.catch(() => undefined);
			return { command, rewritten: false, reason: "aborted" };
		}
		if (result === "timeout") {
			await proc.exited.catch(() => undefined);
			return { command, rewritten: false, reason: "timeout" };
		}
		const [stdout, exitCode] = result;
		const candidate = stdout.trim();
		if (exitCode === 0 && candidate.length > 0 && candidate !== command) {
			return { command: candidate, rewritten: true, reason: "rewritten" };
		}
		return { command, rewritten: false, reason: "fallback" };
	} catch {
		if (proc) terminateProcessTree(proc);
		return {
			command,
			rewritten: false,
			reason: options.signal?.aborted ? "aborted" : "unavailable",
		};
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort) options.signal?.removeEventListener("abort", onAbort);
	}
}

async function bridgeCall(
	identity: ExecutionIdentity,
	operation: "validate" | "event",
	options: StandaloneBashOptions,
	signal?: AbortSignal,
	event?: string,
	pid?: number,
	exitCode?: number,
): Promise<number> {
	const executable = options.bridgeExecutable ?? process.env.OMP_KITCONTROL_EXEC_BRIDGE;
	if (!executable || !executable.startsWith("/")) return -1;
	if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
	const argv = [executable, operation, identity.worker, String(identity.sessionEpoch)];
	if (operation === "event") {
		argv.push(identity.executionId, event!);
		if (pid !== undefined) argv.push("--pid", String(pid));
		if (exitCode !== undefined) argv.push("--exit-code", String(exitCode));
	}
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", detached: process.platform !== "win32" });
	} catch {
		return -1;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	let rejectAbort: (() => void) | undefined;
	const abort = () => terminateProcessTree(proc);
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const timeoutMs = options.bridgeTimeoutMs ?? 1000;
		const outcome = await Promise.race([
			proc.exited,
			new Promise<number>(resolve => {
				timer = setTimeout(() => {
					terminateProcessTree(proc);
					resolve(-1);
				}, timeoutMs);
			}),
			new Promise<number>((_, reject) => {
				if (signal?.aborted) reject(signal.reason ?? new Error("Aborted"));
				else {
					rejectAbort = () => reject(signal?.reason ?? new Error("Aborted"));
					signal?.addEventListener("abort", rejectAbort, { once: true });
				}
			}),
		]);
		if (outcome === -1) await proc.exited.catch(() => undefined);
		return outcome;
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		if (rejectAbort) signal?.removeEventListener("abort", rejectAbort);
	}
}

export async function runStandaloneBash(
	args: StandaloneBashArgs,
	ctx: StandaloneToolContext,
	options: StandaloneBashOptions = {},
): Promise<StandaloneToolResult> {
	const identity = resolveExecutionIdentity(args);
	if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error("Aborted");
	const required = options.fenceRequired ?? process.env.OMP_KITCONTROL_SESSION_FENCE_REQUIRED === "1";
	if (identity) {
		const status = await bridgeCall(identity, "validate", options, ctx.signal);
		if (status === 42) return { text: "SESSION_SUPERSEDED", isError: true };
		if (required && status !== 0) return { text: "SESSION_FENCE_UNAVAILABLE", isError: true };
	}
	let telemetry = Promise.resolve();
	const emit = (event: string, pid?: number, code?: number) => {
		if (!identity) return;
		telemetry = telemetry
			.then(() => bridgeCall(identity, "event", options, undefined, event, pid, code))
			.then(
				() => undefined,
				() => undefined,
			);
	};
	emit("EXEC_START");
	let terminal = false;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	const finish = (event: string, pid?: number, code?: number) => {
		if (!terminal) {
			terminal = true;
			if (heartbeat) clearInterval(heartbeat);
			emit(event, pid, code);
		}
	};
	try {
		const rewritten = await rewriteWithRtk(args.command, { ...options, signal: ctx.signal });
		if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error("Aborted");
		const env: Record<string, string | undefined> = { ...process.env };
		if (identity) {
			env.KIT_WORKER = identity.worker;
			env.KIT_SESSION_EPOCH = String(identity.sessionEpoch);
			env.KIT_EXECUTION_ID = identity.executionId;
		} else {
			delete env.KIT_WORKER;
			delete env.KIT_SESSION_EPOCH;
			delete env.KIT_EXECUTION_ID;
		}

		const proc = Bun.spawn(["bash", "-lc", rewritten.command], {
			cwd: ctx.cwd,
			env,
			stdout: "pipe",
			stderr: "pipe",
			detached: process.platform !== "win32",
		});
		const onAbort = () => {
			terminateProcessTree(proc);
			finish("EXEC_ABORT", proc.pid);
		};
		heartbeat = identity
			? setInterval(() => {
					if (!terminal) emit("EXEC_HEARTBEAT", proc.pid);
				}, options.heartbeatMs ?? 30_000)
			: undefined;
		ctx.signal?.addEventListener("abort", onAbort, { once: true });
		let stdout: string;
		let stderr: string;
		let exitCode: number;
		try {
			[stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
		} finally {
			ctx.signal?.removeEventListener("abort", onAbort);
			if (heartbeat) clearInterval(heartbeat);
		}
		finish("EXEC_END", proc.pid, exitCode);
		const combined = [stdout, stderr]
			.filter(part => part.length > 0)
			.join("\n")
			.trim();
		return {
			text: combined || `(exit ${exitCode})`,
			isError: exitCode !== 0,
		};
	} catch (error) {
		finish(ctx.signal?.aborted ? "EXEC_ABORT" : "EXEC_ERROR");
		throw error;
	}
}

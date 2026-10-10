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
	try {
		proc = Bun.spawn([options.rtkExecutable ?? "rtk", "rewrite", command], {
			stdout: "pipe",
			stderr: "ignore",
			signal: options.signal,
		});
		const stdoutPromise = new Response(proc.stdout).text();
		const completed = Promise.all([stdoutPromise, proc.exited] as const);
		const timeout = new Promise<"timeout">(resolve => {
			timer = setTimeout(() => {
				proc?.kill();
				resolve("timeout");
			}, options.timeoutMs ?? 250);
		});
		const result = await Promise.race([completed, timeout]);
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
		proc?.kill();
		return { command, rewritten: false, reason: "unavailable" };
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function runStandaloneBash(
	args: StandaloneBashArgs,
	ctx: StandaloneToolContext,
	options: StandaloneBashOptions = {},
): Promise<StandaloneToolResult> {
	const identity = resolveExecutionIdentity(args);
	const rewritten = await rewriteWithRtk(args.command, { ...options, signal: ctx.signal });
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
		signal: ctx.signal,
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	const combined = [stdout, stderr]
		.filter(part => part.length > 0)
		.join("\n")
		.trim();
	return {
		text: combined || `(exit ${exitCode})`,
		isError: exitCode !== 0,
	};
}

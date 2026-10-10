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

export async function runStandaloneBash(
	args: StandaloneBashArgs,
	ctx: StandaloneToolContext,
	_options: StandaloneBashOptions = {},
): Promise<StandaloneToolResult> {
	const identity = resolveExecutionIdentity(args);
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

	const proc = Bun.spawn(["bash", "-lc", args.command], {
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

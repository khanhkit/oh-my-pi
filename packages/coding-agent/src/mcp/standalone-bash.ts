import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { StandaloneToolContext, StandaloneToolResult } from "./standalone-harness";

export interface StandaloneBashArgs {
	command: string;
}

export interface DurableExecutionIdentity {
	worker: string;
	sessionEpoch: number;
	executionId?: string;
}

export interface StandaloneBashOptions {
	rtkExecutable?: string;
	timeoutMs?: number;
	bridgeExecutable?: string;
	fenceRequired?: boolean;
	bridgeTimeoutMs?: number;
	heartbeatMs?: number;
	/** Trusted server-side durable context. Never expose this in the model tool schema. */
	durableIdentity?: DurableExecutionIdentity;
	/** Linux filesystem sandbox used for actor-less command execution. */
	sandboxExecutable?: string;
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

interface EphemeralExecutionGrant {
	kind: "EPHEMERAL";
	project: string;
	projects?: string[];
	scope_root: string;
	writable_roots?: string[];
	cwd: string;
	protected_write_paths?: string[];
}

interface BridgeOutcome {
	code: number;
	stdout: string;
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

function isWithin(target: string, root: string): boolean {
	const rel = relative(resolve(root), resolve(target));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveExecutionIdentity(identity?: DurableExecutionIdentity): ExecutionIdentity | undefined {
	if (!identity) return undefined;
	if (typeof identity.worker !== "string" || !/^[A-Za-z_]+[1-9][0-9]*$/.test(identity.worker)) {
		throw new Error("durable worker must be a valid actor name");
	}
	if (!Number.isSafeInteger(identity.sessionEpoch) || identity.sessionEpoch <= 0) {
		throw new Error("durable session epoch must be a positive integer");
	}
	if (
		identity.executionId !== undefined &&
		(typeof identity.executionId !== "string" || identity.executionId.length === 0)
	) {
		throw new Error("execution_id must be a non-empty string");
	}
	return {
		worker: identity.worker,
		sessionEpoch: identity.sessionEpoch,
		executionId: identity.executionId ?? randomUUID(),
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
		const timeout = new Promise<"timeout">(resolveTimeout => {
			timer = setTimeout(() => {
				if (proc) terminateProcessTree(proc);
				resolveTimeout("timeout");
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

function bridgeExecutable(options: StandaloneBashOptions): string | undefined {
	const executable = options.bridgeExecutable ?? process.env.OMP_KITCONTROL_EXEC_BRIDGE;
	return executable && executable.startsWith("/") ? executable : undefined;
}

async function invokeBridge(
	argv: string[],
	options: StandaloneBashOptions,
	signal?: AbortSignal,
): Promise<BridgeOutcome> {
	if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(argv, {
			stdout: "pipe",
			stderr: "ignore",
			detached: process.platform !== "win32",
		});
	} catch {
		return { code: -1, stdout: "" };
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	let rejectAbort: (() => void) | undefined;
	const abort = () => terminateProcessTree(proc);
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const output = new Response(proc.stdout as ReadableStream<Uint8Array>).text();
		const completed = Promise.all([output, proc.exited] as const);
		const outcome = await Promise.race([
			completed,
			new Promise<"timeout">(resolveTimeout => {
				timer = setTimeout(() => {
					terminateProcessTree(proc);
					resolveTimeout("timeout");
				}, options.bridgeTimeoutMs ?? 1000);
			}),
			new Promise<never>((_, reject) => {
				if (signal?.aborted) reject(signal.reason ?? new Error("Aborted"));
				else {
					rejectAbort = () => reject(signal?.reason ?? new Error("Aborted"));
					signal?.addEventListener("abort", rejectAbort, { once: true });
				}
			}),
		]);
		if (outcome === "timeout") {
			await proc.exited.catch(() => undefined);
			return { code: -1, stdout: "" };
		}
		return { stdout: outcome[0], code: outcome[1] };
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		if (rejectAbort) signal?.removeEventListener("abort", rejectAbort);
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
	const executable = bridgeExecutable(options);
	if (!executable) return -1;
	const argv = [executable, operation, identity.worker, String(identity.sessionEpoch)];
	if (operation === "event") {
		argv.push(identity.executionId, event!);
		if (pid !== undefined) argv.push("--pid", String(pid));
		if (exitCode !== undefined) argv.push("--exit-code", String(exitCode));
	}
	return (await invokeBridge(argv, options, signal)).code;
}

function parseEphemeralGrant(raw: string, requestedCwd: string): EphemeralExecutionGrant | undefined {
	try {
		const value = JSON.parse(raw) as Partial<EphemeralExecutionGrant>;
		if (
			value.kind !== "EPHEMERAL" ||
			typeof value.project !== "string" ||
			typeof value.scope_root !== "string" ||
			typeof value.cwd !== "string"
		) {
			return undefined;
		}
		const cwd = resolve(value.cwd);
		const scopeRoot = resolve(value.scope_root);
		if (cwd !== resolve(requestedCwd) || !isWithin(cwd, scopeRoot)) return undefined;
		const writableRoots = value.writable_roots ?? [value.scope_root];
		if (!Array.isArray(writableRoots) || writableRoots.length === 0) return undefined;
		for (const root of writableRoots) {
			if (typeof root !== "string" || !isWithin(resolve(root), scopeRoot)) return undefined;
		}
		const protectedPaths = value.protected_write_paths ?? [];
		if (!Array.isArray(protectedPaths) || protectedPaths.some(path => typeof path !== "string")) return undefined;
		return {
			kind: "EPHEMERAL",
			project: value.project,
			projects: value.projects,
			scope_root: scopeRoot,
			writable_roots: writableRoots.map(root => resolve(root)),
			cwd,
			protected_write_paths: protectedPaths.map(path => resolve(path)),
		};
	} catch {
		return undefined;
	}
}

async function requestEphemeralGrant(
	cwd: string,
	options: StandaloneBashOptions,
	signal?: AbortSignal,
): Promise<EphemeralExecutionGrant | undefined> {
	const executable = bridgeExecutable(options);
	if (!executable) return undefined;
	const outcome = await invokeBridge([executable, "grant-ephemeral", cwd], options, signal);
	if (outcome.code !== 0) return undefined;
	return parseEphemeralGrant(outcome.stdout, cwd);
}

async function bridgeEphemeralEvent(
	grant: EphemeralExecutionGrant,
	executionId: string,
	event: string,
	options: StandaloneBashOptions,
	pid?: number,
	exitCode?: number,
): Promise<number> {
	if (grant.project === "MULTI_PROJECT") return 0;
	const executable = bridgeExecutable(options);
	if (!executable) return -1;
	const argv = [executable, "event-ephemeral", grant.project, grant.cwd, executionId, event];
	if (pid !== undefined) argv.push("--pid", String(pid));
	if (exitCode !== undefined) argv.push("--exit-code", String(exitCode));
	return (await invokeBridge(argv, options)).code;
}

export async function authorizeEphemeralPath(
	target: string,
	operation: "read" | "write" | "edit" | "execute",
	signal?: AbortSignal,
	options: StandaloneBashOptions = {},
): Promise<void> {
	const required = options.fenceRequired ?? process.env.OMP_KITCONTROL_SESSION_FENCE_REQUIRED === "1";
	if (!required) return;
	const executable = bridgeExecutable(options);
	if (!executable) throw new Error("SESSION_FENCE_UNAVAILABLE");
	const outcome = await invokeBridge([executable, "authorize-ephemeral-path", operation, target], options, signal);
	if (outcome.code !== 0) throw new Error("EPHEMERAL_AUTHORITY_DENIED");
}

function sandboxArgv(grant: EphemeralExecutionGrant, executable: string, command: string): string[] {
	const argv = [
		executable,
		"--die-with-parent",
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		"--tmpfs",
		"/tmp",
	];
	for (const root of grant.writable_roots ?? [grant.scope_root]) argv.push("--bind", root, root);
	for (const path of grant.protected_write_paths ?? []) argv.push("--ro-bind", path, path);
	argv.push("--chdir", grant.cwd, "--", "bash", "-lc", command);
	return argv;
}

export async function runStandaloneBash(
	args: StandaloneBashArgs,
	ctx: StandaloneToolContext,
	options: StandaloneBashOptions = {},
): Promise<StandaloneToolResult> {
	const identity = resolveExecutionIdentity(options.durableIdentity);
	if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error("Aborted");
	const required = options.fenceRequired ?? process.env.OMP_KITCONTROL_SESSION_FENCE_REQUIRED === "1";
	let grant: EphemeralExecutionGrant | undefined;
	if (identity) {
		const status = await bridgeCall(identity, "validate", options, ctx.signal);
		if (status === 42) return { text: "SESSION_SUPERSEDED", isError: true };
		if (required && status !== 0) return { text: "SESSION_FENCE_UNAVAILABLE", isError: true };
	} else if (required) {
		grant = await requestEphemeralGrant(ctx.cwd, options, ctx.signal);
		if (!grant) return { text: "SESSION_FENCE_UNAVAILABLE", isError: true };
	}

	const executionId = identity?.executionId ?? (grant ? randomUUID() : undefined);
	let telemetry = Promise.resolve();
	const emit = (event: string, pid?: number, code?: number) => {
		if (!identity && !grant) return;
		telemetry = telemetry
			.then(async () => {
				if (identity) await bridgeCall(identity, "event", options, undefined, event, pid, code);
				else if (grant && executionId) await bridgeEphemeralEvent(grant, executionId, event, options, pid, code);
			})
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
			if (executionId) env.KIT_EXECUTION_ID = executionId;
			else delete env.KIT_EXECUTION_ID;
		}

		let proc: ReturnType<typeof Bun.spawn>;
		try {
			const argv = grant
				? sandboxArgv(
						grant,
						options.sandboxExecutable ?? process.env.OMP_KITCONTROL_EPHEMERAL_SANDBOX ?? "bwrap",
						rewritten.command,
					)
				: ["bash", "-lc", rewritten.command];
			proc = Bun.spawn(argv, {
				cwd: ctx.cwd,
				env,
				stdout: "pipe",
				stderr: "pipe",
				detached: process.platform !== "win32",
			});
		} catch (error) {
			finish("EXEC_ERROR");
			if (grant) return { text: "EPHEMERAL_SANDBOX_UNAVAILABLE", isError: true };
			throw error;
		}

		const onAbort = () => {
			terminateProcessTree(proc);
			finish("EXEC_ABORT", proc.pid);
		};
		heartbeat = identity || grant
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
		if (grant && exitCode !== 0 && stderr.trimStart().startsWith("bwrap:")) {
			return { text: "EPHEMERAL_SANDBOX_UNAVAILABLE", isError: true };
		}
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

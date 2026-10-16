import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExecutionIdentity, rewriteWithRtk, runStandaloneBash } from "../src/mcp/standalone-bash";
import { createStandaloneTools, StandaloneHarness } from "../src/mcp/standalone-harness";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "omp-standalone-bash-"));
	tempDirs.push(path);
	return path;
}

async function fakeExecutable(body: string): Promise<string> {
	const dir = await workspace();
	const path = join(dir, "tool");
	await writeFile(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`, "utf8");
	await chmod(path, 0o755);
	return path;
}

const durable = (overrides: Partial<{ worker: string; sessionEpoch: number; executionId: string }> = {}) => ({
	worker: overrides.worker ?? "KitDev22",
	sessionEpoch: overrides.sessionEpoch ?? 2,
	...(overrides.executionId ? { executionId: overrides.executionId } : {}),
});

describe("trusted durable Bash attribution", () => {
	test("keeps missing trusted context unattributed", () => {
		expect(resolveExecutionIdentity()).toBeUndefined();
	});

	test("validates actor names and positive integer epochs", () => {
		expect(() => resolveExecutionIdentity({ worker: "dev-19", sessionEpoch: 1 })).toThrow();
		expect(() => resolveExecutionIdentity({ worker: "KitDev19", sessionEpoch: 0 })).toThrow();
		expect(() => resolveExecutionIdentity({ worker: "KitDev19", sessionEpoch: 1.5 })).toThrow();
	});

	test("generates an execution ID and preserves an explicit one", () => {
		const generated = resolveExecutionIdentity({ worker: "KitDev19", sessionEpoch: 7 });
		expect(generated?.worker).toBe("KitDev19");
		expect(generated?.sessionEpoch).toBe(7);
		expect(generated?.executionId.length).toBeGreaterThan(0);
		const explicit = resolveExecutionIdentity({ worker: "KitDev19", sessionEpoch: 7, executionId: "exec-123" });
		expect(explicit?.executionId).toBe("exec-123");
	});

	test("exports trusted durable attribution only through the child environment", async () => {
		const cwd = await workspace();
		const command = 'printf \'%s|%s|%s\' "$KIT_WORKER" "$KIT_SESSION_EPOCH" "$KIT_EXECUTION_ID"';
		const result = await runStandaloneBash(
			{ command },
			{ cwd },
			{
				rtkExecutable: "/missing",
				durableIdentity: durable({ worker: "KitDev19", sessionEpoch: 9, executionId: "exec-env" }),
			},
		);
		expect(result).toEqual({ text: "KitDev19|9|exec-env", isError: false });
	});
});

describe("standalone Bash RTK rewrite", () => {
	test("accepts exit 0 with non-empty rewritten stdout", async () => {
		const rtk = await fakeExecutable("test \"$1\" = rewrite\nprintf 'printf rewritten'");
		await expect(rewriteWithRtk("printf original", { rtkExecutable: rtk })).resolves.toEqual({
			command: "printf rewritten",
			rewritten: true,
			reason: "rewritten",
		});
	});

	test.each([1, 2, 3])("falls back on RTK exit %d", async exitCode => {
		const rtk = await fakeExecutable(`exit ${exitCode}`);
		const command = "printf 'a; b && c | d > e'";
		const result = await rewriteWithRtk(command, { rtkExecutable: rtk });
		expect(result.command).toBe(command);
		expect(result.rewritten).toBe(false);
	});

	test("falls back when RTK is missing or times out", async () => {
		const missing = await rewriteWithRtk("printf original", { rtkExecutable: "/missing" });
		expect(missing.command).toBe("printf original");
		const rtk = await fakeExecutable("sleep 5; printf rewritten");
		const started = performance.now();
		const timed = await rewriteWithRtk("printf original", { rtkExecutable: rtk, timeoutMs: 30 });
		expect(timed.command).toBe("printf original");
		expect(performance.now() - started).toBeLessThan(1000);
	});

	test("passes shell syntax to RTK as one unchanged argv value", async () => {
		const dir = await workspace();
		const capture = join(dir, "capture");
		const rtk = await fakeExecutable(`printf '%s' "$2" > ${JSON.stringify(capture)}\nexit 1`);
		const command = `printf '%s\\n' "a;b && c | d > e $(echo x) 'quoted'"`;
		await rewriteWithRtk(command, { rtkExecutable: rtk });
		expect(await Bun.file(capture).text()).toBe(command);
	});
});

describe("standalone Bash harness contract", () => {
	test("descriptor exposes task inputs but no control metadata", () => {
		const harness = new StandaloneHarness("/tmp", createStandaloneTools());
		const bash = harness.getTool("bash");
		const parameters = bash?.parameters as { properties?: Record<string, unknown>; required?: string[] };
		expect(parameters.required).toEqual(["command"]);
		expect(Object.keys(parameters.properties ?? {})).toEqual(["command", "cwd"]);
	});

	test("rejects model-supplied control metadata instead of treating it as authority", async () => {
		const cwd = await workspace();
		const marker = join(cwd, "must-not-run");
		const harness = new StandaloneHarness(cwd, createStandaloneTools());
		const result = await harness.invokeTool({
			callId: "control-injection",
			toolName: "bash",
			arguments: {
				command: `touch ${JSON.stringify(marker)}`,
				worker: "KitDev19",
				session_epoch: 11,
				execution_id: "model-controlled",
			},
		});
		expect(result.isError).toBe(true);
		expect(await Bun.file(marker).exists()).toBe(false);
	});
});

describe("standalone Bash lifecycle regressions", () => {
	test("preserves stdout stderr and nonzero exit behavior when KitControl fencing is disabled", async () => {
		const cwd = await workspace();
		const result = await runStandaloneBash(
			{ command: "printf stdout; printf stderr >&2; exit 7" },
			{ cwd },
			{ rtkExecutable: "/missing", fenceRequired: false },
		);
		expect(result).toEqual({ text: "stdout\nstderr", isError: true });
	});

	test("abort during RTK preflight prevents Bash execution", async () => {
		const cwd = await workspace();
		const marker = join(cwd, "bash-ran");
		const rtk = await fakeExecutable("sleep 5; printf rewritten");
		const controller = new AbortController();
		const promise = runStandaloneBash(
			{ command: `touch ${JSON.stringify(marker)}` },
			{ cwd, signal: controller.signal },
			{ rtkExecutable: rtk, timeoutMs: 5000, fenceRequired: false },
		);
		await Bun.sleep(30);
		controller.abort();
		await promise.catch(() => undefined);
		await Bun.sleep(30);
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	test("abort during Bash execution terminates the running command", async () => {
		const cwd = await workspace();
		const started = join(cwd, "started");
		const completed = join(cwd, "completed");
		const controller = new AbortController();
		const promise = runStandaloneBash(
			{ command: `touch ${JSON.stringify(started)}; sleep 5; touch ${JSON.stringify(completed)}` },
			{ cwd, signal: controller.signal },
			{ rtkExecutable: "/missing", fenceRequired: false },
		);
		for (let i = 0; i < 400 && !(await Bun.file(started).exists()); i++) await Bun.sleep(5);
		expect(await Bun.file(started).exists()).toBe(true);
		controller.abort();
		await promise.catch(() => undefined);
		await Bun.sleep(30);
		expect(await Bun.file(completed).exists()).toBe(false);
	});
});

describe("KitControl durable execution bridge", () => {
	test("default validation timeout tolerates a slow but available authority bridge", async () => {
		const cwd = await workspace();
		const bridge = await fakeExecutable(`if [ "$1" = validate ]; then sleep 0.35; exit 0; fi`);
		const result = await runStandaloneBash(
			{ command: "printf validated" },
			{ cwd },
			{
				bridgeExecutable: bridge,
				fenceRequired: true,
				rtkExecutable: "/missing",
				durableIdentity: durable({ executionId: "slow-validate" }),
			},
		);
		expect(result).toEqual({ text: "validated", isError: false });
	});

	test("rejects stale durable context before RTK or Bash and never downgrades", async () => {
		const cwd = await workspace();
		const bridge = await fakeExecutable('if [ "$1" = validate ]; then exit 42; fi; exit 0');
		const result = await runStandaloneBash(
			{ command: "touch forbidden" },
			{ cwd },
			{
				bridgeExecutable: bridge,
				fenceRequired: true,
				rtkExecutable: "/missing",
				durableIdentity: durable({ sessionEpoch: 1 }),
			},
		);
		expect(result).toEqual({ text: "SESSION_SUPERSEDED", isError: true });
		expect(await Bun.file(join(cwd, "forbidden")).exists()).toBe(false);
	});

	test("fails closed when required durable bridge is unavailable", async () => {
		const cwd = await workspace();
		const result = await runStandaloneBash(
			{ command: "touch forbidden" },
			{ cwd },
			{ bridgeExecutable: "/missing", fenceRequired: true, durableIdentity: durable({ sessionEpoch: 1 }) },
		);
		expect(result).toEqual({ text: "SESSION_FENCE_UNAVAILABLE", isError: true });
		expect(await Bun.file(join(cwd, "forbidden")).exists()).toBe(false);
	});

	test("validates then executes and reports lifecycle", async () => {
		const cwd = await workspace();
		const bridge = await fakeExecutable(`printf '%s\\n' "$*" >> '${cwd}/events'`);
		const result = await runStandaloneBash(
			{ command: "printf success" },
			{ cwd },
			{
				bridgeExecutable: bridge,
				fenceRequired: true,
				rtkExecutable: "/missing",
				durableIdentity: durable({ sessionEpoch: 1, executionId: "test-id" }),
			},
		);
		expect(result).toEqual({ text: "success", isError: false });
		await Bun.sleep(100);
		const events = await Bun.file(join(cwd, "events")).text();
		expect(events).toContain("validate KitDev22 1");
		expect(events).toContain("event KitDev22 1 test-id EXEC_START");
		expect(events).toContain("event KitDev22 1 test-id EXEC_END");
	});
});

describe("KitControl durable lifecycle regressions", () => {
	test("durably records START before terminal when START delivery is slower", async () => {
		const cwd = await workspace();
		const bridge = await fakeExecutable(
			`if [ "$1" = validate ]; then exit 0; fi; if [ "\${5:-}" = EXEC_START ]; then sleep 0.20; fi; printf '%s\\n' "$*" >> '${cwd}/events'`,
		);
		const result = await runStandaloneBash(
			{ command: "true" },
			{ cwd },
			{
				bridgeExecutable: bridge,
				fenceRequired: true,
				bridgeTimeoutMs: 1000,
				rtkExecutable: "/missing",
				durableIdentity: durable({ executionId: "ordered" }),
			},
		);
		expect(result).toEqual({ text: "(exit 0)", isError: false });
		await Bun.sleep(300);
		const events = (await Bun.file(join(cwd, "events")).text()).split("\n").filter(Boolean);
		const start = events.findIndex(x => x.includes("EXEC_START"));
		const end = events.findIndex(x => x.includes("EXEC_END"));
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
	});

	test("heartbeat repeats and stops after terminal event", async () => {
		const cwd = await workspace();
		const bridge = await fakeExecutable(`printf '%s\\n' "$*" >> '${cwd}/events'`);
		await runStandaloneBash(
			{ command: "sleep 0.16" },
			{ cwd },
			{
				bridgeExecutable: bridge,
				fenceRequired: true,
				heartbeatMs: 25,
				rtkExecutable: "/missing",
				durableIdentity: durable(),
			},
		);
		await Bun.sleep(100);
		const before = (await Bun.file(join(cwd, "events")).text()).split("\n");
		expect(before.filter(x => x.includes("EXEC_HEARTBEAT")).length).toBeGreaterThanOrEqual(2);
		expect(before.filter(x => x.includes("EXEC_END")).length).toBe(1);
		await Bun.sleep(80);
		expect(
			(await Bun.file(join(cwd, "events")).text()).split("\n").filter(x => x.includes("EXEC_HEARTBEAT")).length,
		).toBe(before.filter(x => x.includes("EXEC_HEARTBEAT")).length);
	});

	test("event bridge failures do not alter command result", async () => {
		const cwd = await workspace();
		const bridge = await fakeExecutable('if [ "$1" = validate ]; then exit 0; fi; sleep 2');
		const result = await runStandaloneBash(
			{ command: "printf ok" },
			{ cwd },
			{
				bridgeExecutable: bridge,
				bridgeTimeoutMs: 15,
				fenceRequired: true,
				rtkExecutable: "/missing",
				durableIdentity: durable(),
			},
		);
		expect(result).toEqual({ text: "ok", isError: false });
	});

	test("abort produces one ABORT and never END or ERROR", async () => {
		const cwd = await workspace();
		const bridge = await fakeExecutable(`printf '%s\\n' "$*" >> '${cwd}/events'`);
		const controller = new AbortController();
		const running = runStandaloneBash(
			{ command: "sleep 3" },
			{ cwd, signal: controller.signal },
			{
				bridgeExecutable: bridge,
				fenceRequired: true,
				heartbeatMs: 20,
				rtkExecutable: "/missing",
				durableIdentity: durable(),
			},
		);
		await Bun.sleep(90);
		controller.abort();
		await running.catch(() => undefined);
		await Bun.sleep(100);
		const events = await Bun.file(join(cwd, "events")).text();
		expect(events.match(/EXEC_ABORT/g)?.length).toBe(1);
		expect(events).not.toContain("EXEC_END");
		expect(events).not.toContain("EXEC_ERROR");
	});

	test("RTK success and fallback emit matching lifecycle types", async () => {
		const cwd = await workspace();
		const bridge = await fakeExecutable(`printf '%s\\n' "$*" >> '${cwd}/events'`);
		for (const body of ['printf "printf rewritten"', "exit 1"]) {
			const rtk = await fakeExecutable(body);
			await runStandaloneBash(
				{ command: "printf original" },
				{ cwd },
				{ bridgeExecutable: bridge, fenceRequired: true, rtkExecutable: rtk, durableIdentity: durable() },
			);
			await Bun.sleep(60);
		}
		const events = (await Bun.file(join(cwd, "events")).text()).split("\n").filter(Boolean);
		expect(events.filter(x => x.includes("EXEC_START")).length).toBe(2);
		expect(events.filter(x => x.includes("EXEC_END")).length).toBe(2);
	});
});

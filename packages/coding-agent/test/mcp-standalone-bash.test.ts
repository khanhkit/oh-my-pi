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

async function fakeRtk(body: string): Promise<string> {
	const dir = await workspace();
	const path = join(dir, "rtk");
	await writeFile(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`, "utf8");
	await chmod(path, 0o755);
	return path;
}

describe("standalone Bash attribution", () => {
	test("keeps command-only calls unattributed", () => {
		expect(resolveExecutionIdentity({ command: "printf ok" })).toBeUndefined();
	});

	test("requires worker and session_epoch together", () => {
		expect(() => resolveExecutionIdentity({ command: "true", worker: "KitDev19" })).toThrow();
		expect(() => resolveExecutionIdentity({ command: "true", session_epoch: 1 })).toThrow();
	});

	test("validates worker names and positive integer epochs", () => {
		expect(() => resolveExecutionIdentity({ command: "true", worker: "dev19", session_epoch: 1 })).toThrow();
		expect(() => resolveExecutionIdentity({ command: "true", worker: "KitDev19", session_epoch: 0 })).toThrow();
		expect(() => resolveExecutionIdentity({ command: "true", worker: "KitDev19", session_epoch: 1.5 })).toThrow();
	});

	test("generates an execution ID and preserves an explicit one", () => {
		const generated = resolveExecutionIdentity({ command: "true", worker: "KitDev19", session_epoch: 7 });
		expect(generated?.worker).toBe("KitDev19");
		expect(generated?.sessionEpoch).toBe(7);
		expect(generated?.executionId.length).toBeGreaterThan(0);

		const explicit = resolveExecutionIdentity({
			command: "true",
			worker: "KitDev19",
			session_epoch: 7,
			execution_id: "exec-123",
		});
		expect(explicit?.executionId).toBe("exec-123");
	});

	test("exports attribution only through the child environment", async () => {
		const cwd = await workspace();
		const command = 'printf \'%s|%s|%s\' "$KIT_WORKER" "$KIT_SESSION_EPOCH" "$KIT_EXECUTION_ID"';
		const attributed = await runStandaloneBash(
			{ command, worker: "KitDev19", session_epoch: 9, execution_id: "exec-env" },
			{ cwd },
			{ rtkExecutable: "/definitely/missing/rtk" },
		);
		expect(attributed).toEqual({ text: "KitDev19|9|exec-env", isError: false });

		const unattributed = await runStandaloneBash({ command }, { cwd }, { rtkExecutable: "/definitely/missing/rtk" });
		expect(unattributed).toEqual({ text: "||", isError: false });
	});
});

describe("standalone Bash RTK rewrite", () => {
	test("accepts exit 0 with non-empty rewritten stdout", async () => {
		const rtk = await fakeRtk("test \"$1\" = rewrite\nprintf 'printf rewritten'");
		await expect(rewriteWithRtk("printf original", { rtkExecutable: rtk })).resolves.toEqual({
			command: "printf rewritten",
			rewritten: true,
			reason: "rewritten",
		});
	});

	test.each([1, 2, 3])("falls back on RTK exit %d", async exitCode => {
		const rtk = await fakeRtk(`exit ${exitCode}`);
		const command = "printf 'a; b && c | d > e'";
		const result = await rewriteWithRtk(command, { rtkExecutable: rtk });
		expect(result.command).toBe(command);
		expect(result.rewritten).toBe(false);
	});

	test("falls back on empty stdout", async () => {
		const rtk = await fakeRtk("exit 0");
		const result = await rewriteWithRtk("printf original", { rtkExecutable: rtk });
		expect(result.command).toBe("printf original");
		expect(result.rewritten).toBe(false);
	});

	test("falls back when RTK is missing", async () => {
		const result = await rewriteWithRtk("printf original", {
			rtkExecutable: "/definitely/missing/rtk",
		});
		expect(result.command).toBe("printf original");
		expect(result.rewritten).toBe(false);
	});

	test("times out RTK and falls back to original command", async () => {
		const rtk = await fakeRtk("sleep 5; printf rewritten");
		const started = performance.now();
		const result = await rewriteWithRtk("printf original", { rtkExecutable: rtk, timeoutMs: 30 });
		expect(result.command).toBe("printf original");
		expect(result.rewritten).toBe(false);
		expect(performance.now() - started).toBeLessThan(1000);
	});

	test("passes shell syntax to RTK as one unchanged argv value", async () => {
		const dir = await workspace();
		const capture = join(dir, "capture");
		const rtk = await fakeRtk(`printf '%s' "$2" > ${JSON.stringify(capture)}\nexit 1`);
		const command = `printf '%s\\n' "a;b && c | d > e $(echo x) 'quoted'"`;
		await rewriteWithRtk(command, { rtkExecutable: rtk });
		expect(await Bun.file(capture).text()).toBe(command);
	});
});

describe("standalone Bash harness contract", () => {
	test("descriptor exposes optional attribution fields while keeping command required", () => {
		const harness = new StandaloneHarness("/tmp", createStandaloneTools());
		const bash = harness.getTool("bash");
		expect(bash).toBeDefined();
		const parameters = bash?.parameters as {
			properties?: Record<string, unknown>;
			required?: string[];
		};
		expect(parameters.required).toEqual(["command"]);
		expect(parameters.properties).toHaveProperty("command");
		expect(parameters.properties).toHaveProperty("worker");
		expect(parameters.properties).toHaveProperty("session_epoch");
		expect(parameters.properties).toHaveProperty("execution_id");
	});

	test("harness accepts command-only calls and forwards attributed metadata", async () => {
		const cwd = await workspace();
		const harness = new StandaloneHarness(cwd, createStandaloneTools());
		const plain = await harness.invokeTool({
			callId: "plain",
			toolName: "bash",
			arguments: { command: "printf plain" },
		});
		expect(plain.isError).toBeFalsy();
		expect(plain.content[0]).toEqual({ type: "text", text: "plain" });

		const attributed = await harness.invokeTool({
			callId: "attributed",
			toolName: "bash",
			arguments: {
				command: 'printf \'%s|%s|%s\' "$KIT_WORKER" "$KIT_SESSION_EPOCH" "$KIT_EXECUTION_ID"',
				worker: "KitDev19",
				session_epoch: 11,
				execution_id: "from-harness",
			},
		});
		expect(attributed.isError).toBeFalsy();
		expect(attributed.content[0]).toEqual({ type: "text", text: "KitDev19|11|from-harness" });
	});
});

describe("standalone Bash lifecycle regressions", () => {
	test("preserves stdout stderr and nonzero exit behavior for command-only calls", async () => {
		const cwd = await workspace();
		const result = await runStandaloneBash(
			{ command: "printf stdout; printf stderr >&2; exit 7" },
			{ cwd },
			{ rtkExecutable: "/definitely/missing/rtk" },
		);
		expect(result).toEqual({ text: "stdout\nstderr", isError: true });
	});

	test("keeps attributed metadata in the live Bash child", async () => {
		const cwd = await workspace();
		const evidence = join(cwd, "evidence");
		const promise = runStandaloneBash(
			{
				command: `printf '%s|%s|%s' "$KIT_WORKER" "$KIT_SESSION_EPOCH" "$KIT_EXECUTION_ID" > ${JSON.stringify(evidence)}; sleep 0.15; printf done`,
				worker: "KitDev19",
				session_epoch: 12,
				execution_id: "live-child",
			},
			{ cwd },
			{ rtkExecutable: "/definitely/missing/rtk" },
		);
		for (let i = 0; i < 50 && !(await Bun.file(evidence).exists()); i++) await Bun.sleep(5);
		expect(await Bun.file(evidence).text()).toBe("KitDev19|12|live-child");
		await expect(promise).resolves.toEqual({ text: "done", isError: false });
	});

	test("abort during RTK preflight prevents Bash execution", async () => {
		const cwd = await workspace();
		const bashMarker = join(cwd, "bash-ran");
		const rtk = await fakeRtk("sleep 5; printf rewritten");
		const controller = new AbortController();
		const promise = runStandaloneBash(
			{ command: `touch ${JSON.stringify(bashMarker)}` },
			{ cwd, signal: controller.signal },
			{ rtkExecutable: rtk, timeoutMs: 5000 },
		);
		await Bun.sleep(30);
		controller.abort();
		await promise.catch(() => undefined);
		await Bun.sleep(30);
		expect(await Bun.file(bashMarker).exists()).toBe(false);
	});

	test("abort during Bash execution terminates the running command", async () => {
		const cwd = await workspace();
		const started = join(cwd, "started");
		const completed = join(cwd, "completed");
		const controller = new AbortController();
		const promise = runStandaloneBash(
			{ command: `touch ${JSON.stringify(started)}; sleep 5; touch ${JSON.stringify(completed)}` },
			{ cwd, signal: controller.signal },
			{ rtkExecutable: "/definitely/missing/rtk" },
		);
		for (let i = 0; i < 50 && !(await Bun.file(started).exists()); i++) await Bun.sleep(5);
		expect(await Bun.file(started).exists()).toBe(true);
		controller.abort();
		await promise.catch(() => undefined);
		await Bun.sleep(30);
		expect(await Bun.file(completed).exists()).toBe(false);
	});
});

describe("standalone Bash malformed metadata", () => {
	test("rejects a non-string execution_id before shell execution", async () => {
		const cwd = await workspace();
		const marker = join(cwd, "should-not-run");
		const harness = new StandaloneHarness(cwd, createStandaloneTools());
		const result = await harness.invokeTool({
			callId: "bad-execution-id",
			toolName: "bash",
			arguments: {
				command: `touch ${JSON.stringify(marker)}`,
				worker: "KitDev19",
				session_epoch: 13,
				execution_id: 123,
			},
		});
		expect(result.isError).toBe(true);
		expect(await Bun.file(marker).exists()).toBe(false);
	});
});

describe("KitControl execution bridge", () => {
	test("rejects stale sessions before RTK or Bash", async () => {
		const cwd = await workspace();
		const bridge = await fakeRtk("exit 42");
		const result = await runStandaloneBash(
			{ command: "touch forbidden", worker: "KitDev22", session_epoch: 1 },
			{ cwd },
			{ bridgeExecutable: bridge, fenceRequired: true, rtkExecutable: "/missing" },
		);
		expect(result).toEqual({ text: "SESSION_SUPERSEDED", isError: true });
		expect(await Bun.file(join(cwd, "forbidden")).exists()).toBe(false);
	});
	test("fails closed when required bridge is unavailable", async () => {
		const cwd = await workspace();
		const result = await runStandaloneBash(
			{ command: "touch forbidden", worker: "KitDev22", session_epoch: 1 },
			{ cwd },
			{ bridgeExecutable: "/missing", fenceRequired: true },
		);
		expect(result).toEqual({ text: "SESSION_FENCE_UNAVAILABLE", isError: true });
		expect(await Bun.file(join(cwd, "forbidden")).exists()).toBe(false);
	});
	test("validates then executes and reports lifecycle", async () => {
		const cwd = await workspace();
		const bridge = await fakeRtk(`printf '%s\\n' "$*" >> '${cwd}/events'`);
		const result = await runStandaloneBash(
			{ command: "printf success", worker: "KitDev22", session_epoch: 1, execution_id: "test-id" },
			{ cwd },
			{ bridgeExecutable: bridge, fenceRequired: true, rtkExecutable: "/missing" },
		);
		expect(result).toEqual({ text: "success", isError: false });
		await Bun.sleep(100);
		const events = await Bun.file(join(cwd, "events")).text();
		expect(events).toContain("validate KitDev22 1");
		expect(events).toContain("event KitDev22 1 test-id EXEC_START");
		expect(events).toContain("event KitDev22 1 test-id EXEC_END");
	});
});

describe("KitControl lifecycle regressions", () => {
	test("default event timeout tolerates a slow but available telemetry bridge", async () => {
		const cwd = await workspace();
		const bridge = await fakeRtk(
			`if [ "$1" = validate ]; then exit 0; fi; if [ "\${5:-}" = EXEC_START ]; then sleep 0.35; fi; printf '%s\\n' "$*" >> '${cwd}/events'`,
		);
		const result = await runStandaloneBash(
			{ command: "true", worker: "KitDev22", session_epoch: 2, execution_id: "slow-default" },
			{ cwd },
			{ bridgeExecutable: bridge, fenceRequired: true, rtkExecutable: "/missing" },
		);
		expect(result).toEqual({ text: "(exit 0)", isError: false });
		await Bun.sleep(800);
		const events = (await Bun.file(join(cwd, "events")).text()).split("\n").filter(Boolean);
		const lifecycle = events.filter(x => x.includes("slow-default"));
		expect(lifecycle.map(x => x.split(" ")[4])).toEqual(["EXEC_START", "EXEC_END"]);
	});
	test("durably records START before terminal when START delivery is slower", async () => {
		const cwd = await workspace();
		const bridge = await fakeRtk(
			`if [ "$1" = validate ]; then exit 0; fi; if [ "\${5:-}" = EXEC_START ]; then sleep 0.20; fi; printf '%s\\n' "$*" >> '${cwd}/events'`,
		);
		const result = await runStandaloneBash(
			{ command: "true", worker: "KitDev22", session_epoch: 2, execution_id: "ordered" },
			{ cwd },
			{ bridgeExecutable: bridge, fenceRequired: true, bridgeTimeoutMs: 1000, rtkExecutable: "/missing" },
		);
		expect(result).toEqual({ text: "(exit 0)", isError: false });
		await Bun.sleep(300);
		const events = (await Bun.file(join(cwd, "events")).text()).split("\n").filter(Boolean);
		const start = events.findIndex(x => x.includes("EXEC_START"));
		const end = events.findIndex(x => x.includes("EXEC_END"));
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
	});

	test("stops heartbeats immediately after ABORT is claimed", async () => {
		const cwd = await workspace();
		const bridge = await fakeRtk(`if [ "$1" = validate ]; then exit 0; fi; printf '%s\\n' "$*" >> '${cwd}/events'`);
		const controller = new AbortController();
		const running = runStandaloneBash(
			{
				command: "trap 'sleep 0.20; exit 0' TERM; while :; do sleep 1; done",
				worker: "KitDev22",
				session_epoch: 2,
				execution_id: "abort-ordered",
			},
			{ cwd, signal: controller.signal },
			{ bridgeExecutable: bridge, fenceRequired: true, heartbeatMs: 5, rtkExecutable: "/missing" },
		);
		await Bun.sleep(40);
		controller.abort();
		await running.catch(() => undefined);
		await Bun.sleep(300);
		const events = (await Bun.file(join(cwd, "events")).text()).split("\n").filter(Boolean);
		const abort = events.findIndex(x => x.includes("EXEC_ABORT"));
		expect(abort).toBeGreaterThanOrEqual(0);
		expect(events.slice(abort + 1).some(x => x.includes("EXEC_HEARTBEAT"))).toBe(false);
	});
	test("heartbeat repeats and stops after terminal event", async () => {
		const cwd = await workspace();
		const bridge = await fakeRtk(`printf '%s\\n' "$*" >> '${cwd}/events'`);
		await runStandaloneBash(
			{ command: "sleep 0.16", worker: "KitDev22", session_epoch: 2 },
			{ cwd },
			{ bridgeExecutable: bridge, fenceRequired: true, heartbeatMs: 25, rtkExecutable: "/missing" },
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
	test("event bridge failures and timeouts do not alter command result", async () => {
		const cwd = await workspace();
		const bridge = await fakeRtk('if [ "$1" = validate ]; then exit 0; fi; sleep 2');
		const result = await runStandaloneBash(
			{ command: "printf ok", worker: "KitDev22", session_epoch: 2 },
			{ cwd },
			{ bridgeExecutable: bridge, bridgeTimeoutMs: 15, fenceRequired: true, rtkExecutable: "/missing" },
		);
		expect(result).toEqual({ text: "ok", isError: false });
	});
	test("abort produces one ABORT and never END or ERROR", async () => {
		const cwd = await workspace();
		const bridge = await fakeRtk(`printf '%s\\n' "$*" >> '${cwd}/events'`);
		const controller = new AbortController();
		const running = runStandaloneBash(
			{ command: "sleep 3", worker: "KitDev22", session_epoch: 2 },
			{ cwd, signal: controller.signal },
			{ bridgeExecutable: bridge, fenceRequired: true, heartbeatMs: 20, rtkExecutable: "/missing" },
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
		const bridge = await fakeRtk(`printf '%s\\n' "$*" >> '${cwd}/events'`);
		for (const body of ['printf "printf rewritten"', "exit 1"]) {
			const rtk = await fakeRtk(body);
			await runStandaloneBash(
				{ command: "printf original", worker: "KitDev22", session_epoch: 2 },
				{ cwd },
				{ bridgeExecutable: bridge, fenceRequired: true, rtkExecutable: rtk },
			);
			await Bun.sleep(60);
		}
		const events = (await Bun.file(join(cwd, "events")).text())
			.split("\n")
			.filter(x => x.includes(" event ") || x.startsWith("event "));
		expect(events.filter(x => x.includes("EXEC_START")).length).toBe(2);
		expect(events.filter(x => x.includes("EXEC_END")).length).toBe(2);
	});
});

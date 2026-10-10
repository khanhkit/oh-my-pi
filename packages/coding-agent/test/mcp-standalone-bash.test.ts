import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveExecutionIdentity,
	rewriteWithRtk,
	runStandaloneBash,
} from "../src/mcp/standalone-bash";

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
		const command = "printf '%s|%s|%s' \"$KIT_WORKER\" \"$KIT_SESSION_EPOCH\" \"$KIT_EXECUTION_ID\"";
		const attributed = await runStandaloneBash(
			{ command, worker: "KitDev19", session_epoch: 9, execution_id: "exec-env" },
			{ cwd },
			{ rtkExecutable: "/definitely/missing/rtk" },
		);
		expect(attributed).toEqual({ text: "KitDev19|9|exec-env", isError: false });

		const unattributed = await runStandaloneBash(
			{ command },
			{ cwd },
			{ rtkExecutable: "/definitely/missing/rtk" },
		);
		expect(unattributed).toEqual({ text: "||", isError: false });
	});
});

describe("standalone Bash RTK rewrite", () => {
	test("accepts exit 0 with non-empty rewritten stdout", async () => {
		const rtk = await fakeRtk('test "$1" = rewrite\nprintf \'printf rewritten\'');
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

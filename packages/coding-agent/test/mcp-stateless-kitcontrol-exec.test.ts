import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStandaloneBash } from "../src/mcp/standalone-bash";
import { createStandaloneTools, StandaloneHarness } from "../src/mcp/standalone-harness";

const tempDirs: string[] = [];
const savedEnv = { ...process.env };

afterEach(async () => {
	for (const key of Object.keys(process.env)) {
		if (!(key in savedEnv)) delete process.env[key];
	}
	for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
	await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function workspace(prefix = "omp-stateless-"): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(path);
	return path;
}

async function executable(body: string): Promise<string> {
	const dir = await workspace();
	const path = join(dir, "tool");
	await writeFile(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`, "utf8");
	await chmod(path, 0o755);
	return path;
}

describe("stateless KitControl model surface", () => {
	test("bash descriptor exposes task inputs but no actor/session authority tokens", () => {
		const harness = new StandaloneHarness("/tmp", createStandaloneTools());
		const bash = harness.getTool("bash");
		expect(bash).toBeDefined();
		const parameters = bash?.parameters as { properties?: Record<string, unknown>; required?: string[] };
		expect(parameters.required).toEqual(["command"]);
		expect(Object.keys(parameters.properties ?? {})).toEqual(["command", "cwd"]);
		expect(parameters.properties).not.toHaveProperty("worker");
		expect(parameters.properties).not.toHaveProperty("session_epoch");
		expect(parameters.properties).not.toHaveProperty("execution_id");
	});
});

describe("filesystem-resolved KitControl Bash execution", () => {
	test("obtains an ephemeral filesystem grant then runs through the sandbox", async () => {
		const cwd = await workspace();
		const events = join(cwd, "bridge-events");
		const bridge = await executable(`
			printf '%s\\n' "$*" >> ${JSON.stringify(events)}
			if [ "$1" = grant-execution ]; then
				printf '{"kind":"EPHEMERAL","project":"Demo","scope_root":%s,"writable_roots":[%s],"cwd":%s,"protected_write_paths":[]}' ${JSON.stringify(JSON.stringify(cwd))} ${JSON.stringify(JSON.stringify(cwd))} ${JSON.stringify(JSON.stringify(cwd))}
			fi
		`);
		const sandboxArgs = join(cwd, "sandbox-args");
		const sandbox = await executable(`
			printf '%s\\n' "$*" > ${JSON.stringify(sandboxArgs)}
			while [ "$#" -gt 0 ] && [ "$1" != bash ]; do shift; done
			exec "$@"
		`);
		const result = await runStandaloneBash(
			{ command: "printf anonymous" },
			{ cwd },
			{
				bridgeExecutable: bridge,
				fenceRequired: true,
				sandboxExecutable: sandbox,
				rtkExecutable: "/missing",
			},
		);
		expect(result).toEqual({ text: "anonymous", isError: false });
		expect(await readFile(events, "utf8")).toContain(`grant-execution ${cwd}`);
		const args = await readFile(sandboxArgs, "utf8");
		expect(args).toContain("--ro-bind / /");
		expect(args).toContain(`--bind ${cwd} ${cwd}`);
	});

	test("resolves a durable worktree grant without model actor/session tokens", async () => {
		const root = await workspace();
		const durable = join(root, "worker");
		await Bun.write(join(durable, ".keep"), "x");
		const bridgeOps = join(root, "bridge-ops");
		const bridge = await executable(`
			printf '%s\\n' "$*" >> ${JSON.stringify(bridgeOps)}
			if [ "$1" = grant-execution ]; then
				printf '{"kind":"DURABLE","project":"Demo","worker":"KitDev22","generation":7,"scope_root":%s,"writable_roots":[%s],"cwd":%s,"protected_write_paths":[]}' ${JSON.stringify(JSON.stringify(durable))} ${JSON.stringify(JSON.stringify(durable))} ${JSON.stringify(JSON.stringify(durable))}
			fi
		`);
		const sandbox = await executable(`
			while [ "$#" -gt 0 ] && [ "$1" != bash ]; do shift; done
			exec "$@"
		`);
		const result = await runStandaloneBash(
			{ command: "pwd", cwd: durable },
			{ cwd: root },
			{
				bridgeExecutable: bridge,
				fenceRequired: true,
				sandboxExecutable: sandbox,
				rtkExecutable: "/missing",
			},
		);
		expect(result).toEqual({ text: durable, isError: false });
		expect(await readFile(bridgeOps, "utf8")).toContain(`grant-execution ${durable}`);
	});

	test("fails closed when the filesystem grant cannot be resolved", async () => {
		const cwd = await workspace();
		const marker = join(cwd, "must-not-exist");
		const bridgeOps = join(cwd, "bridge-ops");
		const bridge = await executable(`
			printf '%s\\n' "$1" >> ${JSON.stringify(bridgeOps)}
			if [ "$1" = grant-execution ]; then exit 2; fi
		`);
		const result = await runStandaloneBash(
			{ command: `touch ${JSON.stringify(marker)}` },
			{ cwd },
			{
				bridgeExecutable: bridge,
				fenceRequired: true,
				sandboxExecutable: "/definitely/missing/bwrap",
				rtkExecutable: "/missing",
			},
		);
		expect(result).toEqual({ text: "SESSION_FENCE_UNAVAILABLE", isError: true });
		expect(await readFile(bridgeOps, "utf8")).toBe("grant-execution\n");
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	test("fails closed when the sandbox is unavailable", async () => {
		const cwd = await workspace();
		const marker = join(cwd, "must-not-exist");
		const bridge = await executable(`
			if [ "$1" = grant-execution ]; then
				printf '{"kind":"EPHEMERAL","project":"Demo","scope_root":%s,"writable_roots":[%s],"cwd":%s,"protected_write_paths":[]}' ${JSON.stringify(JSON.stringify(cwd))} ${JSON.stringify(JSON.stringify(cwd))} ${JSON.stringify(JSON.stringify(cwd))}
			fi
		`);
		const result = await runStandaloneBash(
			{ command: `touch ${JSON.stringify(marker)}` },
			{ cwd },
			{
				bridgeExecutable: bridge,
				fenceRequired: true,
				sandboxExecutable: "/definitely/missing/bwrap",
				rtkExecutable: "/missing",
			},
		);
		expect(result).toEqual({ text: "EPHEMERAL_SANDBOX_UNAVAILABLE", isError: true });
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	test("legacy stale durable context still never falls back to generic execution", async () => {
		const cwd = await workspace();
		const marker = join(cwd, "must-not-exist");
		const bridgeOps = join(cwd, "bridge-ops");
		const bridge = await executable(`
			printf '%s\\n' "$1" >> ${JSON.stringify(bridgeOps)}
			if [ "$1" = validate ]; then exit 42; fi
			if [ "$1" = grant-execution ]; then exit 0; fi
		`);
		const result = await runStandaloneBash(
			{ command: `touch ${JSON.stringify(marker)}` },
			{ cwd },
			{
				bridgeExecutable: bridge,
				fenceRequired: true,
				durableIdentity: { worker: "KitDev22", sessionEpoch: 1 },
				sandboxExecutable: "/definitely/missing/bwrap",
				rtkExecutable: "/missing",
			},
		);
		expect(result).toEqual({ text: "SESSION_SUPERSEDED", isError: true });
		expect(await readFile(bridgeOps, "utf8")).toBe("validate\n");
		expect(await Bun.file(marker).exists()).toBe(false);
	});
});

describe("standalone file mutation confinement", () => {
	test("write asks generic filesystem authority rather than chat identity", async () => {
		const cwd = await workspace();
		const bridgeOps = join(cwd, "bridge-ops");
		const bridge = await executable(`printf '%s\\n' "$*" >> ${JSON.stringify(bridgeOps)}`);
		process.env.OMP_KITCONTROL_SESSION_FENCE_REQUIRED = "1";
		process.env.OMP_KITCONTROL_EXEC_BRIDGE = bridge;
		const harness = new StandaloneHarness(cwd, createStandaloneTools());
		const result = await harness.invokeTool({
			callId: "write-authority",
			toolName: "write",
			arguments: { filePath: "new.txt", content: "ok" },
		});
		expect(result.isError).not.toBe(true);
		expect(await readFile(join(cwd, "new.txt"), "utf8")).toBe("ok");
		expect(await readFile(bridgeOps, "utf8")).toContain(`authorize-path write ${join(cwd, "new.txt")}`);
	});

	test("write refuses an existing symlink that resolves outside workspace", async () => {
		const cwd = await workspace();
		const outsideDir = await workspace("omp-outside-");
		const outside = join(outsideDir, "outside.txt");
		await writeFile(outside, "original", "utf8");
		await symlink(outside, join(cwd, "escape-link"));
		const harness = new StandaloneHarness(cwd, createStandaloneTools());
		const result = await harness.invokeTool({
			callId: "symlink-write",
			toolName: "write",
			arguments: { filePath: "escape-link", content: "mutated" },
		});
		expect(result.isError).toBe(true);
		expect(await readFile(outside, "utf8")).toBe("original");
	});
});

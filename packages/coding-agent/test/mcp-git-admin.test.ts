import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalHarnessController } from "../src/harness/external-mode";
import { OhMyPiMcpServer } from "../src/mcp/server";
import { createStandaloneTools, StandaloneHarness } from "../src/mcp/standalone-harness";
import { createGitAdminTool } from "../src/mcp/standalone-kitcontrol-git-admin";

const tempDirs: string[] = [];
const savedBridge = process.env.OMP_KITCONTROL_GIT_ADMIN_BRIDGE;

afterEach(async () => {
	if (savedBridge === undefined) delete process.env.OMP_KITCONTROL_GIT_ADMIN_BRIDGE;
	else process.env.OMP_KITCONTROL_GIT_ADMIN_BRIDGE = savedBridge;
	await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "omp-git-admin-"));
	tempDirs.push(dir);
	return dir;
}

async function executable(body: string): Promise<string> {
	const dir = await tempDir();
	const path = join(dir, "bridge");
	await writeFile(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`, "utf8");
	await chmod(path, 0o755);
	return path;
}

function harness(): StandaloneHarness {
	return new StandaloneHarness("/home/coder/MCP", [createGitAdminTool()]);
}

describe("Git administration tool surface", () => {
	test("exposes only bounded stage/commit transaction fields", () => {
		const tool = createGitAdminTool();
		const parameters = tool.parameters as { properties?: Record<string, unknown>; required?: string[] };
		expect(tool.name).toBe("git_admin");
		expect(createStandaloneTools().some(candidate => candidate.name === "git_admin")).toBe(false);
		expect(tool.write).toBe(true);
		expect(tool.privileged).toBe(true);
		expect(tool.execution).not.toBe(true);
		expect(parameters.required).toEqual(["action", "cwd", "expected_head", "paths"]);
		expect(Object.keys(parameters.properties ?? {}).sort()).toEqual(
			["action", "cwd", "expected_head", "message", "paths"].sort(),
		);
		for (const forbidden of [
			"worker",
			"generation",
			"session_epoch",
			"task_run",
			"branch",
			"ref",
			"index",
			"git_dir",
			"common_dir",
			"command",
			"argv",
			"env",
			"config",
			"push",
			"remote",
		]) {
			expect(parameters.properties ?? {}).not.toHaveProperty(forbidden);
		}
	});

	test("shared/wildcard MCP cannot list or invoke machine-privileged git_admin", async () => {
		const tool = createGitAdminTool();
		const h = new StandaloneHarness("/tmp", [tool]);
		const policy = new ExternalHarnessController({
			enabled: true,
			allowedTools: ["*"],
			allowWrite: true,
			allowExecution: true,
			allowPrivileged: true,
		});
		expect(policy.authorizeInvocation(h.getTool("git_admin")!).allowed).toBe(false);
		const server = new OhMyPiMcpServer(h, { externalController: policy });
		const listed = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as any;
		expect(listed.result.tools).toHaveLength(0);
		const result = (await server.handleMessage({
			jsonrpc: "2.0", id: 2, method: "tools/call",
			params: {
				name: "git_admin",
				arguments: { action: "stage", cwd: "/tmp", expected_head: "1".repeat(40), paths: ["README.md"] },
			},
		})) as any;
		expect(result.error?.code).toBe("PERMISSION_DENIED");
	});

	test("even explicitly named git_admin needs the privileged and write gates", () => {
		const descriptor = new StandaloneHarness("/tmp", [createGitAdminTool()]).getTool("git_admin")!;
		for (const missing of ["privileged", "write"] as const) {
			const policy = new ExternalHarnessController({
				enabled: true,
				allowedTools: ["git_admin"],
				allowPrivileged: missing !== "privileged",
				allowWrite: missing !== "write",
				allowExecution: true,
			});
			expect(policy.authorizeInvocation(descriptor).allowed).toBe(false);
		}
		const privilegedOnly = new ExternalHarnessController({
			enabled: true,
			allowedTools: ["git_admin"],
			allowPrivileged: true,
			allowWrite: true,
		});
		expect(privilegedOnly.authorizeInvocation(descriptor).allowed).toBe(true);
	});

	test("invokes only the dedicated JSON bridge", async () => {
		const dir = await tempDir();
		const captured = join(dir, "request.json");
		const capturedPath = join(dir, "path.txt");
		process.env.OMP_KITCONTROL_GIT_ADMIN_BRIDGE = await executable(
			`cat > ${JSON.stringify(captured)}\nprintf '%s' "$PATH" > ${JSON.stringify(capturedPath)}\nprintf '%s' '{"ok":true,"action":"stage","head":"1111111111111111111111111111111111111111","staged_count":1}'`,
		);
		const result = await harness().invokeTool({
			callId: "stage",
			toolName: "git_admin",
			arguments: {
				action: "stage",
				cwd: "/tmp/wt",
				expected_head: "1111111111111111111111111111111111111111",
				paths: ["README.md"],
			},
		});
		expect(result.isError).not.toBe(true);
		expect(JSON.parse(await readFile(captured, "utf8"))).toEqual({
			action: "stage",
			cwd: "/tmp/wt",
			expected_head: "1111111111111111111111111111111111111111",
			paths: ["README.md"],
		});
		expect(await readFile(capturedPath, "utf8")).toBe("/usr/bin:/bin");
		expect(JSON.parse(result.content?.find(item => item.type === "text")?.text ?? "{}")).toEqual({
			ok: true,
			action: "stage",
			head: "1111111111111111111111111111111111111111",
			staged_count: 1,
		});
	});

	test("successful bridge responses require the exact action schema and reject internal fields", async () => {
		const invalidResponses = [
			'{"ok":true}',
			'{"ok":true,"action":"stage","head":"1111111111111111111111111111111111111111","staged_count":1,"git_common_dir":"/tmp/repo/.git"}',
			'{"ok":true,"action":"commit","old_head":"1111111111111111111111111111111111111111","new_head":"2222222222222222222222222222222222222222","committed_count":1}',
		];
		for (const payload of invalidResponses) {
			process.env.OMP_KITCONTROL_GIT_ADMIN_BRIDGE = await executable(`printf '%s' '${payload}'`);
			const result = await harness().invokeTool({
				callId: "schema",
				toolName: "git_admin",
				arguments: { action: "stage", cwd: "/tmp/wt", expected_head: "1".repeat(40), paths: ["README.md"] },
			});
			expect(result.isError).toBe(true);
		}
	});

	test("schema rejects arbitrary Git/admin fields before bridge invocation", async () => {
		const dir = await tempDir();
		const marker = join(dir, "called");
		process.env.OMP_KITCONTROL_GIT_ADMIN_BRIDGE = await executable(
			`touch ${JSON.stringify(marker)}\nprintf '%s' '{"ok":true}'`,
		);
		const result = await harness().invokeTool({
			callId: "bad",
			toolName: "git_admin",
			arguments: {
				action: "stage",
				cwd: "/tmp/wt",
				expected_head: "1".repeat(40),
				paths: ["README.md"],
				command: "git push",
			},
		});
		expect(result.isError).toBe(true);
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	test("missing nonzero malformed and oversized bridge responses fail closed", async () => {
		const requests = [
			"/definitely/missing/kit-git-admin",
			await executable("exit 2"),
			await executable("printf 'not-json'"),
			await executable("python3 - <<'PY'\nprint('x' * 70000)\nPY"),
		];
		for (const bridge of requests) {
			process.env.OMP_KITCONTROL_GIT_ADMIN_BRIDGE = bridge;
			const result = await harness().invokeTool({
				callId: "closed",
				toolName: "git_admin",
				arguments: { action: "stage", cwd: "/tmp/wt", expected_head: "1".repeat(40), paths: ["README.md"] },
			});
			expect(result.isError).toBe(true);
		}
	});
});

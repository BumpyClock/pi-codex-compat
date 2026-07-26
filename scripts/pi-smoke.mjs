#!/usr/bin/env node
/**
 * Pack this package, consumer-install the tarball with omit-dev, and load it under Pi.
 * Isolates PI_CODING_AGENT_DIR + HOME so live ~/.pi is never touched.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = mkdtempSync(path.join(tmpdir(), "pi-codex-smoke-"));
const packDir = path.join(workRoot, "pack");
const consumerDir = path.join(workRoot, "consumer");
const isolatedHome = path.join(workRoot, "home");
const isolatedAgentDir = path.join(workRoot, "agent");

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		...options,
	});
	if (result.status !== 0) {
		console.error(`Command failed: ${command} ${args.join(" ")}`);
		console.error(result.stdout);
		console.error(result.stderr);
		cleanup();
		process.exit(result.status ?? 1);
	}
	return result;
}

function cleanup() {
	rmSync(workRoot, { recursive: true, force: true });
}

try {
	// 1) pack
	run("mkdir", ["-p", packDir, consumerDir, isolatedHome, isolatedAgentDir]);
	run("npm", ["pack", "--pack-destination", packDir], { cwd: packageDir });
	const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
	if (tarballs.length !== 1) {
		throw new Error(
			`Expected one tarball in ${packDir}, found: ${tarballs.join(", ") || "(none)"}`,
		);
	}
	const tarballPath = path.join(packDir, tarballs[0]);

	// 2) consumer install from tarball (no devDeps; tolerate peer '*' via legacy-peer-deps)
	writeFileSync(
		path.join(consumerDir, "package.json"),
		`${JSON.stringify(
			{
				name: "pi-codex-compat-smoke-consumer",
				private: true,
				type: "module",
			},
			null,
			2,
		)}\n`,
	);
	run(
		"npm",
		["install", tarballPath, "--omit=dev", "--legacy-peer-deps", "--no-fund", "--no-audit"],
		{ cwd: consumerDir },
	);

	const installedPackage = path.join(consumerDir, "node_modules", "@bumpyclock", "pi-codex-compat");

	// 3) Pi against installed package with isolated HOME / agent dir
	const env = {
		...process.env,
		HOME: isolatedHome,
		PI_CODING_AGENT_DIR: isolatedAgentDir,
		// Avoid accidental writes under the real user profile on macOS too.
		USERPROFILE: isolatedHome,
	};
	const result = spawnSync(
		"pi",
		[
			"--no-session",
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"-e",
			installedPackage,
			"--list-models",
			"openai-codex",
		],
		{ encoding: "utf8", env, cwd: consumerDir },
	);

	if (result.status !== 0) {
		console.error(result.stdout);
		console.error(result.stderr);
		cleanup();
		process.exit(result.status ?? 1);
	}

	const out = (result.stdout ?? "").trim();
	console.log("pi smoke (packed consumer install) exit=0");
	console.log(out ? "model catalog listed after extension load" : "extension load completed");
	console.log(`tarball=${tarballs[0]}`);
	console.log(`installed=${installedPackage}`);
	cleanup();
	process.exit(0);
} catch (error) {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	cleanup();
	process.exit(1);
}

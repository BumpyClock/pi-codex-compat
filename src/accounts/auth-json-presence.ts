import {
	existsSync,
	mkdir,
	mkdirSync,
	readFileSync,
	realpath,
	realpathSync,
	rmdir,
	rmdirSync,
	stat,
	statSync,
	utimes,
	utimesSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { isRecord } from "../shared/is-record.js";
import { createLockfileFsAdapter } from "./storage.js";

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const LOCK_RETRIES = {
	retries: 10,
	factor: 2,
	minTimeout: 100,
	maxTimeout: 10_000,
	randomize: true,
} as const;
const LOCK_STALE_MS = 30_000;

// Match Pi 0.82.1 FileAuthStorageBackend lock protocol (proper-lockfile + realpath: false).
const LOCKFILE_FS_ADAPTER = createLockfileFsAdapter({
	mkdir,
	mkdirSync,
	realpath,
	realpathSync,
	rmdir,
	rmdirSync,
	stat,
	statSync,
	utimes,
	utimesSync,
});

export type AuthJsonOAuthPresence =
	| { status: "present" }
	| { status: "absent" }
	| { status: "unknown"; message: string };

export type AuthJsonPresenceReaderOptions = {
	authPath?: string;
	/** Test seam: defaults to proper-lockfile.lock with Pi lock options. */
	lock?: typeof lockfile.lock;
};

/**
 * Extension-owned read-only auth.json presence check for openai-codex OAuth.
 * Never creates or writes auth.json. Uses Pi 0.82.1 proper-lockfile lock protocol.
 */
export async function readOpenAICodexOAuthPresence(
	options: AuthJsonPresenceReaderOptions = {},
): Promise<AuthJsonOAuthPresence> {
	const authPath = options.authPath ?? join(getAgentDir(), "auth.json");
	if (!existsSync(authPath)) return { status: "absent" };

	let release: (() => Promise<void>) | undefined;
	let compromisedError: Error | undefined;
	const throwIfCompromised = () => {
		if (compromisedError) throw compromisedError;
	};
	const lock = options.lock ?? lockfile.lock.bind(lockfile);

	try {
		release = await lock(authPath, {
			fs: LOCKFILE_FS_ADAPTER,
			realpath: false,
			retries: LOCK_RETRIES,
			stale: LOCK_STALE_MS,
			onCompromised: (error) => {
				compromisedError = error instanceof Error ? error : new Error(String(error));
			},
		});
		throwIfCompromised();
		// Re-check after lock: another process may have removed the file.
		if (!existsSync(authPath)) return { status: "absent" };
		const raw = readFileSync(authPath, "utf8");
		throwIfCompromised();
		const result = inspectAuthJsonContents(raw);
		throwIfCompromised();
		return result;
	} catch (error) {
		return {
			status: "unknown",
			message: redactedPresenceError(error),
		};
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				// Compromised/removed lock is non-fatal for unlock; presence already fail-closed.
			}
		}
	}
}

export function inspectAuthJsonContents(raw: string): AuthJsonOAuthPresence {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return { status: "unknown", message: "auth.json is not valid JSON." };
	}
	if (!isRecord(parsed)) {
		return { status: "unknown", message: "auth.json must be a JSON object." };
	}
	if (!Object.hasOwn(parsed, OPENAI_CODEX_PROVIDER_ID)) return { status: "absent" };
	const credential = parsed[OPENAI_CODEX_PROVIDER_ID];
	if (!isRecord(credential)) {
		return { status: "unknown", message: "openai-codex credential entry is invalid." };
	}
	if (credential.type === "oauth") return { status: "present" };
	return { status: "absent" };
}

function redactedPresenceError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	// Never surface file contents or token-like blobs from lock/IO failures.
	if (/compromised/i.test(message)) return "auth.json lock was compromised.";
	if (/ELOCKED/i.test(message)) return "auth.json is locked by another process.";
	if (/ENOENT/i.test(message)) return "auth.json could not be read.";
	if (/EACCES|EPERM/i.test(message)) return "auth.json is not readable.";
	return "auth.json presence could not be determined.";
}

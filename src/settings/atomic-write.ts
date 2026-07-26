import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

let writeTail: Promise<void> = Promise.resolve();

export type WriteJsonAtomicOptions = {
	/** File mode. Defaults to 0o600 (user secrets). Project settings should pass 0o644. */
	mode?: number;
	/** Directory mode used only when creating a missing parent. Defaults to 0o700. */
	dirMode?: number;
	/**
	 * When true (default), chmod an existing parent directory to dirMode.
	 * Project `.pi` parents must pass false so shared project dirs are not forced to 0700.
	 */
	chmodParent?: boolean;
};

export async function writeJsonAtomic(
	filePath: string,
	value: unknown,
	options: WriteJsonAtomicOptions = {},
): Promise<void> {
	const mode = options.mode ?? 0o600;
	const dirMode = options.dirMode ?? 0o700;
	const chmodParent = options.chmodParent ?? true;
	const previous = writeTail;
	let release: () => void = () => undefined;
	writeTail = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		const parent = dirname(filePath);
		let parentExisted = false;
		try {
			parentExisted = statSync(parent).isDirectory();
		} catch {
			parentExisted = false;
		}
		mkdirSync(parent, { recursive: true, mode: dirMode });
		if (!parentExisted || chmodParent) {
			try {
				chmodSync(parent, dirMode);
			} catch {
				// Best-effort on platforms that ignore directory modes.
			}
		}
		const tempPath = `${filePath}.${randomUUID()}.tmp`;
		const body = `${JSON.stringify(value, null, 2)}\n`;
		try {
			writeFileSync(tempPath, body, { encoding: "utf8", flag: "wx", mode });
			try {
				chmodSync(tempPath, mode);
			} catch {
				// Best-effort.
			}
			renameSync(tempPath, filePath);
			try {
				chmodSync(filePath, mode);
			} catch {
				// Best-effort.
			}
		} finally {
			rmSync(tempPath, { force: true });
		}
	} finally {
		release();
	}
}

import {
	type AuthJsonOAuthPresence,
	type AuthJsonPresenceReaderOptions,
	readOpenAICodexOAuthPresence,
} from "./auth-json-presence.js";
import { redactTokenText } from "./runtime-auth.js";

export type NamedCodexAccountSelection =
	| { status: "selected"; accountName: string }
	| { status: "absent" }
	| { status: "unknown"; message: string };

/**
 * Redacted Codex subscription auth presence for the cost-safety policy.
 * Never includes token fields.
 */
export type RedactedCodexAuthState =
	| { kind: "absent" }
	| { kind: "default_present" }
	| { kind: "named_selected"; accountName: string }
	| { kind: "unknown"; message: string };

export type CodexAuthStateReader = {
	read(): Promise<RedactedCodexAuthState>;
};

export type CreateCodexAuthStateReaderOptions = AuthJsonPresenceReaderOptions & {
	readNamedSelection?: () => Promise<NamedCodexAccountSelection>;
	readDefaultPresence?: () => Promise<AuthJsonOAuthPresence>;
};

export function createCodexAuthStateReader(
	options: CreateCodexAuthStateReaderOptions = {},
): CodexAuthStateReader {
	const readNamed =
		options.readNamedSelection ??
		(async (): Promise<NamedCodexAccountSelection> => ({ status: "absent" }));
	const readDefault =
		options.readDefaultPresence ??
		(() => readOpenAICodexOAuthPresence({ authPath: options.authPath }));

	return {
		async read(): Promise<RedactedCodexAuthState> {
			// Always consult both stores. Any unknown wins (fail-closed), even if named is selected.
			const [named, defaultPresence] = await Promise.all([readNamed(), readDefault()]);

			const unknownMessages: string[] = [];
			if (named.status === "unknown") unknownMessages.push(named.message);
			if (defaultPresence.status === "unknown") unknownMessages.push(defaultPresence.message);
			if (unknownMessages.length > 0) {
				return {
					kind: "unknown",
					message: redactTokenText(unknownMessages.join("; ")),
				};
			}

			if (named.status === "selected") {
				return { kind: "named_selected", accountName: named.accountName };
			}
			if (defaultPresence.status === "present") return { kind: "default_present" };
			return { kind: "absent" };
		},
	};
}

export function isCodexAuthBlockingState(state: RedactedCodexAuthState): boolean {
	return state.kind !== "absent";
}

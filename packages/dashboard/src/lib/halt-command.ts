// The halt command (UI.md HALT flow; UI.md command params: `halt {}`). HaltDialog's confirm takes only a HaltCommand,
// and only this module makes one, so no other action can be wired to the dialog that is exempt from the fail-closed
// gates (Z05 round 6, ruling 28). Sending it (direct POST with retries, UI-T14) is the caller's `send`.

declare const HALT_COMMAND: unique symbol;

/** The command HALT sends: no parameters. */
export interface HaltCommandRequest { readonly type: 'halt'; readonly params: Readonly<Record<string, never>> }

/** A function that sends the halt command, and nothing else. */
export type HaltCommand = (() => void) & { readonly [HALT_COMMAND]: true };

/** The halt command, sent through `send` each time it runs. */
export function haltCommand(send: (request: HaltCommandRequest) => void): HaltCommand {
  return (() => send({ type: 'halt', params: {} })) as HaltCommand;
}

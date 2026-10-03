/**
 * Passkey step-up. Anything that moves money or changes where money can go
 * must pass this check first. The real check (a passkey prompt) arrives with
 * the signer work; until then the app wires `unavailableStepUp`, which always
 * refuses, so no request can be created by accident. `approvingStepUp` exists
 * for the sample-data page and tests only.
 */
export interface StepUpRequest {
  action: 'withdraw' | 'change-saved-wallet';
  /** What the owner is approving, for the passkey prompt. */
  summary: string;
}

export interface StepUp {
  verify(request: StepUpRequest): Promise<boolean>;
}

export const unavailableStepUp: StepUp = { verify: () => Promise.resolve(false) };

export const approvingStepUp: StepUp = { verify: () => Promise.resolve(true) };

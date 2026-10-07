/** One policy violation. `message` never contains a secret or the text that matched a secret pattern. */
export interface Finding { code: string; file: string; message: string }

export function finding(code: string, file: string, message: string): Finding {
  return { code, file, message };
}

/** Output streams of a command-line entry point (injected so tests can capture them). */
export interface Io { out(s: string): void; err(s: string): void }

export function formatFindings(findings: readonly Finding[]): string {
  return findings.map((f) => `policy: ${f.code} ${f.file}: ${f.message}`).join('\n');
}

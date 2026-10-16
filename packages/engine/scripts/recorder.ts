// The keyless M1 recorder's entry on the host (card Z10): logic.sh RECORDER_ENTRY, run by worker-start and worker-smoke
// with `--reconcile` or not. Everything it does is src/recorder-main/run.ts.
import { runRecorderProcess } from '../src/recorder-main/run.ts';

await runRecorderProcess();

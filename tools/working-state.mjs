import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where the gate works, and the one file in it that a clean keeps.
 *
 * Everything else under this directory is reproduced by running the gate again: the work trees,
 * the consumers it materializes, the traces, the logs and the summary are all output. The attempt
 * ledger is not. It is one line per run, and a recurring failure is counted by comparing its
 * occurrences across runs, so a clean that took the ledger would reset that count to zero with
 * nothing anywhere to rebuild it from.
 *
 * Both names are here because two commands decide against them, and a rename that reached only one
 * of them would have `clean` delete the ledger without saying anything.
 */
export const workingRoot = resolve(workspaceRoot, 'tmp');
export const attemptLedgerPath = resolve(workingRoot, 'verify-ledger.jsonl');

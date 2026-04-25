/**
 * MapReduce orchestration: launch + watch + aggregate.
 *
 * Pulled out of index.ts so the failure paths can be unit-tested without
 * spinning up a real terminal multiplexer or pi child process.
 *
 * Contract:
 *   - Launching is sequential. A launch failure is captured and reported as a
 *     per-track failure result; siblings that already launched keep running.
 *   - Watching is parallel. Per-track abort is wired to the parent signal.
 *   - The orchestrator never throws — every track produces a SubagentResult.
 */

export interface OrchestratorTrackInput {
  name: string;
  prompt: string;
  depth?: number;
}

export interface OrchestratorRunningSubagent {
  abortController?: AbortController;
}

export interface OrchestratorSubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
}

export interface OrchestratorProgress {
  done: number;
  total: number;
  results: OrchestratorSubagentResult[];
}

export interface OrchestratorDeps<R extends OrchestratorRunningSubagent> {
  launch(track: OrchestratorTrackInput, index: number): Promise<R>;
  watch(running: R, signal: AbortSignal, index: number): Promise<OrchestratorSubagentResult>;
  /** Optional hook for orchestrator-level state (e.g. widget refresh). */
  onLaunchPhaseDone?: () => void;
  /** Optional progress callback fired when each track finishes. */
  onProgress?: (progress: OrchestratorProgress) => void;
  /** Now() injection for tests. */
  now?: () => number;
}

/**
 * Run a mapreduce launch+watch cycle. Returns one result per track in the
 * same order as the inputs.
 *
 * If `launch(track)` throws, the failure is recorded and the orchestrator
 * keeps launching the remaining tracks. Tracks that already launched keep
 * running and are awaited normally.
 *
 * If the parent `signal` aborts, every started fork is signaled.
 */
export async function runMapReduce<R extends OrchestratorRunningSubagent>(
  tracks: OrchestratorTrackInput[],
  signal: AbortSignal | undefined,
  deps: OrchestratorDeps<R>,
): Promise<OrchestratorSubagentResult[]> {
  const now = deps.now ?? (() => Date.now());
  const startTime = now();

  type Slot =
    | { ok: true; running: R; index: number }
    | { ok: false; error: Error; track: OrchestratorTrackInput; index: number };

  const slots: Slot[] = [];

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    try {
      const running = await deps.launch(track, i);
      const watcherAbort = new AbortController();
      running.abortController = watcherAbort;
      if (signal) {
        if (signal.aborted) watcherAbort.abort();
        else signal.addEventListener("abort", () => watcherAbort.abort(), { once: true });
      }
      slots.push({ ok: true, running, index: i });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      slots.push({ ok: false, error, track, index: i });
    }
  }

  deps.onLaunchPhaseDone?.();

  const total = tracks.length;
  const resultsByIndex: Array<OrchestratorSubagentResult | undefined> = new Array(total);
  let done = 0;

  function recordDone(index: number, result: OrchestratorSubagentResult) {
    resultsByIndex[index] = result;
    done += 1;
    deps.onProgress?.({
      done,
      total,
      results: resultsByIndex.filter((r): r is OrchestratorSubagentResult => !!r),
    });
  }

  const tasks = slots.map(async (slot) => {
    if (!slot.ok) {
      const elapsed = Math.floor((now() - startTime) / 1000);
      const result: OrchestratorSubagentResult = {
        name: slot.track.name,
        task: slot.track.prompt,
        summary: `Failed to launch fork: ${slot.error.message}`,
        exitCode: 1,
        elapsed,
        error: slot.error.message,
      };
      recordDone(slot.index, result);
      return result;
    }

    let result: OrchestratorSubagentResult;
    try {
      result = await deps.watch(slot.running, slot.running.abortController!.signal, slot.index);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const elapsed = Math.floor((now() - startTime) / 1000);
      result = {
        name: tracks[slot.index].name,
        task: tracks[slot.index].prompt,
        summary: `Watcher error: ${error.message}`,
        exitCode: 1,
        elapsed,
        error: error.message,
      };
    }
    recordDone(slot.index, result);
    return result;
  });

  const results = await Promise.all(tasks);
  // Re-key by index in case of any out-of-order resolution. Slots are pushed
  // in track order so this is identity, but we go through resultsByIndex to
  // guarantee positional output.
  return resultsByIndex.map((r, i) => r ?? results[i]);
}

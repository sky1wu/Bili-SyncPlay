/**
 * How often a repeating diagnosis may be printed.
 *
 * A dependency outage is ONE failure however many times it is hit, so the line
 * that describes it is worth printing once a minute and no more. #268 built
 * this for the event store's append failures and #271 needed the same thing for
 * the admin session store, which is the point at which this repo extracts
 * rather than writes the second copy — the four hand-rolled retry/timeout
 * copies in #242 produced six duplicate review findings.
 *
 * Two rules that are not obvious from the shape, both bought with review rounds:
 *
 * - **The throttle must itself be bounded.** Diagnoses come from implementations
 *   outside the caller and are not necessarily a finite vocabulary, so past
 *   `maxTrackedDiagnoses` new ones share one overflow bucket instead of growing
 *   a map forever.
 * - **The overflow bucket's cooldown outranks a freed slot.** A tracked slot can
 *   expire while the bucket is still cooling down; promoting an overflow
 *   diagnosis into that slot would print it twice inside one interval (#268
 *   review).
 *
 * What it deliberately does NOT do is count. The line answers "what is broken";
 * only a counter answers "how much", and throttling the line without one leaves
 * an operator unable to tell thirty failures from thirty million. Every caller
 * counts unconditionally, before asking this (#266).
 */

export type DiagnosisThrottle = {
  /**
   * Whether `diagnosis` may be reported now. Calling this RESERVES the interval
   * when it answers true, so ask once per report and act on the answer.
   */
  allow: (diagnosis: string) => boolean;
};

export function createDiagnosisThrottle(options: {
  intervalMs: number;
  maxTrackedDiagnoses: number;
  /** Injectable so tests do not pay the interval in wall-clock time. */
  now?: () => number;
}): DiagnosisThrottle {
  const { intervalMs, maxTrackedDiagnoses } = options;
  const now = options.now ?? Date.now;
  const lastReportedAtByDiagnosis = new Map<string, number>();
  let lastUntrackedReportAt: number | undefined;

  return {
    allow(diagnosis) {
      const at = now();

      for (const [tracked, lastReportedAt] of lastReportedAtByDiagnosis) {
        if (at - lastReportedAt >= intervalMs) {
          lastReportedAtByDiagnosis.delete(tracked);
        }
      }

      if (lastReportedAtByDiagnosis.has(diagnosis)) {
        return false;
      }

      if (
        lastUntrackedReportAt !== undefined &&
        at - lastUntrackedReportAt < intervalMs
      ) {
        return false;
      }

      if (lastReportedAtByDiagnosis.size >= maxTrackedDiagnoses) {
        lastUntrackedReportAt = at;
      } else {
        lastReportedAtByDiagnosis.set(diagnosis, at);
      }
      return true;
    },
  };
}

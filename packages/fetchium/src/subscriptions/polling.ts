import type { MutationEvent } from '../types.js';
import type { QueryContext } from '../query-types.js';

const MIN_INTERVAL = 100;

// A tick this late means timers were frozen in the background, so every poll is overdue.
const LATE_TICK_THRESHOLD = 1000;

export interface PollConfig {
  interval: number;
  /** Overrides `QueryClientConfig.pollResumeJitterMs` for this poll. */
  resumeJitterMs?: number;
}

function clampInterval(interval: number): number {
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL) {
    if (IS_DEV && (Number.isNaN(interval) || interval < 0)) {
      console.warn(`poll: invalid interval ${interval}, clamping to ${MIN_INTERVAL}ms`);
    }
    return MIN_INTERVAL;
  }
  return interval;
}

export function poll(config: PollConfig): (this: any, onEvent: (event: MutationEvent) => void) => () => void {
  const interval = clampInterval(config.interval);

  return function subscribe(this: any, _onEvent: (event: MutationEvent) => void): () => void {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    /** Kept while the timer is stopped, so resuming knows what is overdue. */
    let dueAt = Date.now() + interval;

    const refetch = this.refetch as () => Promise<unknown>;
    const queryContext = this.context as QueryContext | undefined;
    const activity = queryContext?.activity;
    const jitterWindow = config.resumeJitterMs ?? queryContext?.pollResumeJitterMs ?? 0;

    const isAppActive = (): boolean => activity === undefined || activity.isActive();

    const schedule = (delay: number): void => {
      clearTimeout(timer);
      dueAt = Date.now() + delay;
      timer = setTimeout(tick, delay);
    };

    const scheduleOverdue = (): void => {
      schedule(jitterWindow > 0 ? Math.floor(Math.random() * jitterWindow) : 0);
    };

    const stopTimer = (): void => {
      clearTimeout(timer);
      timer = undefined;
    };

    const tick = async (): Promise<void> => {
      timer = undefined;
      if (!active) return;
      // Stay overdue. The activity listener reschedules on resume.
      if (!isAppActive()) return;
      if (jitterWindow > 0 && Date.now() - dueAt > LATE_TICK_THRESHOLD) {
        scheduleOverdue();
        return;
      }

      inFlight = true;
      try {
        await refetch();
      } catch {
        // Keep polling after errors
      }
      inFlight = false;

      if (!active) return;
      if (isAppActive()) {
        schedule(interval);
      } else {
        dueAt = Date.now() + interval;
      }
    };

    const unsubscribeActivity = activity?.subscribe(() => {
      if (!active) return;
      if (!activity.isActive()) {
        stopTimer();
        return;
      }
      // An in-flight refetch schedules the next tick itself.
      if (timer !== undefined || inFlight) return;
      const remaining = dueAt - Date.now();
      if (remaining > 0) {
        schedule(remaining);
      } else {
        scheduleOverdue();
      }
    });

    if (isAppActive()) {
      schedule(interval);
    }

    return () => {
      active = false;
      stopTimer();
      unsubscribeActivity?.();
    };
  };
}

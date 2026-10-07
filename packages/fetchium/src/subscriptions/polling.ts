import type { MutationEvent } from '../types.js';
import type { ActivitySource, QueryContext } from '../query-types.js';

const MIN_INTERVAL = 100;

/**
 * A tick this late means its timer was frozen (React Native suspends JS timers
 * in the background), so every other poll is overdue too and the tick gets
 * jittered. A busy JS thread delays timers by far less.
 */
const LATE_TICK_THRESHOLD = 1000;

export interface PollConfig {
  interval: number;
  /**
   * Overrides `QueryClientConfig.pollResumeJitterMs` for this poll: the window
   * an overdue tick is spread across when the app becomes active again.
   */
  resumeJitterMs?: number;
}

/** Contexts whose invalid `activity` value was already reported. */
const warnedActivity = new WeakSet<object>();

/**
 * The context's `activity`, if it is an `ActivitySource`. Custom config keys
 * pass through to the context, so an app may already use this name for its
 * own value. Anything without `isActive` and `subscribe` functions is ignored,
 * with a warning in development.
 */
function activitySource(queryContext: QueryContext | undefined): ActivitySource | undefined {
  const activity = (queryContext as Record<string, unknown> | undefined)?.activity;
  if (activity === undefined || activity === null) return undefined;
  const candidate = activity as Partial<ActivitySource>;
  if (typeof candidate.isActive === 'function' && typeof candidate.subscribe === 'function') {
    return activity as ActivitySource;
  }
  if (IS_DEV && !warnedActivity.has(queryContext!)) {
    warnedActivity.add(queryContext!);
    queryContext!.log?.warn?.(
      'poll: the `activity` context value is not an ActivitySource ({ isActive(), subscribe(listener) }); polls ignore it.',
    );
  }
  return undefined;
}

/** Milliseconds: a finite positive number, else 0. */
function finitePositive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
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
    /** When the next tick is due. Kept while the timer is stopped, so resuming knows what is overdue. */
    let dueAt = Date.now() + interval;

    const refetch = this.refetch as () => Promise<unknown>;
    const queryContext = this.context as QueryContext | undefined;
    const activity = activitySource(queryContext);
    const jitterWindow = finitePositive(
      config.resumeJitterMs ?? (queryContext as Record<string, unknown> | undefined)?.pollResumeJitterMs,
    );

    const isAppActive = (): boolean => activity === undefined || activity.isActive();

    const schedule = (delay: number): void => {
      clearTimeout(timer);
      dueAt = Date.now() + delay;
      timer = setTimeout(tick, delay);
    };

    /** Reschedules an overdue tick at a random point within the jitter window. */
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
      // Leave the tick overdue. The activity listener reschedules it on resume.
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
      // A refetch in flight schedules the next tick itself when it settles.
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

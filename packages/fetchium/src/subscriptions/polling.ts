import type { MutationEvent } from '../types.js';

const MIN_INTERVAL = 100;

export interface PollConfig {
  interval: number;
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

type PollSubscribe = (this: any, onEvent: (event: MutationEvent) => void) => () => void;

// Memoize so re-evaluating `getConfig()` with the same interval returns a
// stable reference. Without this, the canonical use case
// (`subscribe: poll({ interval: this.response?.ok ? 100 : 5000 })`) would
// tear down and rebuild the subscriber on every fetch in steady state.
const pollCache = new Map<number, PollSubscribe>();

export function poll(config: PollConfig): PollSubscribe {
  const interval = clampInterval(config.interval);

  let subscribe = pollCache.get(interval);
  if (subscribe !== undefined) return subscribe;

  subscribe = function (this: any, _onEvent: (event: MutationEvent) => void): () => void {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refetch = this.refetch as () => Promise<unknown>;

    const tick = async () => {
      if (!active) return;
      try {
        await refetch();
      } catch {
        // Keep polling after errors
      }
      if (active) {
        timer = setTimeout(tick, interval);
      }
    };

    timer = setTimeout(tick, interval);

    return () => {
      active = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
  };

  pollCache.set(interval, subscribe);
  return subscribe;
}

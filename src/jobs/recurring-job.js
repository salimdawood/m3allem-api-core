import { logger } from '../config/logger.js';

export function startRecurringJob({ name, intervalMs, run, log = logger }) {
  let stopped = false, timer, inFlight;
  const tick = () => {
    if (stopped || inFlight) return;
    inFlight = Promise.resolve().then(() => run({ shouldStop: () => stopped }))
      .catch((error) => log.error({ code: error.code ?? 'JOB_FAILED', job: name }, 'Background job failed'))
      .finally(() => {
        inFlight = undefined;
        if (!stopped) { timer = setTimeout(tick, intervalMs); timer.unref?.(); }
      });
  };
  tick();
  return async () => { stopped = true; clearTimeout(timer); await inFlight; };
}

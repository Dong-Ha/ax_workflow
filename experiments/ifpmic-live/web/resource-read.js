// Bounded authenticated GET polling shared by stored read panels.
export function createResourceReadController({ read, parse, isPending, onChange, onDenied = () => {}, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout }) {
  let jobId = null;
  let generation = 0;
  let active = null;
  let timer = null;
  let confirmed = null;

  function stop() {
    generation += 1;
    if (timer !== null) cancel(timer);
    timer = null;
    active?.abort();
    active = null;
  }
  function clear() {
    stop();
    jobId = null;
    confirmed = null;
    onChange({ phase: 'empty', value: null });
  }
  async function refresh() {
    if (!jobId) return;
    stop();
    const current = generation;
    const selected = jobId;
    const deadline = now() + 60_000;
    let index = 0;
    const poll = async () => {
      if (current !== generation) return;
      if (now() >= deadline) {
        onChange({ phase: 'timedout', value: confirmed });
        return;
      }
      timer = null;
      active = new AbortController();
      const deadlineTimer = schedule(() => {
        if (current !== generation) return;
        stop();
        onChange({ phase: 'timedout', value: confirmed });
      }, deadline - now());
      onChange({ phase: 'loading', value: confirmed });
      try {
        const data = await read(selected, active.signal);
        if (current !== generation) return;
        if (now() >= deadline) { onChange({ phase: 'timedout', value: confirmed }); return; }
        confirmed = parse(data, selected);
        onChange({ phase: 'ready', value: confirmed });
        if (isPending(confirmed)) {
          const delay = [1000, 2000, 4000, 5000][Math.min(index++, 3)];
          timer = schedule(poll, Math.max(0, Math.min(delay, deadline - now())));
        }
      } catch (error) {
        if (current !== generation) return;
        const denied = error.status === 401 || error.status === 403;
        if (denied) confirmed = null;
        onChange({ phase: 'error', value: confirmed });
        if (denied) onDenied(error.status);
      } finally {
        cancel(deadlineTimer);
        if (current === generation) active = null;
      }
    };
    return poll();
  }
  return {
    clear, refresh,
    select(selected) { clear(); jobId = selected; return refresh(); },
  };
}

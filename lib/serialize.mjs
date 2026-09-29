// Wrap a background task so a run that starts while the previous one is still
// going is skipped instead of overlapping it. setInterval does not wait for the
// task it fires, so a slow run would otherwise be joined by the next one.
export function serialized(task) {
  let running = false;
  return async (...args) => {
    if (running) return;
    running = true;
    try {
      return await task(...args);
    } finally {
      running = false;
    }
  };
}

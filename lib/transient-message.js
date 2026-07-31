export function createTransientMessageScheduler({
  duration = 5_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const timers = new WeakMap();
  return (element) => {
    clearTimer(timers.get(element));
    if (!element.textContent.trim()) return;
    timers.set(element, setTimer(() => {
      element.textContent = "";
      delete element.dataset.tone;
      timers.delete(element);
    }, duration));
  };
}

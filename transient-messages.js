import { createTransientMessageScheduler } from "./lib/transient-message.js?v=20260801";

const scheduleClear = createTransientMessageScheduler();

const observer = new MutationObserver((mutations) => {
  const messages = new Set(mutations.map(({ target }) => target.nodeType === Node.TEXT_NODE ? target.parentElement : target)
    .map((target) => target?.closest?.(".message"))
    .filter(Boolean));
  messages.forEach(scheduleClear);
});

document.querySelectorAll(".message").forEach((element) => {
  observer.observe(element, { childList: true, characterData: true, subtree: true });
  scheduleClear(element);
});

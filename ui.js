const SWIPE_CLOSE_PX = 88;

export function openModal(modal) {
  if (!modal) return;
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add("is-open"));
}

export function closeModal(modal) {
  if (!modal) return;
  modal.classList.remove("is-open");
  const dialog = modal.querySelector(".wallet-dialog");
  if (dialog) {
    dialog.style.transform = "";
    dialog.style.transition = "";
  }
  window.setTimeout(() => {
    if (!modal.classList.contains("is-open")) modal.hidden = true;
  }, 240);
}

export function bindSheetDismiss(modal, onClose) {
  const dialog = modal.querySelector(".wallet-dialog");
  const handle = modal.querySelector(".sheet-handle");
  if (!dialog) return;

  let startY = 0;
  let currentY = 0;
  let dragging = false;
  let startFromHandle = false;

  const canDrag = () => window.matchMedia("(max-width: 760px)").matches;

  const reset = (close) => {
    dragging = false;
    startFromHandle = false;
    dialog.style.transition = "transform .24s cubic-bezier(.22, .8, .24, 1)";
    if (close) {
      dialog.style.transform = "translateY(110%)";
      onClose();
    } else {
      dialog.style.transform = "";
    }
    currentY = 0;
  };

  const onPointerDown = (event) => {
    if (!canDrag() || event.pointerType === "mouse") return;
    const target = event.target;
    const scrollable = target.closest(".history-list, .fairness-copy, .wallet-list");
    if (scrollable && scrollable.scrollTop > 0 && target !== handle) return;
    startFromHandle = handle?.contains(target) || target === handle || event.clientY - dialog.getBoundingClientRect().top < 56;
    if (!startFromHandle && scrollable) return;
    dragging = true;
    startY = event.clientY;
    currentY = 0;
    dialog.style.transition = "none";
    dialog.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event) => {
    if (!dragging) return;
    currentY = Math.max(0, event.clientY - startY);
    dialog.style.transform = `translateY(${currentY}px)`;
  };

  const onPointerUp = () => {
    if (!dragging) return;
    reset(currentY > SWIPE_CLOSE_PX);
  };

  dialog.addEventListener("pointerdown", onPointerDown);
  dialog.addEventListener("pointermove", onPointerMove);
  dialog.addEventListener("pointerup", onPointerUp);
  dialog.addEventListener("pointercancel", onPointerUp);

  modal.addEventListener("click", (event) => {
    if (event.target === modal) onClose();
  });
}

export async function copyText(value, button) {
  try {
    await navigator.clipboard.writeText(value);
    const previous = button.textContent;
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.textContent = previous;
    }, 1200);
  } catch {}
}

export function paperPlaneSvg() {
  return `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path fill="currentColor" d="M3.04 11.16 20.1 3.64c.82-.36 1.6.48 1.2 1.3L14.7 21.1c-.4.86-1.64.78-1.92-.12l-1.86-6.08-6.08-1.86c-.9-.28-.98-1.52-.12-1.92Zm5.2 1.66 3.78 1.16c.22.07.4.24.46.47l1.1 3.6 4.86-11.18-10.2 5.95Z"/>
  </svg>`;
}

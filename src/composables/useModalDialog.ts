import { nextTick, onBeforeUnmount, useTemplateRef } from 'vue';

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** Focus, keyboard and scroll lifecycle for a local modal dialog. */
export function useModalDialog(refName: string) {
  const dialogRef = useTemplateRef<HTMLElement>(refName);
  let trigger: HTMLElement | null = null;
  let bodyOverflow = '';
  let scrollLocked = false;
  let dismiss: (() => void) | null = null;

  function onDocumentKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    dismiss?.();
  }

  function lockScroll() {
    if (scrollLocked) return;
    bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    scrollLocked = true;
  }

  function unlockScroll() {
    if (!scrollLocked) return;
    document.body.style.overflow = bodyOverflow;
    scrollLocked = false;
  }

  function focusInitial() {
    void nextTick(() => {
      const dialog = dialogRef.value;
      const initial = dialog?.querySelector<HTMLElement>('[data-dialog-initial]');
      (initial || dialog)?.focus();
    });
  }

  function open(onDismiss: () => void) {
    trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dismiss = onDismiss;
    document.addEventListener('keydown', onDocumentKeydown, true);
    lockScroll();
    focusInitial();
  }

  function close() {
    document.removeEventListener('keydown', onDocumentKeydown, true);
    dismiss = null;
    unlockScroll();
    const returnTarget = trigger;
    trigger = null;
    returnTarget?.focus();
  }

  function onKeydown(event: KeyboardEvent, dismiss: () => void) {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(dialogRef.value?.querySelectorAll<HTMLElement>(focusableSelector) || []);
    if (!focusable.length) {
      event.preventDefault();
      dialogRef.value?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onDocumentKeydown, true);
    unlockScroll();
  });
  return { dialogRef, open, close, focusInitial, onKeydown };
}

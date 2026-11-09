// Only write the text supplied by the user action. Never inspect the clipboard.
function copySelection(text, document) {
  if (!document?.body || typeof document.execCommand !== 'function') return false;
  const previousFocus = document.activeElement;
  let selection, ranges = [], inputSelection, field;
  try {
    selection = document.getSelection?.();
    for (let i = 0; i < (selection?.rangeCount || 0); i++) ranges.push(selection.getRangeAt(i).cloneRange());
    if (typeof previousFocus?.selectionStart === 'number') {
      inputSelection = [previousFocus.selectionStart, previousFocus.selectionEnd, previousFocus.selectionDirection];
    }
    field = document.createElement('textarea');
    field.value = text;
    field.readOnly = true;
    field.tabIndex = -1;
    field.setAttribute('aria-label', 'Копируемый текст');
    // Keep it selectable without scrolling the page or showing an extra field.
    field.style.cssText = 'position:fixed;inset:0 auto auto 0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none';
    document.body.append(field);
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length);
    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    field?.remove();
    try {
      previousFocus?.focus({ preventScroll: true });
      if (inputSelection) previousFocus.setSelectionRange(...inputSelection);
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    } catch { /* The previously focused element may have been removed. */ }
  }
}

// A writer serializes its operations: a slow older write cannot overwrite a newer one.
// The first operation still starts synchronously inside the user's click handler.
export function createClipboardWriter(environment = globalThis) {
  let pending = null;
  return function writeText(text, isCurrent = () => true) {
    async function write() {
      if (typeof text !== 'string' || !isCurrent()) return false;
      try {
        const clipboard = environment.navigator?.clipboard;
        if (environment.isSecureContext && typeof clipboard?.writeText === 'function') {
          const result = clipboard.writeText(text);
          if (result && typeof result.then === 'function') {
            await result;
            return true;
          }
        }
      } catch { /* Local files or browser permissions may require the legacy path. */ }
      // Do not select stale text or steal focus after a prompt switch.
      if (!isCurrent()) return false;
      return copySelection(text, environment.document);
    }
    const operation = pending ? pending.then(write) : write();
    pending = operation;
    void operation.then(() => { if (pending === operation) pending = null; });
    return operation;
  };
}

export const writeClipboardText = createClipboardWriter();

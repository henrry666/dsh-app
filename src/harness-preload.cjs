const { ipcRenderer } = require('electron');

function visible(element) {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && !element.disabled;
}

function composer() {
  const textareas = [...document.querySelectorAll('textarea')].filter(visible);
  if (textareas.length) return textareas.at(-1);
  const editables = [...document.querySelectorAll('[contenteditable="true"]')].filter(visible);
  return editables.at(-1) || null;
}

function setText(element, addition) {
  element.focus();
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    const prefix = element.value && !element.value.endsWith('\n') ? '\n' : '';
    if (setter) setter.call(element, `${element.value}${prefix}${addition}`);
    else element.value = `${element.value}${prefix}${addition}`;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: addition }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.setSelectionRange(element.value.length, element.value.length);
    return;
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand('insertText', false, `${element.textContent ? '\n' : ''}${addition}`);
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: addition }));
}

function withComposer(callback, attempts = 20) {
  const target = composer();
  if (target) callback(target);
  else if (attempts > 0) setTimeout(() => withComposer(callback, attempts - 1), 100);
}

ipcRenderer.on('desktop:focus-composer', () => withComposer(element => element.focus()));
ipcRenderer.on('desktop:insert-text', (_event, value) => {
  if (typeof value === 'string' && value.trim()) withComposer(element => setText(element, value.trim()));
});

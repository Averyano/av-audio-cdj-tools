// DOM helpers shared by every view. Text always goes in through textContent/append,
// never innerHTML, so file names and tags can't inject markup.

export const $ = (sel) => document.querySelector(sel);

export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

/** Opens a <dialog> as a modal; if another one is open, once that one has closed. */
export function showDialog(d) {
  const open = document.querySelector('dialog[open]');
  if (open && open !== d) open.addEventListener('close', () => showDialog(d), { once: true });
  else if (!d.open) d.showModal();
}

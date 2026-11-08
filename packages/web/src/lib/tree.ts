/**
 * Keyboard support for a `role="tree"` element (ARIA tree view pattern): one tab stop, on the
 * focused row, else the selected row, else the first; Arrow Up/Down, Home and End move between
 * the visible rows. Rows handle Enter/Space (select) and Arrow Right/Left (expand/collapse).
 */
export function treeKeyboard(node: HTMLElement) {
  const items = () => [...node.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const normalize = () => {
    const all = items();
    const current =
      all.find((i) => i === document.activeElement) ??
      all.find((i) => i.getAttribute('aria-selected') === 'true') ??
      all[0];
    for (const i of all) i.tabIndex = i === current ? 0 : -1;
  };
  const keydown = (event: KeyboardEvent) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    const target =
      event.key === 'ArrowDown'
        ? Math.min(all.length - 1, at + 1)
        : event.key === 'ArrowUp'
          ? Math.max(0, at - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? all.length - 1
              : -1;
    if (target === -1) return;
    event.preventDefault();
    for (const i of all) i.tabIndex = -1;
    const next = all[target] as HTMLElement;
    next.tabIndex = 0;
    next.focus();
  };
  // Rows come and go as schemas expand and selections change.
  const observer = new MutationObserver(normalize);
  observer.observe(node, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-selected'],
  });
  node.addEventListener('keydown', keydown);
  node.addEventListener('focusin', normalize);
  normalize();
  return {
    destroy() {
      observer.disconnect();
      node.removeEventListener('keydown', keydown);
      node.removeEventListener('focusin', normalize);
    },
  };
}

/** A small path router: the server falls back to index.html for every browser route. */
export const route = $state({ path: typeof location === 'undefined' ? '/' : location.pathname });

export function navigate(path: string, replace = false): void {
  if (path === route.path) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  route.path = path;
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    route.path = location.pathname;
  });
}

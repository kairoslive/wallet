import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/** Minimal hash router: routes look like "#/send?network=eth". */
export interface Route {
  path: string;
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path: path || '/', query: new URLSearchParams(qs) };
}

const RouteContext = createContext<Route>(parse());

export function RouterProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onHash = () => setRoute(parse());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return <RouteContext.Provider value={route}>{children}</RouteContext.Provider>;
}

export function useRoute(): Route {
  return useContext(RouteContext);
}

/** Number of in-app navigations we can safely undo with history.back(). */
let depth = 0;

export function navigate(path: string, query?: Record<string, string | undefined>, replace = false) {
  const qs = query
    ? new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined)).toString()
    : '';
  const hash = `#${path}${qs ? `?${qs}` : ''}`;
  if (replace) window.location.replace(hash);
  else {
    depth++;
    window.location.hash = hash;
  }
}

export function back(fallback = '/') {
  if (depth > 0) {
    depth--;
    window.history.back();
  } else navigate(fallback, undefined, true);
}

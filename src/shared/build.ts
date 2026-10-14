declare const __BUILD_ID__: string | undefined;

/** Unique per build; lets the UI notice a background worker still running an older build. */
export const BUILD_ID: string = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';

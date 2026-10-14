/** Wallet logo as an SVG data URI (used by EIP-6963 and wallet-standard announcements). */
export const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#111827"/><circle cx="52" cy="64" r="26" fill="#3B82F6"/><circle cx="76" cy="64" r="26" fill="#A78BFA" fill-opacity=".9"/></svg>';

export const ICON_DATA_URI = `data:image/svg+xml;base64,${btoa(ICON_SVG)}` as `data:image/svg+xml;base64,${string}`;

export const WALLET_NAME = 'Duo Wallet';

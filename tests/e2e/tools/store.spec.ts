import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { test, expect, onboardWithMnemonic } from '../fixtures';

/**
 * Chrome Web Store images (store/): five 1280×800 screenshots, the 440×280 small promo tile and the
 * 1400×560 marquee, built from the popup captures in docs/screenshots. The prediction screens are
 * captured fresh from live Kairos market data (read-only; nothing is set up or traded).
 * Run with `pnpm store-assets` (after `pnpm screenshots` for the wallet screens).
 */
const SHOTS = resolve('docs/screenshots');
const OUT = resolve('store');

const dataUri = (path: string, type: string) => `data:${type};base64,${readFileSync(path).toString('base64')}`;
const FONT = dataUri(resolve('node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2'), 'font/woff2');
const ICON = dataUri(resolve('public/icons/128.png'), 'image/png');
const shot = (name: string) => dataUri(`${SHOTS}/${name}.png`, 'image/png');

// Same palette as the icon: deep ink with the blue and violet circles.
const CSS = `
@font-face { font-family: Manrope; src: url(${FONT}) format('woff2'); font-weight: 200 800; }
* { box-sizing: border-box; margin: 0; }
body { font-family: Manrope, sans-serif; background: #111827; color: #f4f6f9; overflow: hidden; }
.frame { position: relative; overflow: hidden; display: flex; align-items: center; }
.glow { position: absolute; border-radius: 50%; filter: blur(90px); opacity: .45; }
.glow.a { background: #3b82f6; } .glow.b { background: #a78bfa; }
.popup { position: relative; border-radius: 18px; overflow: hidden; box-shadow: 0 30px 80px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.08); background: #fff; }
.popup img { display: block; width: 100%; }
h1 { font-weight: 750; letter-spacing: -0.025em; line-height: 1.08; }
p { color: #aab3c5; line-height: 1.45; font-weight: 500; }
.brand { display: flex; align-items: center; gap: 12px; font-weight: 700; font-size: 20px; color: #fff; }
.brand img { border-radius: 10px; }
`;

const SCREENS = [
  {
    file: 'home',
    title: 'Ethereum, EVM chains and Solana in one wallet',
    body: 'One recovery phrase gives every account an EVM and a Solana address, with balances across all your networks.',
  },
  {
    file: 'send-review',
    title: 'Know exactly what you send',
    body: 'Every transfer shows the amount, network fee and recipient before you sign. Your keys never leave this device.',
  },
  {
    file: 'bridge',
    title: 'Swap and bridge in a few taps',
    body: 'Same-chain swaps and cross-chain bridges, with approvals for the exact amount only.',
  },
  {
    file: 'predict-market',
    title: 'Trade prediction markets',
    body: 'Browse live Polymarket markets, read the order book and buy or sell outcomes from your wallet.',
  },
  {
    file: 'connect',
    title: 'Connect to apps on either chain',
    body: 'Works with Ethereum and Solana apps. You approve each site, and each request, yourself.',
  },
];

test('chrome web store images', async ({ openWallet }) => {
  test.setTimeout(180_000);
  mkdirSync(OUT, { recursive: true });

  // Fresh prediction screens from live market data.
  const wallet = await openWallet('/onboarding');
  await onboardWithMnemonic(wallet);
  await wallet.getByRole('button', { name: 'Predict' }).click();
  const list = wallet.getByTestId('market-list').locator('.list-item');
  await expect(list.first()).toBeVisible({ timeout: 30_000 });
  await expect(wallet.locator('img.market-thumb').first()).toBeVisible();
  await wallet.waitForTimeout(1500);
  await wallet.screenshot({ path: `${SHOTS}/predict.png` });
  await list.first().click();
  if (wallet.url().includes('/predict/event')) await wallet.locator('.list-item').first().click();
  await expect(wallet.getByTestId('market-title')).toBeVisible({ timeout: 30_000 });
  await expect(wallet.locator('.price-chart path').first()).toBeVisible({ timeout: 30_000 });
  await wallet.waitForTimeout(2000);
  await wallet.screenshot({ path: `${SHOTS}/predict-market.png` });

  for (const s of SCREENS) expect(existsSync(`${SHOTS}/${s.file}.png`), `${s.file}.png (run pnpm screenshots)`).toBe(true);

  // Layouts render at 1× so each image is exactly the pixel size the store asks for.
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (w: number, h: number, html: string, path: string) => {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(
      `<!doctype html><style>${CSS}</style><div class="frame" style="width:${w}px;height:${h}px">${html}</div>`,
    );
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(200);
    await page.screenshot({ path, clip: { x: 0, y: 0, width: w, height: h } });
  };

  // 1280×800 screenshots: copy on the left, the popup on the right.
  for (const [i, s] of SCREENS.entries()) {
    await render(
      1280,
      800,
      `<div class="glow a" style="width:520px;height:520px;right:120px;top:-120px"></div>
       <div class="glow b" style="width:460px;height:460px;right:-60px;bottom:-160px"></div>
       <div style="flex:1;padding:0 40px 0 96px">
         <div class="brand"><img src="${ICON}" width="40" height="40" />Duo Wallet</div>
         <h1 style="font-size:54px;margin:36px 0 22px;max-width:560px">${s.title}</h1>
         <p style="font-size:22px;max-width:520px">${s.body}</p>
       </div>
       <div class="popup" style="width:396px;margin-right:120px"><img src="${shot(s.file)}" /></div>`,
      `${OUT}/screenshot-${i + 1}-${s.file}.png`,
    );
  }

  // 440×280 small promo tile.
  await render(
    440,
    280,
    `<div class="glow a" style="width:260px;height:260px;left:-80px;top:-90px"></div>
     <div class="glow b" style="width:240px;height:240px;right:-70px;bottom:-110px"></div>
     <div style="position:relative;padding:0 36px">
       <img src="${ICON}" width="64" height="64" style="border-radius:16px;display:block" />
       <h1 style="font-size:34px;margin:18px 0 8px">Duo Wallet</h1>
       <p style="font-size:16px;color:#c9d1e1">Ethereum, EVM chains and Solana.<br />Swap, bridge and trade predictions.</p>
     </div>`,
    `${OUT}/promo-small-440x280.png`,
  );

  // 1400×560 marquee: headline and two screens.
  await render(
    1400,
    560,
    `<div class="glow a" style="width:520px;height:520px;right:260px;top:-200px"></div>
     <div class="glow b" style="width:480px;height:480px;right:-80px;bottom:-240px"></div>
     <div style="flex:1;padding:0 40px 0 100px">
       <div class="brand"><img src="${ICON}" width="40" height="40" />Duo Wallet</div>
       <h1 style="font-size:56px;margin:28px 0 18px;max-width:600px">One wallet for Ethereum and Solana</h1>
       <p style="font-size:22px;max-width:540px">Send, swap, bridge and trade prediction markets. Self-custodial: your keys stay on your device.</p>
     </div>
     <div style="display:flex;gap:28px;margin-right:90px;align-self:flex-start;margin-top:70px">
       <div class="popup" style="width:300px"><img src="${shot('home')}" /></div>
       <div class="popup" style="width:300px;margin-top:60px"><img src="${shot('predict')}" /></div>
     </div>`,
    `${OUT}/promo-marquee-1400x560.png`,
  );
  await browser.close();
});

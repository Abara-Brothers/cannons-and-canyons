// server/squad-page.js — the page a squad link opens in a browser.
//
// WHY IT EXISTS (owner, 2026-10-10). A squad's Share sends
// https://tanks.abarabrothers.com/squad/CODE. On an iPhone with the game, iOS
// opens the app straight into the squad (the AASA in server.js claims /squad/*
// and app.js's appUrlOpen joins it). Everyone else lands HERE, and the owner's
// rule for them is plain: the link "must not link to the website if they dont
// have the app, it should prompt the user to download the app", and on a
// computer it shows "the same download page with a QR code to scan with a
// phone; never the game website". So this page is never the game: it has no
// script, links to nothing, and only names the game, shows its art and the
// code, says where to get it, and on a large screen draws the same link as a QR
// code (server/qr.js, drawn here, nothing fetched from another host).
//
// SERVED FROM A ROUTE, NOT public/: the code is part of the page, and webDir is
// public/, so a file there would also be copied into the app it advertises.

import { qrSvg } from './qr.js';
import { CODE_CHARS } from './squads.js';

// THE APP STORE LINE, ONE CONSTANT. While this is empty the page says the game
// is coming soon to the App Store (owner, 2026-10-10: the app is not public
// yet). Set it to the game's App Store listing and the line becomes a Download
// button, with nothing else to change.
export const APP_STORE_URL = '';

const CODE = new RegExp('^[' + CODE_CHARS + ']{4}$');

// -> the squad code a /squad/CODE path names, upper-cased as app.js's
// deepLinkCode reads one, or '' for any other path: no code, a code outside
// the alphabet, the wrong length, or anything after it. '' is a 404.
export function squadPathCode(urlPath) {
  const m = /^\/squad\/([^/]*)$/.exec(typeof urlPath === 'string' ? urlPath : '');
  const c = m ? m[1].toUpperCase() : '';
  return CODE.test(c) ? c : '';
}

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// -> the whole page for a valid code. `origin` is the public origin a shared
// link names (https://<CC_NATIVE_HOST>), so the QR is the very link that was
// shared, whatever host this request came in on.
export function squadPage({ code, origin, appStoreUrl = APP_STORE_URL }) {
  const link = origin + '/squad/' + code;
  const store = appStoreUrl
    ? '<a class="store" href="' + esc(appStoreUrl) + '">Download on the App Store</a>'
    : '<p class="soon">Cannons &amp; Canyons is coming soon to the App Store.</p>';
  return '<!doctype html>\n<html lang="en">\n<head>\n'
    + '<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    + '<meta name="robots" content="noindex, nofollow">\n'
    + '<meta name="theme-color" content="#0b1020">\n'
    + '<title>Squad invite: Cannons &amp; Canyons</title>\n'
    // The preview a messaging app draws for the shared link.
    + '<meta property="og:title" content="Join my squad in Cannons &amp; Canyons">\n'
    + '<meta property="og:description" content="Squad code ' + esc(code) + '">\n'
    + '<meta property="og:image" content="' + esc(origin) + '/icons/icon-512.png">\n'
    + '<link rel="icon" type="image/png" sizes="32x32" href="/icons/icon-32.png">\n'
    + '<style>\n'
    + "@font-face{font-family:'Rajdhani';font-weight:700;font-display:swap;src:url(/fonts/rajdhani-700.woff2) format('woff2')}\n"
    + "@font-face{font-family:'Barlow';font-weight:500;font-display:swap;src:url(/fonts/barlow-500.woff2) format('woff2')}\n"
    + "@font-face{font-family:'Barlow';font-weight:700;font-display:swap;src:url(/fonts/barlow-700.woff2) format('woff2')}\n"
    + '*{box-sizing:border-box}\n'
    + 'html{-webkit-text-size-adjust:100%}\n'
    + 'body{margin:0;background:#0b1020;color:#eaf0ff;font:500 16px/1.5 Barlow,-apple-system,system-ui,sans-serif;'
    +   'padding:max(28px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(32px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}\n'
    + 'main{max-width:560px;margin:0 auto}\n'
    + '.brand{display:flex;align-items:center;gap:12px;margin:0}\n'
    + '.brand img{width:52px;height:52px;border-radius:12px;flex:none}\n'
    + '.brand span{font:700 24px/1.1 Rajdhani,system-ui,sans-serif;letter-spacing:.02em}\n'
    + '.art{display:block;width:100%;height:auto;aspect-ratio:1343/394;object-fit:cover;margin:18px 0 22px;border-radius:14px;border:1px solid #2a3358;background:#141b33}\n'
    + 'h1{margin:0 0 16px;font:700 30px/1.15 Rajdhani,system-ui,sans-serif}\n'
    + '.card{background:#141b33;border:1px solid #2a3358;border-radius:14px;padding:14px 18px 16px}\n'
    + '.lbl{margin:0;font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#8f9bc4}\n'
    + '.code{margin:4px 0 0;font:700 60px/1.05 Rajdhani,system-ui,sans-serif;letter-spacing:.12em}\n'
    + '.soon{margin:20px 0 0;font-size:18px;font-weight:700;line-height:1.4}\n'
    + '.store{display:inline-block;margin-top:20px;padding:13px 22px;border-radius:999px;background:#ff7a2e;color:#0b1020;font-weight:700;font-size:17px;text-decoration:none}\n'
    + '.have{margin:12px 0 0;font-size:15px;color:#8f9bc4}\n'
    // THE QR IS FOR A LARGE SCREEN ONLY: a phone cannot scan its own screen,
    // and an iPhone held either way round is under one of these two lengths.
    + '.qr{display:none}\n'
    + '@media (min-width:700px) and (min-height:500px){\n'
    + '  main{max-width:880px;display:grid;grid-template-columns:minmax(0,1fr) 248px;column-gap:40px;align-items:start}\n'
    + '  .qr{display:block;margin-top:70px}\n'
    + '}\n'
    + '.qr svg{display:block;width:100%;height:auto;border-radius:12px}\n'
    + '.qr p{margin:12px 0 0;font-size:15px;color:#8f9bc4;text-align:center}\n'
    + '</style>\n</head>\n<body>\n<main>\n'
    + '<div class="info">\n'
    + '<p class="brand"><img src="/icons/icon-180.png" alt="" width="52" height="52"><span>Cannons &amp; Canyons</span></p>\n'
    + '<img class="art" src="/bay/card-duel-wide.webp" alt="Two tanks trading shells across a snowy valley, from the game" width="1343" height="394">\n'
    + '<h1>You&#39;ve been invited to a squad</h1>\n'
    + '<div class="card"><p class="lbl">Squad code</p><p class="code">' + esc(code) + '</p></div>\n'
    + store + '\n'
    + '<p class="have">Already have the game on your iPhone? Open it, tap Manage on the Squad box, then Join with a code.</p>\n'
    + '</div>\n'
    + '<div class="qr">' + qrSvg(link) + '<p>Scan this with your iPhone camera to open the invite there.</p></div>\n'
    + '</main>\n</body>\n</html>\n';
}

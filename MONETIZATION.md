# Canyons & Cannons — Monetization Plan & Scaffold

Goal: make money without wrecking a skill-based 1v1 game. **Never sell power**
— competitive fairness is the product. Sell identity, convenience, and reach.

## What is already built into the game (live now)

1. **Cosmetic tank paints** — the "Tank Paint" picker on the title screen has
   3 free paints (Olive, Desert, Jungle) and 3 locked **Supporter Pack** paints
   (Midnight, Arctic, Gold, shown with 🔒). Paints are validated server-side
   and visible to your opponent — real social value, zero gameplay impact.
   The lock currently shows a friendly toast; wire it to purchases below.

## Revenue streams (in rollout order)

### Phase 1 — Supporter Pack (one-time IAP, launch week)
- **Product:** `supporter_pack` — non-consumable, **US$2.99 / A$4.49**.
- Unlocks: Midnight/Arctic/Gold paints + a supporter pennant badge; add future
  paints to the pack to keep it appreciating.
- Wiring: add `cordova-plugin-purchase` (or RevenueCat for receipts across both
  stores) in the Capacitor shell → on purchase, set `localStorage.cc_supporter=1`
  and include `supporter:true` in create/join messages; server marks the seat so
  the paint whitelist expands. (~1 day of work incl. store product setup.)
- Web equivalent: Stripe Payment Link that redeems a code (server `redeem` message).

### Phase 2 — Rewarded + interstitial ads (free-player revenue)
- **Interstitial (AdMob):** after every 2nd completed match, capped at 3/day,
  never mid-match. Supporter Pack removes ads (add "No ads" to its value).
- **Rewarded video:** optional, e.g. "watch to unlock a bonus paint for today."
  Keep rewards cosmetic-only.
- AdMob product IDs live in the Capacitor shell only — the web build stays ad-free.

### Phase 3 — Battle Pass Lite (if retention supports it)
- Seasonal cosmetic track (paints, pennants, victory fireworks, shot trails),
  ~US$4.99/season. All cosmetic; free track included.

### Explicitly rejected
- Paid weapons/ammo/damage (pay-to-win kills a 1v1 game)
- Loot boxes (regulatory + rating risk, e.g. 12+/T ratings and Belgium/NL bans)
- Energy/turn limits (kills the "play with a friend right now" loop)

## Pricing & projections (order-of-magnitude)
With D1 retention ~30% and 2–4% supporter conversion typical of casual 1v1:
1,000 downloads ≈ 25–40 packs (≈US$75–120) + ads ≈ US$2–4 eCPM on ~1.5
interstitials/DAU. Monetization only becomes meaningful with distribution —
prioritize the quick-match pool staying warm (cross-promo, featuring, TikTok
clips of nuke/collapse moments) over squeezing ARPU early.

## Store compliance notes
- Supporter Pack must use **native IAP** inside the apps (Apple 3.1.1 / Play
  billing) — the Stripe link is for the web version only and must not be
  linked from inside the iOS app.
- Update the privacy policy + Apple/Google data forms when AdMob ships
  (advertising identifiers change the "no data collected" answers).
- Ratings: adding ads/IAP changes questionnaire answers (still 9+/E10+).

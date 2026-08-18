# Pokémon Card Marketplace — Bot specification

**Archetype:** commerce

**Voice:** professional and concise — write every user-facing message, button label, error, and empty state in this voice.

A Telegram bot marketplace for trading Pokémon cards with on-chain seller fees. Buyers browse and message sellers; sellers list items freely. The platform charges a per-sale fee paid to an owner wallet, with owner notifications in Telegram and email.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Pokémon card collectors
- resellers
- Telegram users

## Success criteria

- Users can list Pokémon cards with photos and details
- Buyers can browse and purchase listings
- Sellers pay on-chain fees when confirming sales
- Owner receives notifications for new sales and payout requests

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open the main menu
- **Sell a Card** (button, actor: user, callback: sell:start) — Begin the listing creation process
- **Browse Listings** (button, actor: user, callback: browse:start) — View available Pokémon card listings
- **My Listings** (button, actor: user, callback: my_listings:start) — View and manage your active listings
- **Request Payout** (button, actor: user, callback: payout:request) — Submit a payout request for your earnings

## Flows

### onboarding
_Trigger:_ /start

1. Show welcome message
2. Display short rules
3. Prompt to choose Buy or Sell

_Data touched:_ User

### create_listing
_Trigger:_ sell:start

1. Collect title
2. Collect price and currency
3. Collect quantity
4. Collect condition
5. Upload photos (up to 5)
6. Collect description
7. Confirm and publish listing

_Data touched:_ Listing

### browse_listings
_Trigger:_ browse:start

1. Show listing grid
2. Allow keyword search
3. Apply condition filters
4. Sort by price or new
5. View listing details
6. Send purchase request

_Data touched:_ Listing, Order

### purchase_flow
_Trigger:_ purchase:request

1. Confirm sale with seller
2. Lock listing quantity
3. Collect fee payment details
4. Show crypto address/QR
5. Request txid proof

_Data touched:_ Order, Fee record

### payout_request
_Trigger:_ payout:request

1. Calculate available earnings
2. Submit payout request
3. Notify owner

_Data touched:_ Order, User

## Owner-supplied settings

The OWNER provides these; they are collected in chat and injected into the environment at deploy. Read each one from the environment where it is used (`ctx.env.<KEY>` / `env.<KEY>` on Cloudflare Workers; `process.env.<KEY>` only as a Node/harness fallback — never the sole read). Do NOT invent your own way of learning the value, do NOT ask for it in a bot message, and do NOT hardcode a default.

- **OWNER_TELEGRAM_ID** — Telegram chat where sale notifications are sent
  - this is the OWNER's own chat id; the platform already knows it. Read `OWNER_TELEGRAM_ID` via `ctx.env` (prefer toolkit `adminChatId` / `requireOwner`) — never ask a user, never treat whoever writes first as the admin, never invent claim-admin or open manage for everyone.
  - may be UNSET at runtime: the bot must still start, and the feature needing OWNER_TELEGRAM_ID must say so plainly instead of failing.
- **OWNER_EMAIL** — Email for sale notifications
  - may be UNSET at runtime: the bot must still start, and the feature needing OWNER_EMAIL must say so plainly instead of failing.
- **FEE_WALLET_ADDRESS** — On-chain wallet to receive seller fees
  - may be UNSET at runtime: the bot must still start, and the feature needing FEE_WALLET_ADDRESS must say so plainly instead of failing.

Your behavioral specs run WITHOUT these values, so no spec may depend on one.

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

An entity that merely NAMES an owner-supplied setting above (an admin chat, an API account) is not something to store or discover — read it from the environment.

- **User** _(retention: persistent)_ — Telegram account with marketplace profile
  - fields: Telegram account, display name, optional contact/email
- **Listing** _(retention: persistent)_ — Available Pokémon card for sale
  - fields: title, description, photos, condition, quantity, price, currency label, created_at, seller_id, status
- **Order** _(retention: persistent)_ — Completed or pending sale transaction
  - fields: listing_id, buyer_id, seller_id, quantity, total, fee_amount, payment_status, payout_requested
- **Fee record** _(retention: persistent)_ — Record of on-chain fee payment
  - fields: sale_id, crypto_amount, crypto_currency, on_chain_txid, settled_at

## Integrations

- **Telegram** (required) — Bot API messaging
- **Email** (required) — Owner notifications
- **On-chain wallet** (required) — Fee collection
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Receive new-sale notifications in Telegram and email
- Receive payout request notifications
- View and manage all listings
- Verify fee txids manually

## Notifications

- New sale confirmation with txid and sale details
- Payout request notification with seller info
- Listing updates and removals

## Permissions & privacy

- Users can choose to share their Telegram username or email with buyers/sellers
- All photos and listing data are stored securely
- No KYC or personal data collection beyond optional contact info

## Edge cases

- Seller cancels after confirming sale but before fee is paid
- Multiple buyers request same listing quantity
- Invalid or fake txid submission
- Owner needs to manually override fee verification

## Required tests

- End-to-end listing creation and sale completion
- Fee payment submission and owner notification flow
- Payout request and owner approval flow
- Notification delivery to both Telegram and email

## Assumptions

- Owner will manually verify txids for fee payments
- Owner will handle payouts to sellers outside the bot
- Marketplace remains open to all users without restrictions
- Crypto wallet address will be provided by owner

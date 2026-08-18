import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { now } from "../clock.js";
import { type Condition, type Listing, feeFor, getListing, listListings, marketSession, newId, reserveOrder } from "../marketplace.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem } from "../toolkit/index.js";

registerMainMenuItem({ label: "Browse listings", data: "browse:start", order: 20 });
const composer = new Composer<Ctx>();
const conditions: Condition[] = ["Mint", "Near mint", "Excellent", "Good", "Played"];

function listingText(listing: Listing): string {
  return `${listing.title}\n${listing.condition} · ${listing.quantity} available\n${listing.price} ${listing.currency}`;
}

function browseKeyboard() {
  return inlineKeyboard([
    [inlineButton("Search", "browse:search"), inlineButton("Filter condition", "browse:filter")],
    [inlineButton("Sort by price", "browse:sort:price"), inlineButton("Sort by newest", "browse:sort:new")],
    [inlineButton("Back to menu", "menu:main")],
  ]);
}

async function showBrowse(ctx: Ctx): Promise<void> {
  const state = marketSession(ctx);
  const all = await listListings(ctx);
  if (!all) {
    await ctx.reply("Listings are temporarily unavailable. Try again shortly.", { reply_markup: browseKeyboard() });
    return;
  }
  const query = state.browse?.query?.toLowerCase();
  const filtered = all.filter((item) => item.status === "active" && (!query || `${item.title} ${item.description}`.toLowerCase().includes(query)) && (!state.browse?.condition || item.condition === state.browse.condition));
  const sorted = [...filtered].sort((a, b) => state.browse?.sort === "price" ? a.price - b.price : b.createdAt.localeCompare(a.createdAt));
  if (sorted.length === 0) {
    await ctx.reply("No listings match that view. Try another search or filter.", { reply_markup: browseKeyboard() });
    return;
  }
  const shown = sorted.slice(0, 6);
  await ctx.reply(shown.map((listing, index) => `${index + 1}. ${listingText(listing)}`).join("\n\n"), {
    reply_markup: inlineKeyboard([...shown.map((listing) => [inlineButton(`View ${listing.title.slice(0, 18)}`, `listing:view:${listing.id}`)]), [inlineButton("Refine results", "browse:start")]]),
  });
}

composer.callbackQuery("browse:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  marketSession(ctx).browse = { sort: "new" };
  await showBrowse(ctx);
});

composer.callbackQuery("browse:search", async (ctx) => {
  await ctx.answerCallbackQuery();
  marketSession(ctx).awaiting = "search";
  await ctx.reply("Send a card name, set, or keyword.", { reply_markup: inlineKeyboard([[inlineButton("Cancel", "flow:cancel")]]) });
});

composer.callbackQuery("browse:filter", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Choose a condition.", { reply_markup: inlineKeyboard([conditions.map((condition) => inlineButton(condition, `browse:condition:${condition}`)), [inlineButton("Clear filter", "browse:condition:all")]]) });
});

composer.callbackQuery(/^browse:condition:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const value = ctx.match[1];
  const browse = marketSession(ctx).browse ?? { sort: "new" as const };
  browse.condition = conditions.includes(value as Condition) ? value as Condition : undefined;
  marketSession(ctx).browse = browse;
  await showBrowse(ctx);
});

composer.callbackQuery(/^browse:sort:(new|price)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const browse = marketSession(ctx).browse ?? { sort: "new" as const };
  browse.sort = ctx.match[1] as "new" | "price";
  marketSession(ctx).browse = browse;
  await showBrowse(ctx);
});

composer.callbackQuery(/^listing:view:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const listing = await getListing(ctx, ctx.match[1]);
  if (!listing || listing.status !== "active") {
    await ctx.reply("That listing is no longer available. Browse the latest listings instead.", { reply_markup: browseKeyboard() });
    return;
  }
  const contact = listing.sellerName;
  await ctx.reply(`${listingText(listing)}\n\n${listing.description}\nSeller: ${contact}`, {
    reply_markup: inlineKeyboard([[inlineButton("Request purchase", `purchase:request:${listing.id}`)], [inlineButton("Back to browse", "browse:start")]]),
  });
});

composer.callbackQuery(/^purchase:request:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const buyer = ctx.from;
  const listing = buyer ? await getListing(ctx, ctx.match[1]) : undefined;
  if (!buyer || !listing || listing.status !== "active" || listing.sellerId === buyer.id) {
    await ctx.reply("That purchase request can’t be started. Choose another available listing.");
    return;
  }
  const order = { id: newId("order"), listingId: listing.id, buyerId: buyer.id, sellerId: listing.sellerId, quantity: 1, total: listing.price, currency: listing.currency, feeAmount: feeFor(listing.price), paymentStatus: "awaiting_seller" as const, payoutRequested: false, createdAt: now().toISOString() };
  if (!(await reserveOrder(ctx, order))) {
    await ctx.reply("That card was just reserved or sold. Browse the latest listings instead.");
    return;
  }
  marketSession(ctx).pendingOrderId = order.id;
  try {
    await ctx.api.sendMessage(listing.sellerId, `A buyer requested ${listing.title} for ${listing.price} ${listing.currency}.`, { reply_markup: inlineKeyboard([[inlineButton("Confirm sale", `order:confirm:${order.id}`), inlineButton("Cancel sale", `order:cancel:${order.id}`)]]) });
  } catch {
    await ctx.reply("The seller can’t receive messages right now. The listing has been reserved; contact support to release it.");
    return;
  }
  await ctx.reply("Your request is with the seller. We’ll show fee payment details after they confirm.");
});

composer.on("message:text", async (ctx, next) => {
  const session = marketSession(ctx);
  if (session.awaiting !== "search" || ctx.message.text.startsWith("/")) return next();
  const query = ctx.message.text.trim();
  if (query.length < 2 || query.length > 60) {
    await ctx.reply("Use 2 to 60 characters for your search.");
    return;
  }
  session.awaiting = undefined;
  session.browse = { ...(session.browse ?? { sort: "new" }), query };
  await showBrowse(ctx);
});

export default composer;

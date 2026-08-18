import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { cancelOrder, getListing, getOrder, listListings, listSellerListings, updateListing, updateOrder, feeWallet } from "../marketplace.js";
import { inlineButton, inlineKeyboard, isOwner, registerMainMenuItem, requireOwner } from "../toolkit/index.js";

registerMainMenuItem({ label: "My listings", data: "my_listings:start", order: 30 });
const composer = new Composer<Ctx>();

async function showMine(ctx: Ctx): Promise<void> {
  const seller = ctx.from;
  if (!seller) return;
  const listings = await listSellerListings(ctx, seller.id);
  if (!listings) {
    await ctx.reply("Your listings are temporarily unavailable. Try again shortly.");
    return;
  }
  const active = listings.filter((listing) => listing.status !== "removed");
  if (active.length === 0) {
    await ctx.reply("No listings yet — tap Sell a card to publish one.", { reply_markup: inlineKeyboard([[inlineButton("Sell a card", "sell:start")], ...(isOwner(ctx) ? [[inlineButton("Owner desk", "owner:desk")]] : [])]) });
    return;
  }
  await ctx.reply(active.map((listing) => `${listing.title}\n${listing.price} ${listing.currency} · ${listing.quantity} available · ${listing.status}`).join("\n\n"), {
    reply_markup: inlineKeyboard([...active.map((listing) => [inlineButton(`Remove ${listing.title.slice(0, 16)}`, `listing:remove:${listing.id}`)]), ...(isOwner(ctx) ? [[inlineButton("Owner desk", "owner:desk")]] : [])]),
  });
}

composer.callbackQuery("my_listings:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showMine(ctx);
});

composer.callbackQuery(/^listing:remove:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const listing = await getListing(ctx, ctx.match[1]);
  if (!listing || listing.sellerId !== ctx.from?.id || listing.status === "sold") {
    await ctx.reply("That listing can’t be removed.");
    return;
  }
  listing.status = "removed";
  if (!(await updateListing(ctx, listing))) {
    await ctx.reply("Couldn’t remove that listing right now. Try again shortly.");
    return;
  }
  await ctx.reply("Listing removed from the marketplace.");
});

composer.callbackQuery(/^order:confirm:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const order = await getOrder(ctx, ctx.match[1]);
  if (!order || order.sellerId !== ctx.from?.id || order.paymentStatus !== "awaiting_seller") {
    await ctx.reply("That sale can’t be confirmed.");
    return;
  }
  const wallet = feeWallet(ctx);
  if (!wallet) {
    await ctx.reply("The fee wallet isn’t set up yet. The sale stays pending until the owner adds it.");
    return;
  }
  order.paymentStatus = "awaiting_fee";
  if (!(await updateOrder(ctx, order))) {
    await ctx.reply("Couldn’t confirm that sale right now. Try again shortly.");
    return;
  }
  try {
    await ctx.api.sendMessage(order.buyerId, `The seller confirmed the sale. Seller fee: ${order.feeAmount}. Send the fee to:\n${wallet}\n\nThen send the transaction ID here.`, { reply_markup: inlineKeyboard([[inlineButton("Cancel purchase", `order:cancel:${order.id}`)]]) });
  } catch {
    await ctx.reply("The buyer can’t receive messages right now. The sale is confirmed and awaiting the fee.");
    return;
  }
  await ctx.reply("Sale confirmed. The buyer has the fee payment details.");
});

composer.callbackQuery(/^order:cancel:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const order = await getOrder(ctx, ctx.match[1]);
  if (!order || (order.sellerId !== ctx.from?.id && order.buyerId !== ctx.from?.id) || order.paymentStatus === "fee_verified") {
    await ctx.reply("That sale can’t be cancelled.");
    return;
  }
  if (!(await cancelOrder(ctx, order.id))) {
    await ctx.reply("Couldn’t cancel that sale right now. Try again shortly.");
    return;
  }
  const other = order.sellerId === ctx.from?.id ? order.buyerId : order.sellerId;
  try { await ctx.api.sendMessage(other, "This sale was cancelled. The card quantity is available again."); } catch { /* recipient may have blocked the bot */ }
  await ctx.reply("Sale cancelled. The card quantity is available again.");
});

composer.callbackQuery("owner:listings", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireOwner(ctx))) return;
  const listings = await listListings(ctx);
  if (!listings) return void (await ctx.reply("Listings are temporarily unavailable. Try again shortly."));
  if (listings.length === 0) return void (await ctx.reply("No marketplace listings yet."));
  await ctx.reply(listings.slice(0, 20).map((listing) => `${listing.title} · ${listing.status} · ${listing.quantity} available`).join("\n"));
});

composer.callbackQuery("owner:desk", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return void (await requireOwner(ctx));
  await ctx.reply("Owner desk", { reply_markup: inlineKeyboard([[inlineButton("All listings", "owner:listings")]]) });
});

export default composer;

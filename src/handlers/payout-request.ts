import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { getOrder, isTxid, marketSession, saveFee, sellerOrders, updateOrder, verifyOrderFee } from "../marketplace.js";
import { adminChatId, inlineButton, inlineKeyboard, registerMainMenuItem, requireOwner } from "../toolkit/index.js";

registerMainMenuItem({ label: "Request payout", data: "payout:request", order: 40 });
const composer = new Composer<Ctx>();

composer.callbackQuery("payout:request", async (ctx) => {
  await ctx.answerCallbackQuery();
  const seller = ctx.from;
  if (!seller) return;
  const orders = await sellerOrders(ctx, seller.id);
  if (!orders) {
    await ctx.reply("Your earnings are temporarily unavailable. Try again shortly.");
    return;
  }
  const available = orders.filter((order) => order.paymentStatus === "fee_verified" && !order.payoutRequested);
  const totals = available.reduce<Record<string, number>>((all, order) => ({ ...all, [order.currency]: (all[order.currency] ?? 0) + order.total - order.feeAmount }), {});
  if (available.length === 0) {
    await ctx.reply("No earnings are available for payout yet. Verified sales will appear here.");
    return;
  }
  await ctx.reply(`Available earnings: ${Object.entries(totals).map(([currency, amount]) => `${amount.toFixed(2)} ${currency}`).join(", ")}\n${available.length} verified sale${available.length === 1 ? "" : "s"} ready for payout.`, { reply_markup: inlineKeyboard([[inlineButton("Submit payout request", "payout:submit")], [inlineButton("Cancel", "flow:cancel")]]) });
});

composer.callbackQuery("payout:submit", async (ctx) => {
  await ctx.answerCallbackQuery();
  const seller = ctx.from;
  if (!seller) return;
  const orders = await sellerOrders(ctx, seller.id);
  const payable = orders?.filter((order) => order.paymentStatus === "fee_verified" && !order.payoutRequested) ?? [];
  if (payable.length === 0) {
    await ctx.reply("There are no verified earnings ready for a payout request.");
    return;
  }
  for (const order of payable) { order.payoutRequested = true; await updateOrder(ctx, order); }
  const amount = Object.entries(payable.reduce<Record<string, number>>((all, order) => ({ ...all, [order.currency]: (all[order.currency] ?? 0) + order.total - order.feeAmount }), {})).map(([currency, value]) => `${value.toFixed(2)} ${currency}`).join(", ");
  const owner = adminChatId(ctx as { env?: Record<string, unknown> });
  if (owner) {
    try { await ctx.api.sendMessage(owner, `Payout request from ${seller.username ? `@${seller.username}` : seller.first_name}: ${amount} across ${payable.length} verified sale${payable.length === 1 ? "" : "s"}.`, { reply_markup: inlineKeyboard(payable.map((order) => [inlineButton("Approve payout", `payout:approve:${order.id}`)])) }); } catch { /* a blocked owner notification must not undo the request */ }
    await ctx.reply("Your payout request was sent to the owner.");
  } else {
    await ctx.reply("Your payout request was recorded, but owner notifications aren’t set up yet.");
  }
});

composer.callbackQuery(/^payout:approve:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireOwner(ctx))) return;
  const order = await getOrder(ctx, ctx.match[1]);
  if (!order || !order.payoutRequested) {
    await ctx.reply("That payout request is no longer available.");
    return;
  }
  order.payoutRequested = false;
  if (!(await updateOrder(ctx, order))) {
    await ctx.reply("Couldn’t approve that payout right now. Try again shortly.");
    return;
  }
  try { await ctx.api.sendMessage(order.sellerId, "Your payout request was approved. The owner will arrange payment outside the bot."); } catch { /* recipient may have blocked the bot */ }
  await ctx.reply("Payout request approved.");
});

composer.callbackQuery(/^fee:verify:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireOwner(ctx))) return;
  const order = await getOrder(ctx, ctx.match[1]);
  if (!order || order.paymentStatus !== "fee_submitted") {
    await ctx.reply("That fee proof isn’t awaiting verification.");
    return;
  }
  if (!(await verifyOrderFee(ctx, order.id))) return void (await ctx.reply("Couldn’t verify that fee right now. Try again shortly."));
  try { await ctx.api.sendMessage(order.sellerId, "The owner verified the fee payment. This sale is ready for payout."); } catch { /* recipient may have blocked the bot */ }
  await ctx.reply("Fee payment verified.");
});

composer.on("message:text", async (ctx, next) => {
  const session = marketSession(ctx);
  if (!session.pendingOrderId || ctx.message.text.startsWith("/")) return next();
  const pending = await getOrder(ctx, session.pendingOrderId);
  if (!pending || pending.paymentStatus !== "awaiting_fee") return next();
  const txid = ctx.message.text.trim();
  if (!isTxid(txid)) {
    await ctx.reply("That transaction ID doesn’t look valid. Send the full ID from your wallet.");
    return;
  }
  const order = pending;
  if (!order || order.buyerId !== ctx.from?.id || order.paymentStatus !== "awaiting_fee") {
    session.awaiting = undefined;
    await ctx.reply("There isn’t a fee payment awaiting proof. Browse listings to start a purchase.");
    return;
  }
  order.paymentStatus = "fee_submitted";
  if (!(await updateOrder(ctx, order)) || !(await saveFee(ctx, { saleId: order.id, cryptoAmount: String(order.feeAmount), cryptoCurrency: "network token", onChainTxid: txid, settledAt: null }))) {
    await ctx.reply("Couldn’t record that fee proof right now. Send it again in a moment.");
    return;
  }
  session.awaiting = undefined;
  const owner = adminChatId(ctx as { env?: Record<string, unknown> });
  if (owner) {
    try { await ctx.api.sendMessage(owner, `Fee proof submitted. Transaction ID: ${txid}`, { reply_markup: inlineKeyboard([[inlineButton("Verify fee", `fee:verify:${order.id}`)]]) }); } catch { /* notification delivery is best effort */ }
  }
  await ctx.reply(owner ? "Fee proof submitted. The owner will verify it manually." : "Fee proof submitted. Owner notifications aren’t set up yet, so verification is pending.");
});

export default composer;

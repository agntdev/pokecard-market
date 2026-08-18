import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { now } from "../clock.js";
import {
  type Condition,
  type Draft,
  marketSession,
  newId,
  saveListing,
} from "../marketplace.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem } from "../toolkit/index.js";

registerMainMenuItem({ label: "Sell a card", data: "sell:start", order: 10 });

const composer = new Composer<Ctx>();
const conditions: Condition[] = ["Mint", "Near mint", "Excellent", "Good", "Played"];
const cancel = inlineKeyboard([[inlineButton("Cancel", "flow:cancel")]]);

function photosKeyboard() {
  return inlineKeyboard([
    [inlineButton("Continue", "listing:photos:done")],
    [inlineButton("Skip photos", "listing:photos:skip"), inlineButton("Cancel", "flow:cancel")],
  ]);
}

function conditionKeyboard() {
  return inlineKeyboard([
    conditions.slice(0, 3).map((condition) => inlineButton(condition, `listing:condition:${condition}`)),
    conditions.slice(3).map((condition) => inlineButton(condition, `listing:condition:${condition}`)),
    [inlineButton("Cancel", "flow:cancel")],
  ]);
}

function validPrice(text: string): { price: number; currency: string } | undefined {
  const match = text.trim().match(/^(\d+(?:\.\d{1,2})?)\s+([A-Za-z]{3,10})$/);
  if (!match) return undefined;
  const price = Number(match[1]);
  if (!Number.isFinite(price) || price <= 0) return undefined;
  return { price, currency: match[2].toUpperCase() };
}

function summary(draft: Draft): string {
  return `Review your listing:\n${draft.title}\n${draft.price} ${draft.currency} · ${draft.quantity} available\n${draft.condition}\n${draft.photos.length} photo${draft.photos.length === 1 ? "" : "s"}\n${draft.description}`;
}

composer.callbackQuery("sell:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  marketSession(ctx).listingDraft = { step: "title", photos: [] };
  await ctx.reply("Send the card title.", { reply_markup: cancel });
});

composer.callbackQuery("flow:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  delete marketSession(ctx).listingDraft;
  delete marketSession(ctx).awaiting;
  await ctx.reply("Cancelled. Your draft wasn’t published.");
});

composer.callbackQuery(/^listing:condition:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = marketSession(ctx).listingDraft;
  const condition = ctx.match[1] as Condition;
  if (!draft || !conditions.includes(condition)) {
    await ctx.reply("That listing draft has expired. Tap Sell a card to start again.");
    return;
  }
  draft.condition = condition;
  draft.step = "photos";
  await ctx.reply("Send up to 5 photos, then tap Continue.", { reply_markup: photosKeyboard() });
});

composer.callbackQuery(["listing:photos:done", "listing:photos:skip"], async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = marketSession(ctx).listingDraft;
  if (!draft) {
    await ctx.reply("That listing draft has expired. Tap Sell a card to start again.");
    return;
  }
  if (ctx.callbackQuery.data === "listing:photos:done" && draft.photos.length === 0) {
    await ctx.reply("Add at least one photo, or tap Skip photos to continue.", { reply_markup: photosKeyboard() });
    return;
  }
  draft.step = "description";
  await ctx.reply("Send a short description. Include set, card number, or anything buyers should know.", { reply_markup: cancel });
});

composer.callbackQuery("listing:publish", async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = marketSession(ctx).listingDraft;
  const seller = ctx.from;
  if (!draft || !seller || !draft.title || !draft.price || !draft.currency || !draft.quantity || !draft.condition || !draft.description) {
    await ctx.reply("That listing draft is incomplete. Tap Sell a card to start again.");
    return;
  }
  const listing = {
    id: newId("listing"), title: draft.title, description: draft.description, photos: draft.photos,
    condition: draft.condition, quantity: draft.quantity, price: draft.price, currency: draft.currency,
    createdAt: now().toISOString(), sellerId: seller.id, sellerName: seller.username ? `@${seller.username}` : seller.first_name,
    status: "active" as const,
  };
  if (!(await saveListing(ctx, listing))) {
    await ctx.reply("Marketplace storage isn’t available yet. Your listing wasn’t published — try again shortly.");
    return;
  }
  delete marketSession(ctx).listingDraft;
  await ctx.reply("Your listing is live.", { reply_markup: inlineKeyboard([[inlineButton("Browse listings", "browse:start"), inlineButton("My listings", "my_listings:start")]]) });
});

composer.callbackQuery("listing:edit", async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = marketSession(ctx).listingDraft;
  if (!draft) {
    await ctx.reply("That listing draft has expired. Tap Sell a card to start again.");
    return;
  }
  draft.step = "title";
  await ctx.reply("Send the updated card title.", { reply_markup: cancel });
});

composer.on("message:photo", async (ctx, next) => {
  const draft = marketSession(ctx).listingDraft;
  if (!draft || draft.step !== "photos") return next();
  if (draft.photos.length >= 5) {
    await ctx.reply("You already added 5 photos. Tap Continue when you’re ready.", { reply_markup: photosKeyboard() });
    return;
  }
  const photo = ctx.message.photo.at(-1);
  if (!photo) return;
  draft.photos.push(photo.file_id);
  await ctx.reply(`Photo ${draft.photos.length} of 5 added.`, { reply_markup: photosKeyboard() });
});

composer.on("message:text", async (ctx, next) => {
  const draft = marketSession(ctx).listingDraft;
  if (!draft || ctx.message.text.startsWith("/")) return next();
  const text = ctx.message.text.trim();
  if (!text) return;
  if (draft.step === "title") {
    if (text.length > 100) return void (await ctx.reply("Keep the title under 100 characters.", { reply_markup: cancel }));
    draft.title = text; draft.step = "price";
    await ctx.reply("Send the price and currency, for example: 25 USD.", { reply_markup: cancel });
  } else if (draft.step === "price") {
    const value = validPrice(text);
    if (!value) return void (await ctx.reply("Use a positive price and currency, for example: 25 USD.", { reply_markup: cancel }));
    draft.price = value.price; draft.currency = value.currency; draft.step = "quantity";
    await ctx.reply("How many copies are available? Send a whole number.", { reply_markup: cancel });
  } else if (draft.step === "quantity") {
    const quantity = Number(text);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) return void (await ctx.reply("Send a quantity from 1 to 999.", { reply_markup: cancel }));
    draft.quantity = quantity; draft.step = "condition";
    await ctx.reply("Choose the card condition.", { reply_markup: conditionKeyboard() });
  } else if (draft.step === "description") {
    if (text.length > 1000) return void (await ctx.reply("Keep the description under 1,000 characters.", { reply_markup: cancel }));
    draft.description = text; draft.step = "confirm";
    await ctx.reply(summary(draft), { reply_markup: inlineKeyboard([[inlineButton("Publish listing", "listing:publish"), inlineButton("Edit title", "listing:edit")], [inlineButton("Cancel", "flow:cancel")]]) });
  }
});

export default composer;

import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { saveUser } from "../marketplace.js";
import { inlineButton, inlineKeyboard, mainMenuKeyboard } from "../toolkit/index.js";

// The /start handler renders the bot's MAIN MENU — the primary way users operate
// a button-first bot. A feature adds its own button by calling
// `registerMainMenuItem(...)` in its own `src/handlers/<slug>.ts`; this handler
// renders whatever is registered (plus a Help button), so you do NOT edit this
// file to add a feature. Send ONE message — no placeholder line above the menu.
const composer = new Composer<Ctx>();

const WELCOME = "Welcome to the Pokémon Card Marketplace.\nList responsibly and confirm every sale in the bot.\nChoose how you’d like to start.";

composer.command("start", async (ctx) => {
  if (ctx.from) {
    void saveUser(ctx, { id: ctx.from.id, displayName: ctx.from.first_name, ...(ctx.from.username ? { username: ctx.from.username } : {}) });
  }
  await ctx.reply(WELCOME, { reply_markup: inlineKeyboard([[inlineButton("Buy cards", "browse:start"), inlineButton("Sell a card", "sell:start")], ...mainMenuKeyboard().inline_keyboard]) });
});

// "Back to menu" — re-render the main menu in place from any sub-view.
composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(WELCOME, { reply_markup: inlineKeyboard([[inlineButton("Buy cards", "browse:start"), inlineButton("Sell a card", "sell:start")], ...mainMenuKeyboard().inline_keyboard]) });
});

export default composer;

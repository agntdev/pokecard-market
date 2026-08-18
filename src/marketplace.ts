import type { Ctx } from "./bot.js";

export type Condition = "Mint" | "Near mint" | "Excellent" | "Good" | "Played";
export type ListingStatus = "active" | "reserved" | "sold" | "removed";

export interface Listing {
  id: string;
  title: string;
  description: string;
  photos: string[];
  condition: Condition;
  quantity: number;
  price: number;
  currency: string;
  createdAt: string;
  sellerId: number;
  sellerName: string;
  status: ListingStatus;
}

export interface Order {
  id: string;
  listingId: string;
  buyerId: number;
  sellerId: number;
  quantity: number;
  total: number;
  currency: string;
  feeAmount: number;
  paymentStatus: "awaiting_seller" | "awaiting_fee" | "fee_submitted" | "fee_verified" | "cancelled";
  payoutRequested: boolean;
  createdAt: string;
}

export interface FeeRecord {
  saleId: string;
  cryptoAmount: string;
  cryptoCurrency: string;
  onChainTxid: string;
  settledAt: string | null;
}

export interface MarketplaceUser { id: number; displayName: string; username?: string; email?: string }

export interface Draft {
  step: "title" | "price" | "quantity" | "condition" | "photos" | "description" | "confirm";
  title?: string;
  price?: number;
  currency?: string;
  quantity?: number;
  condition?: Condition;
  photos: string[];
  description?: string;
}

export interface MarketplaceSession {
  listingDraft?: Draft;
  browse?: { query?: string; condition?: Condition; sort: "new" | "price" };
  pendingOrderId?: string;
  awaiting?: "search" | "txid";
}

type DoNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: { method?: string; body?: string }): Promise<Response> };
};

type MarketplaceCtx = Ctx & { env?: { CHAT_DO?: DoNamespace } };

function domain(ctx: MarketplaceCtx) {
  const namespace = ctx.env?.CHAT_DO;
  return namespace?.get(namespace.idFromName("marketplace:domain"));
}

async function call<T>(ctx: MarketplaceCtx, operation: string, payload: unknown): Promise<T | undefined> {
  const target = domain(ctx);
  if (!target) return undefined;
  const response = await target.fetch("https://do/marketplace", {
    method: "POST",
    body: JSON.stringify({ operation, payload }),
  });
  if (!response.ok) return undefined;
  return (await response.json()) as T;
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function marketSession(ctx: Ctx): MarketplaceSession {
  return ctx.session as MarketplaceSession;
}

export async function saveListing(ctx: MarketplaceCtx, listing: Listing): Promise<boolean> {
  return (await call<boolean>(ctx, "listing:save", listing)) ?? false;
}

export async function saveUser(ctx: MarketplaceCtx, user: MarketplaceUser): Promise<boolean> {
  return (await call<boolean>(ctx, "user:save", user)) ?? false;
}

export async function getListing(ctx: MarketplaceCtx, listingId: string): Promise<Listing | undefined> {
  return call<Listing | undefined>(ctx, "listing:get", listingId);
}

export async function listListings(ctx: MarketplaceCtx): Promise<Listing[] | undefined> {
  return call<Listing[]>(ctx, "listing:list", null);
}

export async function listSellerListings(ctx: MarketplaceCtx, sellerId: number): Promise<Listing[] | undefined> {
  return call<Listing[]>(ctx, "listing:seller", sellerId);
}

export async function updateListing(ctx: MarketplaceCtx, listing: Listing): Promise<boolean> {
  return (await call<boolean>(ctx, "listing:update", listing)) ?? false;
}

export async function saveOrder(ctx: MarketplaceCtx, order: Order): Promise<boolean> {
  return (await call<boolean>(ctx, "order:save", order)) ?? false;
}

export async function reserveOrder(ctx: MarketplaceCtx, order: Order): Promise<boolean> {
  return (await call<boolean>(ctx, "order:reserve", order)) ?? false;
}

export async function getOrder(ctx: MarketplaceCtx, orderId: string): Promise<Order | undefined> {
  return call<Order | undefined>(ctx, "order:get", orderId);
}

export async function cancelOrder(ctx: MarketplaceCtx, orderId: string): Promise<boolean> {
  return (await call<boolean>(ctx, "order:cancel", orderId)) ?? false;
}

export async function updateOrder(ctx: MarketplaceCtx, order: Order): Promise<boolean> {
  return (await call<boolean>(ctx, "order:update", order)) ?? false;
}

export async function verifyOrderFee(ctx: MarketplaceCtx, orderId: string): Promise<boolean> {
  return (await call<boolean>(ctx, "order:verify", orderId)) ?? false;
}

export async function sellerOrders(ctx: MarketplaceCtx, sellerId: number): Promise<Order[] | undefined> {
  return call<Order[]>(ctx, "order:seller", sellerId);
}

export async function saveFee(ctx: MarketplaceCtx, fee: FeeRecord): Promise<boolean> {
  return (await call<boolean>(ctx, "fee:save", fee)) ?? false;
}

export const newId = id;

export function feeFor(total: number): number {
  // Marketplace fee is 2.5% of the completed sale, rounded to currency cents.
  return Math.round(total * 0.025 * 100) / 100;
}

export function isTxid(value: string): boolean {
  return /^[A-Za-z0-9]{32,128}$/.test(value);
}

export function ownerEmail(ctx: MarketplaceCtx): string | undefined {
  const fromWorker = ctx.env as Record<string, unknown> | undefined;
  const value = fromWorker?.OWNER_EMAIL ?? (typeof process === "undefined" ? undefined : process.env.OWNER_EMAIL);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function feeWallet(ctx: MarketplaceCtx): string | undefined {
  const fromWorker = ctx.env as Record<string, unknown> | undefined;
  const value = fromWorker?.FEE_WALLET_ADDRESS ?? (typeof process === "undefined" ? undefined : process.env.FEE_WALLET_ADDRESS);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

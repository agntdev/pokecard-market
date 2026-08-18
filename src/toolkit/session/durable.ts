/**
 * Durable Object session storage + exact-time reminders for the Cloudflare
 * Workers runtime (docs/cloudflare/new-projects-on-cf.md §1, §10).
 *
 * One ChatDO instance per chat (addressed by idFromName("chat:<chatId>")). It
 * holds:
 *   - the grammY session (strongly consistent, serialized per chat for free);
 *   - that chat's reminders, with a single Durable Object ALARM armed to the
 *     earliest due one. The alarm fires at the wall-clock time even when nothing
 *     is running — this is what replaces per-bot cron + Redis (PoC: 0–1 ms).
 *
 * NONE of this is imported by the Node/long-poll entry or the test harness, so
 * `node:fs`, Redis, and this file's Workers-only globals never load there.
 */

import type { StorageAdapter } from "grammy";

// Minimal shapes so this file type-checks without pulling @cloudflare/workers-types
// into the Node build. The real bindings are provided by the Workers runtime.
export interface DOState {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(entries: Record<string, unknown>): Promise<void>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    setAlarm(scheduledTime: number): Promise<void>;
    getAlarm(): Promise<number | null>;
  };
  blockConcurrencyWhile(fn: () => Promise<void>): void;
}
export interface DONamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DOStub;
}
export interface DOStub {
  fetch(input: string, init?: { method?: string; body?: string }): Promise<Response>;
}
export interface WorkerEnv {
  BOT_TOKEN: string;
  WEBHOOK_SECRET?: string;
  CHAT_DO: DONamespace;
  DB?: unknown; // D1 binding (app data); see AGENTS.md
  BOT_TELEMETRY_URL?: string;
  BOT_TELEMETRY_SECRET?: string;
  BOT_TELEMETRY_SALT?: string;
}

interface Reminder {
  at: number; // epoch ms
  chatId: number | string;
  text: string;
}

interface MarketplaceRequest {
  operation: string;
  payload: unknown;
}

interface IndexedRecord {
  id: string;
  sellerId?: number;
}

/**
 * createDurableSessionStorage — a grammY StorageAdapter that routes each session
 * key to its own ChatDO instance. Pass to buildBot({ storage }) in the Worker.
 */
export function createDurableSessionStorage<T>(env: WorkerEnv): StorageAdapter<T> {
  const stub = (key: string): DOStub => {
    // A missing binding otherwise surfaces as the opaque "Cannot read
    // properties of undefined (reading 'get')" — live: canary #2 shipped with
    // the binding misnamed CHATDO and every update threw exactly that.
    if (!env.CHAT_DO) {
      throw new Error(
        "CHAT_DO Durable Object binding is missing — the deploy must bind class ChatDO as CHAT_DO (see cf.meta.json)",
      );
    }
    return env.CHAT_DO.get(env.CHAT_DO.idFromName("chat:" + key));
  };
  return {
    async read(key: string): Promise<T | undefined> {
      const r = await stub(key).fetch("https://do/session", { method: "GET" });
      if (r.status === 204) return undefined;
      return (await r.json()) as T;
    },
    async write(key: string, value: T): Promise<void> {
      await stub(key).fetch("https://do/session", { method: "PUT", body: JSON.stringify(value) });
    },
    async delete(key: string): Promise<void> {
      await stub(key).fetch("https://do/session", { method: "DELETE" });
    },
  };
}

/**
 * remindAt — schedule a one-shot reminder DM for `chatId` at `whenEpochMs`.
 * Backed by the chat's ChatDO alarm; fires within a millisecond of the target
 * even if the Worker was idle. Call from a handler under the Workers runtime
 * (via ctx.env). No-op-safe: a scheduling failure never throws into the update.
 */
export async function remindAt(
  env: WorkerEnv,
  chatId: number | string,
  whenEpochMs: number,
  text: string,
): Promise<void> {
  try {
    const stub = env.CHAT_DO.get(env.CHAT_DO.idFromName("chat:" + chatId));
    await stub.fetch("https://do/remind", {
      method: "POST",
      body: JSON.stringify({ at: whenEpochMs, chatId, text } satisfies Reminder),
    });
  } catch {
    /* best-effort: a reminder we couldn't schedule must not break the reply */
  }
}

async function tg(token: string, method: string, payload: unknown): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * ChatDO — the per-chat Durable Object. Its class name is referenced in
 * cf.meta.json (new_sqlite_classes) so the deployer registers the migration.
 * Constructed by the runtime with (state, env).
 */
export class ChatDO {
  constructor(
    private readonly state: DOState,
    private readonly env: WorkerEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Session storage (routed here by createDurableSessionStorage).
    if (url.pathname === "/session") {
      if (request.method === "GET") {
        const v = await this.state.storage.get<unknown>("session");
        if (v === undefined) return new Response(null, { status: 204 });
        return Response.json(v);
      }
      if (request.method === "PUT") {
        await this.state.storage.put("session", await request.json());
        return new Response(null, { status: 204 });
      }
      if (request.method === "DELETE") {
        await this.state.storage.delete("session");
        return new Response(null, { status: 204 });
      }
    }

    // Schedule a reminder + (re)arm the alarm to the earliest due one.
    if (url.pathname === "/remind" && request.method === "POST") {
      const rem = (await request.json()) as Reminder;
      const list = (await this.state.storage.get<Reminder[]>("reminders")) ?? [];
      list.push(rem);
      await this.state.storage.put("reminders", list);
      await this.rearm(list);
      return new Response(null, { status: 204 });
    }

    // Marketplace domain records share one named Durable Object. Collections are
    // addressed through explicit index records; there is no keyspace scan.
    if (url.pathname === "/marketplace" && request.method === "POST") {
      const marketplaceRequest = (await request.json()) as MarketplaceRequest;
      return this.marketplace(marketplaceRequest);
    }

    return new Response("not found", { status: 404 });
  }

  // Fires at the earliest reminder's wall-clock time. Sends every due reminder,
  // drops them, and re-arms for whatever remains.
  async alarm(): Promise<void> {
    const now = Date.now();
    const list = (await this.state.storage.get<Reminder[]>("reminders")) ?? [];
    const due = list.filter((r) => r.at <= now);
    const rest = list.filter((r) => r.at > now);
    for (const r of due) {
      await tg(this.env.BOT_TOKEN, "sendMessage", { chat_id: r.chatId, text: r.text });
    }
    await this.state.storage.put("reminders", rest);
    await this.rearm(rest);
  }

  private async rearm(list: Reminder[]): Promise<void> {
    if (list.length === 0) return;
    const next = Math.min(...list.map((r) => r.at));
    const current = await this.state.storage.getAlarm();
    if (current === null || next < current) {
      await this.state.storage.setAlarm(next);
    }
  }

  private async marketplace(request: MarketplaceRequest): Promise<Response> {
    const payload = request.payload as Record<string, unknown> | string | number | null;
    const read = async <T>(key: string): Promise<T | undefined> =>
      this.state.storage.get<T>(`market:${key}`);
    const write = async (key: string, value: unknown): Promise<void> =>
      this.state.storage.put(`market:${key}`, value);
    const append = async (key: string, id: string): Promise<void> => {
      const ids = (await read<string[]>(key)) ?? [];
      if (!ids.includes(id)) await write(key, [...ids, id]);
    };
    const records = async <T extends IndexedRecord>(index: string, prefix: string): Promise<T[]> => {
      const ids = (await read<string[]>(index)) ?? [];
      const values = await Promise.all(ids.map((recordId) => read<T>(`${prefix}:${recordId}`)));
      return values.filter((value) => value !== undefined) as T[];
    };

    if (request.operation === "listing:save" || request.operation === "listing:update") {
      const listing = payload as unknown as IndexedRecord;
      await write(`listing:${listing.id}`, listing);
      await append("listing:ids", listing.id);
      if (typeof listing.sellerId === "number") await append(`listing:seller:${listing.sellerId}`, listing.id);
      return Response.json(true);
    }
    if (request.operation === "user:save") {
      const user = payload as { id: number };
      await write(`user:${user.id}`, user);
      await append("user:ids", String(user.id));
      return Response.json(true);
    }
    if (request.operation === "listing:get") return Response.json(await read(`listing:${String(payload)}`));
    if (request.operation === "listing:list") return Response.json(await records("listing:ids", "listing"));
    if (request.operation === "listing:seller") {
      return Response.json(await records(`listing:seller:${String(payload)}`, "listing"));
    }
    if (request.operation === "order:save" || request.operation === "order:update") {
      const order = payload as unknown as IndexedRecord;
      await write(`order:${order.id}`, order);
      await append("order:ids", order.id);
      if (typeof order.sellerId === "number") await append(`order:seller:${order.sellerId}`, order.id);
      return Response.json(true);
    }
    if (request.operation === "order:reserve") {
      const order = payload as unknown as IndexedRecord & { listingId: string; quantity: number };
      const listing = await read<{ id: string; quantity: number; status: string }>(`listing:${order.listingId}`);
      if (!listing || listing.status !== "active" || listing.quantity < order.quantity) return Response.json(false);
      listing.quantity -= order.quantity;
      if (listing.quantity === 0) listing.status = "reserved";
      await write(`listing:${listing.id}`, listing);
      await write(`order:${order.id}`, order);
      await append("order:ids", order.id);
      if (typeof order.sellerId === "number") await append(`order:seller:${order.sellerId}`, order.id);
      return Response.json(true);
    }
    if (request.operation === "order:get") return Response.json(await read(`order:${String(payload)}`));
    if (request.operation === "order:cancel") {
      const order = await read<{ id: string; listingId: string; quantity: number; paymentStatus: string }>(`order:${String(payload)}`);
      if (!order || order.paymentStatus === "fee_verified" || order.paymentStatus === "cancelled") return Response.json(false);
      const listing = await read<{ id: string; quantity: number; status: string }>(`listing:${order.listingId}`);
      if (listing) {
        listing.quantity += order.quantity;
        listing.status = "active";
        await write(`listing:${listing.id}`, listing);
      }
      order.paymentStatus = "cancelled";
      await write(`order:${order.id}`, order);
      return Response.json(true);
    }
    if (request.operation === "order:verify") {
      const order = await read<{ id: string; listingId: string; paymentStatus: string }>(`order:${String(payload)}`);
      if (!order || order.paymentStatus !== "fee_submitted") return Response.json(false);
      order.paymentStatus = "fee_verified";
      await write(`order:${order.id}`, order);
      const listing = await read<{ id: string; quantity: number; status: string }>(`listing:${order.listingId}`);
      if (listing && listing.quantity === 0) {
        listing.status = "sold";
        await write(`listing:${listing.id}`, listing);
      }
      return Response.json(true);
    }
    if (request.operation === "order:seller") {
      return Response.json(await records(`order:seller:${String(payload)}`, "order"));
    }
    if (request.operation === "fee:save") {
      const fee = payload as { saleId: string };
      await write(`fee:${fee.saleId}`, fee);
      await append("fee:ids", fee.saleId);
      return Response.json(true);
    }
    return new Response("unknown marketplace operation", { status: 400 });
  }
}

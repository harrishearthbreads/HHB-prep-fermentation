// Shared inventory log for tools.harrishearthbreads.com (Inventory tab).
// One blob per entry (key = id), so two people submitting at once never collide.
//   GET  /api/inventory                      -> { items: [...] }  (newest first)
//   POST /api/inventory {action:"add",...}   -> adds an entry; any open entry for the
//                                               same category + item is marked "superseded"
//   POST /api/inventory {action:"clear",id}  -> marks an open entry "cleared" (purchased)
//   POST /api/inventory {action:"reopen",id} -> undo a clear
import { getStore } from "@netlify/blobs";

const PIN = (typeof process !== "undefined" && process.env && process.env.INVENTORY_PIN) || "0214";
const LEVELS = ["URGENT", "LOW", "MEDIUM", "FULLY STOCKED"];
const KEEP_DAYS = 120; // closed entries older than this are pruned on read

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const clean = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const keyOf = (c, n) => (c + "|" + n).toLowerCase();

async function listAll(store) {
  const { blobs } = await store.list();
  const items = (
    await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }).catch(() => null)))
  ).filter(Boolean);
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  const keep = [];
  for (const it of items) {
    const closedAt = it.clearedAt || it.supersededAt;
    if (it.status !== "open" && closedAt && Date.parse(closedAt) < cutoff) {
      await store.delete(it.id).catch(() => {});
    } else keep.push(it);
  }
  keep.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return keep;
}

export async function handle(req, store) {
  if (req.headers.get("x-hhb-pin") !== PIN) return json({ error: "Not authorized" }, 401);

  if (req.method === "GET") return json({ items: await listAll(store), serverTime: new Date().toISOString() });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const now = new Date().toISOString();

  if (body.action === "add") {
    const category = clean(body.category, 60);
    const name = clean(body.name, 80);
    const level = clean(body.level, 20).toUpperCase();
    const notes = clean(body.notes, 300);
    if (!category || !name) return json({ error: "Category and item name are required" }, 400);
    if (!LEVELS.includes(level)) return json({ error: "Invalid level" }, 400);

    const existing = await listAll(store);
    for (const it of existing) {
      if (it.status === "open" && keyOf(it.category, it.name) === keyOf(category, name)) {
        await store.setJSON(it.id, { ...it, status: "superseded", supersededAt: now });
      }
    }
    const id = now.replace(/\D/g, "") + "-" + Math.random().toString(36).slice(2, 8);
    const item = { id, category, name, level, notes, status: "open", createdAt: now, clearedAt: null };
    await store.setJSON(id, item);
    return json({ ok: true, item });
  }

  if (body.action === "clear" || body.action === "reopen") {
    const id = clean(body.id, 80);
    const it = id ? await store.get(id, { type: "json" }).catch(() => null) : null;
    if (!it) return json({ error: "Entry not found" }, 404);
    const next =
      body.action === "clear"
        ? { ...it, status: "cleared", clearedAt: now }
        : { ...it, status: "open", clearedAt: null };
    await store.setJSON(id, next);
    return json({ ok: true, item: next });
  }

  return json({ error: "Unknown action" }, 400);
}

export default async (req) => handle(req, getStore("inventory"));

export const config = { path: "/api/inventory" };

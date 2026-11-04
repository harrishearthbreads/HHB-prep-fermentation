// Shared inventory for tools.harrishearthbreads.com (Inventory tab).
// Two Netlify Blobs stores, one blob per record so simultaneous edits never collide:
//   "inventory": one record per current line (key = id)
//   "catalog":   learned standardized item names (key = name with punctuation/case/spacing removed)
//
//   GET  /api/inventory                         -> { items:[open lines], catalog:[{name,category}] }
//   POST {action:"add", category,name,level,notes}
//        Standardizes the name against the catalog, overwrites any open line for the same item.
//   POST {action:"restock", id}   -> overwrites that line with a FULLY STOCKED line
//   POST {action:"undo", id}      -> undo a restock (id = the new FULLY STOCKED line)
import { getStore } from "@netlify/blobs";

const PIN = (typeof process !== "undefined" && process.env && process.env.INVENTORY_PIN) || "0214";
const LEVELS = ["URGENT", "LOW", "MEDIUM", "FULLY STOCKED"];
const KEEP_OVERWRITTEN_DAYS = 7; // overwritten lines are kept briefly so Undo works, never shown

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const clean = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
export const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function readAll(store) {
  const { blobs } = await store.list();
  return (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }).catch(() => null)))).filter(Boolean);
}

async function openLines(store) {
  const all = await readAll(store);
  const cutoff = Date.now() - KEEP_OVERWRITTEN_DAYS * 86400000;
  const open = [];
  for (const it of all) {
    if (it.status === "open") open.push(it);
    else {
      const at = Date.parse(it.supersededAt || it.updatedAt || it.createdAt || "") || 0;
      if (at < cutoff) await store.delete(it.id).catch(() => {});
    }
  }
  open.sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""));
  return open;
}

const newId = (now) => now.replace(/\D/g, "") + "-" + Math.random().toString(36).slice(2, 8);

export async function handle(req, store, catalog) {
  if (req.headers.get("x-hhb-pin") !== PIN) return json({ error: "Not authorized" }, 401);

  if (req.method === "GET") {
    const learned = (await readAll(catalog)).map((c) => ({ name: c.name, category: c.category }));
    return json({ items: await openLines(store), catalog: learned, serverTime: new Date().toISOString() });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const now = new Date().toISOString();

  if (body.action === "add") {
    const category = clean(body.category, 60);
    let name = clean(body.name, 80);
    const level = clean(body.level, 20).toUpperCase();
    const notes = clean(body.notes, 300);
    if (!category || !name || !norm(name)) return json({ error: "Category and item name are required" }, 400);
    if (!LEVELS.includes(level)) return json({ error: "Invalid level" }, 400);

    // Standardize: if this item (ignoring case, spacing, punctuation) is already known, use its name.
    const key = norm(name);
    const known = await catalog.get(key, { type: "json" }).catch(() => null);
    if (known) name = known.name;
    else await catalog.setJSON(key, { name, category, addedAt: now });

    for (const it of await openLines(store)) {
      if (norm(it.name) === key) await store.setJSON(it.id, { ...it, status: "superseded", supersededAt: now });
    }
    const id = newId(now);
    const item = { id, category, name, level, notes, status: "open", createdAt: now, updatedAt: now };
    await store.setJSON(id, item);
    return json({ ok: true, item });
  }

  if (body.action === "restock") {
    const id = clean(body.id, 80);
    const it = id ? await store.get(id, { type: "json" }).catch(() => null) : null;
    if (!it) return json({ error: "Entry not found" }, 404);
    if (it.status !== "open") return json({ error: "That line was already updated. Refresh to see the latest." }, 409);
    await store.setJSON(it.id, { ...it, status: "superseded", supersededAt: now });
    const nid = newId(now);
    const item = { id: nid, category: it.category, name: it.name, level: "FULLY STOCKED", notes: "", status: "open", createdAt: now, updatedAt: now, prevId: it.id };
    await store.setJSON(nid, item);
    return json({ ok: true, item });
  }

  if (body.action === "undo") {
    const id = clean(body.id, 80);
    const cur = id ? await store.get(id, { type: "json" }).catch(() => null) : null;
    if (!cur || !cur.prevId) return json({ error: "Nothing to undo" }, 404);
    if (cur.status !== "open") return json({ error: "That line was already updated by someone else." }, 409);
    const prev = await store.get(cur.prevId, { type: "json" }).catch(() => null);
    if (!prev) return json({ error: "Original line no longer available" }, 404);
    const { supersededAt, ...rest } = prev;
    await store.setJSON(prev.id, { ...rest, status: "open" });
    await store.delete(cur.id).catch(() => {});
    return json({ ok: true, item: { ...rest, status: "open" } });
  }

  return json({ error: "Unknown action" }, 400);
}

export default async (req) => handle(req, getStore("inventory"), getStore("catalog"));

export const config = { path: "/api/inventory" };

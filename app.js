(function () {
  "use strict";

  // ── localStorage keys ─────────────────────────────────────────
  const LS_STATE = "animLib.itemState";     // { [url]: {watched, favorite, note} }
  const LS_CUSTOM = "animLib.customItems";  // [ {t,u,s,tags,d,catId,subId,id} ]
  const LS_HIDDEN = "animLib.hiddenItems";  // [url]
  const LS_HIDDEN_CATS = "animLib.hiddenCats"; // [catId or subId]
  const LS_VERSION = "animLib.dataVersion";
  const LS_THEME = "animLib.theme";
  const LS_THUMB = "animLib.thumbCache"; // { [url]: youtube thumbnail_url } — playlist oEmbed results
  const LS_CUSTOM_CATS = "animLib.customCategories"; // [ {id, name, desc, parentId} ]
  const TRASH_ID = "trash"; // reserved top-level category id: holds categories removed via the UI
  const TRASH_ITEMS_ID = "trash-items"; // reserved sub-category under trash: holds individually-deleted items

  let itemState = loadJSON(LS_STATE, {});
  let customItems = loadJSON(LS_CUSTOM, []);
  let hiddenItems = new Set(loadJSON(LS_HIDDEN, []));
  let hiddenCats = new Set(loadJSON(LS_HIDDEN_CATS, []));
  let thumbCache = loadJSON(LS_THUMB, {});
  let customCategories = loadJSON(LS_CUSTOM_CATS, []);
  if (!customCategories.some(cc => cc.id === TRASH_ID)) {
    customCategories.push({ id: TRASH_ID, name: "🗑 휴지통", desc: "삭제된 카테고리 보관함", parentId: null });
    saveJSON(LS_CUSTOM_CATS, customCategories);
  }
  if (!customCategories.some(cc => cc.id === TRASH_ITEMS_ID)) {
    customCategories.push({ id: TRASH_ITEMS_ID, name: "개별 삭제된 항목", desc: "카테고리와 상관없이 개별적으로 삭제된 레퍼런스", parentId: TRASH_ID });
    saveJSON(LS_CUSTOM_CATS, customCategories);
  }

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function saveState() { saveJSON(LS_STATE, itemState); }
  function saveCustom() { saveJSON(LS_CUSTOM, customItems); }
  function saveHidden() { saveJSON(LS_HIDDEN, Array.from(hiddenItems)); }
  function saveHiddenCats() { saveJSON(LS_HIDDEN_CATS, Array.from(hiddenCats)); }
  function saveThumbCache() { saveJSON(LS_THUMB, thumbCache); }
  function saveCustomCategories() { saveJSON(LS_CUSTOM_CATS, customCategories); }

  // ── merge custom categories/subcategories into CATALOG ────────
  function applyCustomCategoryToCatalog(cc) {
    if (!cc.parentId) {
      if (CATALOG.categories.some(c => c.id === cc.id)) return true;
      CATALOG.categories.push({ id: cc.id, name: cc.name, desc: cc.desc || "", items: [], subcategories: [] });
      return true;
    }
    const parent = CATALOG.categories.find(c => c.id === cc.parentId);
    if (!parent) return false;
    if (!parent.subcategories) parent.subcategories = [];
    if (parent.subcategories.some(s => s.id === cc.id)) return true;
    parent.subcategories.push({ id: cc.id, name: cc.name, desc: cc.desc || "", items: [] });
    return true;
  }
  customCategories.forEach(cc => { if (!cc.parentId) applyCustomCategoryToCatalog(cc); });
  customCategories.forEach(cc => { if (cc.parentId) applyCustomCategoryToCatalog(cc); });

  // ── YouTube thumbnail helpers ──────────────────────────────
  function ytVideoId(url) {
    try {
      const u = new URL(url);
      if (/(^|\.)youtu\.be$/.test(u.hostname)) return u.pathname.slice(1).split("/")[0] || null;
      if (/(^|\.)youtube\.com$/.test(u.hostname)) {
        if (u.pathname === "/watch") return u.searchParams.get("v");
        if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || null;
        if (u.pathname === "/attribution_link") {
          const nested = u.searchParams.get("u");
          if (nested) {
            const nestedParams = new URLSearchParams(nested.split("?")[1] || "");
            return nestedParams.get("v");
          }
        }
      }
    } catch (e) {}
    return null;
  }
  function ytPlaylistId(url) {
    try {
      const u = new URL(url);
      if (/(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === "/playlist") return u.searchParams.get("list");
    } catch (e) {}
    return null;
  }
  function vimeoVideoId(url) {
    try {
      const u = new URL(url);
      if (/(^|\.)vimeo\.com$/.test(u.hostname)) {
        const m = u.pathname.match(/^\/(?:video\/)?(\d+)/);
        return m ? m[1] : null;
      }
    } catch (e) {}
    return null;
  }

  function getState(url) {
    return itemState[url] || { watched: false, favorite: false, note: "" };
  }
  function setState(url, patch) {
    itemState[url] = Object.assign(getState(url), patch);
    saveState();
  }

  // ── data version check (matches doc's auto-migration note) ────
  (function checkVersion() {
    const prev = localStorage.getItem(LS_VERSION);
    if (prev && prev !== CATALOG.updated) {
      console.info(`카탈로그가 ${prev} → ${CATALOG.updated} 로 갱신되었습니다. 저장된 상태(체크/즐겨찾기/메모)는 URL 기준으로 유지됩니다.`);
    }
    localStorage.setItem(LS_VERSION, CATALOG.updated);
  })();

  // ── flatten catalog into a working tree with stable node ids ──
  // node: { id, name, icon, desc, guide, noGuide, path:[...names], parent }
  // each item gets: _cat (top id), _sub (sub id or null), _key (url), featured, warn
  const nodes = {}; // id -> node meta
  const allItems = []; // flattened default items

  function starFlag(desc) { return /★/.test(desc || ""); }

  CATALOG.categories.forEach(cat => {
    nodes[cat.id] = { id: cat.id, name: cat.name, icon: cat.icon, desc: cat.desc, guide: cat.guide || null, noGuide: !!cat.noGuide, isTop: true, subIds: [] };
    (cat.items || []).forEach(it => pushItem(it, cat.id, null));
    (cat.subcategories || []).forEach(sub => {
      nodes[sub.id] = { id: sub.id, name: sub.name, icon: sub.icon, desc: sub.desc, guide: sub.guide || null, noGuide: !!sub.noGuide, isTop: false, parent: cat.id };
      nodes[cat.id].subIds.push(sub.id);
      (sub.items || []).forEach(it => pushItem(it, cat.id, sub.id));
    });
  });

  function pushItem(it, catId, subId) {
    allItems.push({
      t: it.t, u: it.u, s: it.s, tags: it.tags || [], d: it.d || "", thumb: it.thumb || null,
      _cat: catId, _sub: subId, featured: starFlag(it.d), custom: false,
    });
  }

  function registerCategoryNode(cc) {
    if (!cc.parentId) {
      nodes[cc.id] = { id: cc.id, name: cc.name, icon: "", desc: cc.desc || "", guide: null, noGuide: false, isTop: true, subIds: [] };
    } else if (nodes[cc.parentId]) {
      nodes[cc.id] = { id: cc.id, name: cc.name, icon: "", desc: cc.desc || "", guide: null, noGuide: false, isTop: false, parent: cc.parentId };
      nodes[cc.parentId].subIds.push(cc.id);
    }
  }

  // ── move a custom category (and its custom sub-categories/items) to trash ──
  function moveCategoryToTrash(id) {
    if (id === TRASH_ID) return;
    const node = nodes[id];
    if (!node) return;
    const idsToMove = [id];
    if (node.isTop) {
      customCategories.forEach(cc => { if (cc.parentId === id) idsToMove.push(cc.id); });
    }

    const affected = allMergedItems().filter(it => idsToMove.includes(it._cat) || (it._sub && idsToMove.includes(it._sub))).length;
    const msg = `"${node.name}" 카테고리를 휴지통으로 이동하시겠습니까?` + (affected ? `\n안에 있는 항목 ${affected}개도 함께 이동됩니다.` : "");
    if (!confirm(msg)) return;

    const trashCatalog = CATALOG.categories.find(c => c.id === TRASH_ID);
    idsToMove.forEach(rid => {
      const n = nodes[rid];
      if (!n) return;

      // remap items to their new (trash, rid) address before detaching
      if (n.isTop) {
        customItems.forEach(it => { if (it.catId === rid && !it.subId) { it.catId = TRASH_ID; it.subId = rid; } });
      } else {
        customItems.forEach(it => { if (it.catId === n.parent && it.subId === rid) { it.catId = TRASH_ID; } });
      }

      // detach from its current position
      if (n.isTop) {
        const idx = CATALOG.categories.findIndex(c => c.id === rid);
        if (idx !== -1) CATALOG.categories.splice(idx, 1);
      } else {
        const parent = CATALOG.categories.find(c => c.id === n.parent);
        if (parent && parent.subcategories) {
          const idx = parent.subcategories.findIndex(s => s.id === rid);
          if (idx !== -1) parent.subcategories.splice(idx, 1);
        }
        const parentNode = nodes[n.parent];
        if (parentNode && parentNode.subIds) {
          const idx2 = parentNode.subIds.indexOf(rid);
          if (idx2 !== -1) parentNode.subIds.splice(idx2, 1);
        }
      }
      hiddenCats.delete(rid);

      // re-attach as a sub-category under trash
      if (trashCatalog) {
        if (!trashCatalog.subcategories) trashCatalog.subcategories = [];
        if (!trashCatalog.subcategories.some(s => s.id === rid)) {
          trashCatalog.subcategories.push({ id: rid, name: n.name, desc: n.desc || "", items: [] });
        }
      }
      nodes[rid] = { id: rid, name: n.name, icon: "", desc: n.desc || "", guide: null, noGuide: false, isTop: false, parent: TRASH_ID };
      if (!nodes[TRASH_ID].subIds.includes(rid)) nodes[TRASH_ID].subIds.push(rid);

      // remember where it came from so it can be restored later
      const restoreWasTop = n.isTop;
      const restoreParentId = n.isTop ? null : n.parent;
      const ccEntry = customCategories.find(cc => cc.id === rid);
      if (ccEntry) {
        ccEntry.parentId = TRASH_ID;
        ccEntry.restoreWasTop = restoreWasTop;
        ccEntry.restoreParentId = restoreParentId;
      } else {
        customCategories.push({ id: rid, name: n.name, desc: n.desc || "", parentId: TRASH_ID, restoreWasTop, restoreParentId });
      }
    });

    if (idsToMove.includes(ui.selCat) || (ui.selSub && idsToMove.includes(ui.selSub))) {
      ui.selCat = null; ui.selSub = null;
    }

    saveCustom(); saveCustomCategories(); saveHiddenCats();
    renderAll();
  }

  // ── restore a trashed category (and any items in it) back to where it was ──
  function restoreCategory(id) {
    if (id === TRASH_ITEMS_ID) return;
    const entry = customCategories.find(cc => cc.id === id && cc.parentId === TRASH_ID);
    if (!entry) return;

    // if its original parent is itself still sitting in trash, restore that first
    const wantedParentId = entry.restoreWasTop ? null : entry.restoreParentId;
    if (wantedParentId && customCategories.some(cc => cc.id === wantedParentId && cc.parentId === TRASH_ID)) {
      restoreCategory(wantedParentId);
    }
    const finalParentId = (wantedParentId && nodes[wantedParentId] && nodes[wantedParentId].isTop) ? wantedParentId : null;

    // detach from trash
    const trashCatalog = CATALOG.categories.find(c => c.id === TRASH_ID);
    if (trashCatalog && trashCatalog.subcategories) {
      const idx = trashCatalog.subcategories.findIndex(s => s.id === id);
      if (idx !== -1) trashCatalog.subcategories.splice(idx, 1);
    }
    const trashNode = nodes[TRASH_ID];
    if (trashNode) {
      const idx2 = trashNode.subIds.indexOf(id);
      if (idx2 !== -1) trashNode.subIds.splice(idx2, 1);
    }

    // remap items sitting in this bucket to the restored location
    customItems.forEach(it => {
      if (it.catId === TRASH_ID && it.subId === id) {
        if (finalParentId) { it.catId = finalParentId; it.subId = id; }
        else { it.catId = id; it.subId = null; }
      }
    });

    // re-attach at the restored position
    if (finalParentId) {
      nodes[id] = { id, name: entry.name, icon: "", desc: entry.desc || "", guide: null, noGuide: false, isTop: false, parent: finalParentId };
      const parentCatalog = CATALOG.categories.find(c => c.id === finalParentId);
      if (parentCatalog) {
        if (!parentCatalog.subcategories) parentCatalog.subcategories = [];
        parentCatalog.subcategories.push({ id, name: entry.name, desc: entry.desc || "", items: [] });
      }
      if (nodes[finalParentId] && !nodes[finalParentId].subIds.includes(id)) nodes[finalParentId].subIds.push(id);
    } else {
      nodes[id] = { id, name: entry.name, icon: "", desc: entry.desc || "", guide: null, noGuide: false, isTop: true, subIds: [] };
      CATALOG.categories.push({ id, name: entry.name, desc: entry.desc || "", items: [], subcategories: [] });
    }

    entry.parentId = finalParentId;
    delete entry.restoreWasTop;
    delete entry.restoreParentId;

    if (ui.selCat === TRASH_ID && ui.selSub === id) { ui.selCat = null; ui.selSub = null; }

    saveCustom(); saveCustomCategories(); saveHiddenCats();
    renderAll();
  }

  // ── permanently delete everything currently sitting in trash ──
  // (the TRASH_ITEMS_ID bucket itself is a permanent fixture: only its contents are purged)
  function emptyTrash() {
    const trashNode = nodes[TRASH_ID];
    if (!trashNode) return;
    const idsToPurge = trashNode.subIds.filter(id => id !== TRASH_ITEMS_ID);
    const looseItemCount = customItems.filter(it => it.catId === TRASH_ID && it.subId === TRASH_ITEMS_ID).length;
    const categoryItemCount = allMergedItems().filter(it => it._cat === TRASH_ID && idsToPurge.includes(it._sub)).length;
    const totalAffected = looseItemCount + categoryItemCount;
    if (!idsToPurge.length && !looseItemCount) { alert("휴지통이 비어 있습니다."); return; }
    if (!confirm(`휴지통에 있는 카테고리 ${idsToPurge.length}개와 항목 ${totalAffected}개를 영구 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;

    customItems = customItems.filter(it => !(it.catId === TRASH_ID && it.subId === TRASH_ITEMS_ID));
    customItems = customItems.filter(it => !(it.catId === TRASH_ID && idsToPurge.includes(it.subId)));

    const trashCatalog = CATALOG.categories.find(c => c.id === TRASH_ID);
    if (trashCatalog && trashCatalog.subcategories) {
      trashCatalog.subcategories = trashCatalog.subcategories.filter(s => s.id === TRASH_ITEMS_ID);
    }
    idsToPurge.forEach(rid => { delete nodes[rid]; hiddenCats.delete(rid); });
    trashNode.subIds = trashNode.subIds.filter(id => id === TRASH_ITEMS_ID);

    customCategories = customCategories.filter(cc => !(cc.parentId === TRASH_ID && idsToPurge.includes(cc.id)));

    if (idsToPurge.includes(ui.selSub)) { ui.selCat = null; ui.selSub = null; }

    saveCustom(); saveCustomCategories(); saveHiddenCats();
    renderAll();
  }

  // ── move a single item to trash (default item: hide original + trash copy; custom item: relocate) ──
  function moveItemToTrash(it, key) {
    if (it.custom) {
      const existing = customItems.find(c => c.id === it.customId);
      if (!existing) return;
      existing.trashedFrom = { catId: existing.catId, subId: existing.subId || null };
      existing.catId = TRASH_ID;
      existing.subId = TRASH_ITEMS_ID;
    } else {
      hiddenItems.add(key);
      customItems.push({
        id: "c" + Date.now() + Math.random().toString(36).slice(2, 7),
        t: it.t, u: it.u, s: it.s, tags: it.tags, d: it.d, thumb: it.thumb || undefined,
        catId: TRASH_ID, subId: TRASH_ITEMS_ID,
        trashedFrom: { catId: it._cat, subId: it._sub || null },
        trashedOriginalKey: key,
      });
      saveHidden();
    }
    saveCustom();
    renderAll();
  }

  // ── restore a trashed item back to where it came from ──
  function restoreItem(customId) {
    const it = customItems.find(c => c.id === customId);
    if (!it) return;
    if (it.trashedFrom) {
      // individually-deleted item (moveItemToTrash)
      if (it.trashedOriginalKey) {
        hiddenItems.delete(it.trashedOriginalKey);
        customItems = customItems.filter(c => c.id !== customId);
        saveHidden();
      } else {
        it.catId = it.trashedFrom.catId;
        it.subId = it.trashedFrom.subId;
        delete it.trashedFrom;
      }
      saveCustom();
      renderAll();
      return;
    }
    if (it.catId === TRASH_ID && it.subId && it.subId !== TRASH_ITEMS_ID) {
      // item ended up here because its whole category was deleted — restore the category
      restoreCategory(it.subId);
    }
  }

  function allMergedItems() {
    return allItems.concat(customItems.map(c => ({
      t: c.t, u: c.u, s: c.s, tags: c.tags || [], d: c.d || "", thumb: c.thumb || null,
      _cat: c.catId, _sub: c.subId || null, featured: starFlag(c.d),
      custom: true, customId: c.id,
    })));
  }
  function itemKey(it) {
    return it.custom ? `custom:${it.customId}` : `default:${it._cat}:${it._sub || ""}:${it.u}`;
  }
  function currentItems() {
    return allMergedItems().filter(it => !hiddenItems.has(itemKey(it)) && !hiddenCats.has(it._cat) && !(it._sub && hiddenCats.has(it._sub)));
  }

  // ── UI state ────────────────────────────────────────────────
  const ui = {
    selCat: null,      // top category id or null (전체)
    selSub: null,       // subcategory id or null
    query: "",
    source: "전체",
    featuredOnly: false,
    unwatchedOnly: false,
    activeTag: null,
    openCats: new Set(CATALOG.categories.map(c => c.id)), // sidebar expand state
  };
  let renderedByKey = new Map(); // itemKey -> item, refreshed on every renderContent() call

  // ── DOM refs ────────────────────────────────────────────────
  const $sidebar = document.getElementById("sidebar");
  const $content = document.getElementById("content");
  const $search = document.getElementById("searchInput");
  const $statTotal = document.getElementById("statTotal");
  const $themeBtn = document.getElementById("themeBtn");
  const $addBtn = document.getElementById("addBtn");
  const $addCatBtn = document.getElementById("addCatBtn");
  const $exportBtn = document.getElementById("exportBtn");
  const $importInput = document.getElementById("importInput");
  const $modalRoot = document.getElementById("modalRoot");

  // ── theme ───────────────────────────────────────────────────
  (function initTheme() {
    const saved = localStorage.getItem(LS_THEME);
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  })();
  $themeBtn.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    const next = cur === "light" ? "dark" : "light";
    if (next === "light") document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
    localStorage.setItem(LS_THEME, next);
  });

  // ── sidebar rendering ───────────────────────────────────────
  function countFor(catId, subId) {
    return currentItems().filter(it => it._cat === catId && (subId ? it._sub === subId : true)).length;
  }

  function renderSidebar() {
    const total = currentItems().length;
    const allActive = ui.selCat === null;
    let html = `<div class="stats">전체 ${total}개 레퍼런스</div>`;
    html += `<div class="cat-row ${allActive ? "active" : ""}" data-cat="null"><span class="caret"></span><span class="name">전체</span><span class="count">${total}</span></div>`;
    CATALOG.categories.forEach(cat => {
      const open = ui.openCats.has(cat.id);
      const activeTop = ui.selCat === cat.id && !ui.selSub;
      const catChecked = !hiddenCats.has(cat.id);
      const isTrashRoot = cat.id === TRASH_ID;
      const catIsCustom = !isTrashRoot && customCategories.some(cc => cc.id === cat.id);
      html += `<div class="cat-node">`;
      html += `<div class="cat-row ${activeTop ? "active" : ""}" data-cat="${cat.id}">`
        + `<input type="checkbox" class="cat-check" data-catid="${cat.id}" ${catChecked ? "checked" : ""} title="체크 해제 시 이 카테고리 전체 숨김">`
        + (cat.subcategories && cat.subcategories.length ? `<span class="caret ${open ? "open" : ""}" data-toggle="${cat.id}">▶</span>` : `<span class="caret"></span>`)
        + `<span class="name">${cat.name}</span><span class="count">${countFor(cat.id)}</span>`
        + (catIsCustom ? `<button class="icon-btn cat-del" data-catdel="${cat.id}" title="카테고리 삭제(휴지통으로 이동)">🗑</button>` : "")
        + (isTrashRoot ? `<button class="icon-btn cat-empty-trash" data-empty-trash="1" title="휴지통 비우기(영구 삭제)">비우기</button>` : "")
        + `</div>`;
      if (cat.subcategories && cat.subcategories.length) {
        html += `<div class="sub-list ${open ? "" : "hidden"}">`;
        cat.subcategories.forEach(sub => {
          const activeSub = ui.selCat === cat.id && ui.selSub === sub.id;
          const subChecked = !hiddenCats.has(sub.id);
          const subIsCustom = !isTrashRoot && customCategories.some(cc => cc.id === sub.id);
          const subIsRestorable = isTrashRoot && sub.id !== TRASH_ITEMS_ID;
          html += `<div class="cat-row ${activeSub ? "active" : ""}" data-cat="${cat.id}" data-sub="${sub.id}">`
            + `<input type="checkbox" class="cat-check" data-catid="${sub.id}" ${subChecked ? "checked" : ""} title="체크 해제 시 이 카테고리 숨김">`
            + `<span class="caret"></span><span class="name">${sub.name}</span><span class="count">${countFor(cat.id, sub.id)}</span>`
            + (subIsCustom ? `<button class="icon-btn cat-del" data-catdel="${sub.id}" title="카테고리 삭제(휴지통으로 이동)">🗑</button>` : "")
            + (subIsRestorable ? `<button class="icon-btn restore-cat-btn" data-restorecat="${sub.id}" title="카테고리 복구">♻ 복구</button>` : "")
            + `</div>`;
        });
        html += `</div>`;
      }
      html += `</div>`;
    });
    $sidebar.innerHTML = html;

    $sidebar.querySelectorAll(".cat-check").forEach(el => {
      el.addEventListener("click", (e) => e.stopPropagation());
      el.addEventListener("change", () => {
        const id = el.getAttribute("data-catid");
        const setChecked = (catId, checked) => {
          if (checked) hiddenCats.delete(catId); else hiddenCats.add(catId);
        };
        setChecked(id, el.checked);
        const cat = CATALOG.categories.find(c => c.id === id);
        if (cat && cat.subcategories) {
          cat.subcategories.forEach(sub => setChecked(sub.id, el.checked));
        }
        saveHiddenCats();
        renderAll();
      });
    });
    $sidebar.querySelectorAll(".cat-del").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        moveCategoryToTrash(el.getAttribute("data-catdel"));
      });
    });
    $sidebar.querySelectorAll(".restore-cat-btn").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        restoreCategory(el.getAttribute("data-restorecat"));
      });
    });
    $sidebar.querySelectorAll(".cat-empty-trash").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        emptyTrash();
      });
    });
    $sidebar.querySelectorAll("[data-toggle]").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = el.getAttribute("data-toggle");
        if (ui.openCats.has(id)) ui.openCats.delete(id); else ui.openCats.add(id);
        renderSidebar();
      });
    });
    $sidebar.querySelectorAll(".cat-row").forEach(el => {
      el.addEventListener("click", () => {
        const cat = el.getAttribute("data-cat");
        const sub = el.getAttribute("data-sub");
        ui.selCat = cat === "null" || cat === null ? null : cat;
        ui.selSub = sub || null;
        ui.activeTag = null;
        renderAll();
      });
    });
  }

  // ── filtering / content rendering ──────────────────────────
  function getScopeItems() {
    let items = currentItems();
    if (ui.selCat) items = items.filter(it => it._cat === ui.selCat && (ui.selSub ? it._sub === ui.selSub : true));
    return items;
  }

  function getFilteredItems() {
    let items = getScopeItems();
    if (ui.query.trim()) {
      const q = ui.query.trim().toLowerCase();
      items = items.filter(it =>
        it.t.toLowerCase().includes(q) ||
        (it.d || "").toLowerCase().includes(q) ||
        (it.tags || []).some(tg => tg.toLowerCase().includes(q))
      );
    }
    if (ui.source !== "전체") items = items.filter(it => it.s === ui.source);
    if (ui.featuredOnly) items = items.filter(it => it.featured);
    if (ui.unwatchedOnly) items = items.filter(it => !getState(it.u).watched);
    if (ui.activeTag) items = items.filter(it => (it.tags || []).includes(ui.activeTag));
    return items;
  }

  function scopeNode() {
    if (ui.selSub) return nodes[ui.selSub];
    if (ui.selCat) return nodes[ui.selCat];
    return null;
  }

  function collectTags(items) {
    const map = new Map();
    items.forEach(it => (it.tags || []).forEach(tg => map.set(tg, (map.get(tg) || 0) + 1)));
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }

  function sourceList(items) {
    const set = new Set(items.map(it => it.s));
    return Array.from(set).sort();
  }

  function renderContent() {
    const node = scopeNode();
    const scopeItems = getScopeItems();
    const filtered = getFilteredItems();

    let html = "";
    if (node) {
      html += `<div class="crumbs">${node.isTop ? "" : nodes[node.parent].name + " › "}</div>`;
      html += `<div class="section-head"><h2>${node.name}</h2><span class="sub" style="color:var(--text-faint);font-size:12px;">${scopeItems.length}개</span></div>`;
      if (node.desc) html += `<div class="section-desc">${escapeHtml(node.desc)}</div>`;
    } else {
      html += `<div class="section-head"><h2>전체 레퍼런스</h2><span class="sub" style="color:var(--text-faint);font-size:12px;">${scopeItems.length}개</span></div>`;
      html += `<div class="section-desc">${escapeHtml(CATALOG.categories.map(c=>c.desc).length ? "카테고리를 선택하거나 검색/태그로 좁혀보세요." : "")}</div>`;
    }

    // guide panel
    if (node && node.guide && !node.noGuide) {
      const covered = new Set();
      scopeItems.forEach(it => (it.tags || []).forEach(tg => covered.add(tg)));
      html += `<details class="guide-panel" open><summary>🎯 표준 액션 세트 가이드 (${node.guide.filter(g => covered.has(g)).length}/${node.guide.length} 확보)</summary><div class="guide-grid">`;
      node.guide.forEach(g => {
        const has = covered.has(g);
        html += `<span class="guide-item ${has ? "covered" : "missing"}">${has ? "✓" : "✗"} ${escapeHtml(g)}</span>`;
      });
      html += `</div></details>`;
    }

    // filter row
    const sources = sourceList(scopeItems);
    html += `<div class="filter-row">`;
    html += `<div class="grp"><label>소스</label>` + ["전체"].concat(sources).map(s =>
      `<span class="chip ${ui.source === s ? "active" : ""}" data-source="${escapeAttr(s)}">${escapeHtml(s)}</span>`
    ).join("") + `</div>`;
    html += `<div class="grp"><span class="chip ${ui.featuredOnly ? "active" : ""}" data-featured="1">★ 추천만</span>`
      + `<span class="chip ${ui.unwatchedOnly ? "active" : ""}" data-unwatched="1">미확인만</span></div>`;
    if (ui.activeTag) html += `<div class="grp"><label>태그</label><span class="chip active" data-cleartag="1">${escapeHtml(ui.activeTag)} ✕</span></div>`;
    html += `</div>`;

    // tag cloud (top tags in scope)
    const tags = collectTags(scopeItems).slice(0, 24);
    if (tags.length) {
      html += `<div class="filter-row">` + tags.map(([tg, c]) =>
        `<span class="chip tag ${ui.activeTag === tg ? "active" : ""}" data-tag="${escapeAttr(tg)}">${escapeHtml(tg)} <span style="opacity:.6">${c}</span></span>`
      ).join("") + `</div>`;
    }

    // grid
    if (!filtered.length) {
      html += `<div class="empty-state">조건에 맞는 레퍼런스가 없습니다.</div>`;
    } else {
      html += `<div class="grid">` + filtered.map(cardHtml).join("") + `</div>`;
    }

    renderedByKey = new Map(filtered.map(it => [itemKey(it), it]));
    $content.innerHTML = html;
    wireContentEvents();
  }

  function thumbHtml(it) {
    const catIcon = (nodes[it._cat] && nodes[it._cat].icon) || "🎬";
    const isChannelBucket = !!(it._sub && it._sub.endsWith("-channel"));
    const vid = !isChannelBucket ? ytVideoId(it.u) : null;
    const plId = !vid && !isChannelBucket ? ytPlaylistId(it.u) : null;
    const vimeoId = !vid && !plId && !isChannelBucket ? vimeoVideoId(it.u) : null;
    const gifSrc = !vid && !plId && !vimeoId && !isChannelBucket && it.thumb && /\.gif(\?|$)/i.test(it.thumb) ? it.thumb : null;
    let img = "";
    let attrs = "";
    if (it.thumb) {
      img = `<img src="${escapeAttr(it.thumb)}" loading="lazy" alt="" onerror="this.remove()">`;
      if (plId) attrs = ` data-playlist-id="${escapeAttr(plId)}"`;
      else if (vid) attrs = ` data-video-id="${escapeAttr(vid)}"`;
      else if (vimeoId) attrs = ` data-vimeo-id="${escapeAttr(vimeoId)}"`;
      else if (gifSrc) attrs = ` data-gif-src="${escapeAttr(gifSrc)}"`;
    } else if (vid) {
      img = `<img src="https://i.ytimg.com/vi/${escapeAttr(vid)}/mqdefault.jpg" loading="lazy" alt="" onerror="this.remove()">`;
      attrs = ` data-video-id="${escapeAttr(vid)}"`;
    } else if (plId) {
      const cached = thumbCache[it.u];
      if (cached) img = `<img src="${escapeAttr(cached)}" loading="lazy" alt="" onerror="this.remove()">`;
      attrs = ` data-pl-url="${escapeAttr(it.u)}" data-playlist-id="${escapeAttr(plId)}"`;
    } else if (vimeoId) {
      attrs = ` data-vimeo-id="${escapeAttr(vimeoId)}"`;
    }
    return `<div class="card-thumb" data-url="${escapeAttr(it.u)}"${attrs}><span class="thumb-icon">${catIcon}</span>${img}<span class="thumb-play">▶</span></div>`;
  }

  function cardHtml(it) {
    const st = getState(it.u);
    return `
    <div class="card ${it.featured ? "featured" : ""} ${st.watched ? "watched" : ""}" data-url="${escapeAttr(it.u)}" data-key="${escapeAttr(itemKey(it))}">
      ${thumbHtml(it)}
      <div class="card-top">
        <div class="card-title">${it.featured ? '<span class="star">★</span>' : ""}<a href="${escapeAttr(it.u)}" target="_blank" rel="noopener">${escapeHtml(it.t)}</a></div>
        <div class="card-badges">${it.custom ? '<span class="custom-tag">내 항목</span>' : ""}</div>
      </div>
      ${it.tags && it.tags.length ? `<div class="card-tags">${it.tags.map(tg => `<span class="card-tag">${escapeHtml(tg)}</span>`).join("")}</div>` : ""}
      ${it.d ? `<div class="card-desc">${escapeHtml(it.d)}</div>` : ""}
      <div class="card-note"><textarea placeholder="메모 추가...">${escapeHtml(st.note || "")}</textarea></div>
      <div class="card-bottom">
        <div class="card-actions">
          <button class="icon-btn fav-btn ${st.favorite ? "on" : ""}" title="즐겨찾기">${st.favorite ? "⭐" : "☆"}</button>
          <button class="icon-btn watch-btn ${st.watched ? "on" : ""}" title="확인함">${st.watched ? "✔ 확인함" : "확인"}</button>
        </div>
        <div class="card-actions">
          ${it._cat === TRASH_ID
            ? `<button class="icon-btn restore-btn" data-id="${it.customId}" title="원래 카테고리로 복구">↩ 복구</button>`
            : `<button class="icon-btn move-btn" title="다른 카테고리로 이동">➜ 이동</button>`
              + (it.custom ? `<button class="icon-btn edit-btn" data-id="${it.customId}" title="편집">✎</button><button class="icon-btn danger del-btn" data-id="${it.customId}" title="삭제">🗑 삭제</button>`
                            : `<button class="icon-btn danger hide-btn" title="삭제">🗑 삭제</button>`)}
        </div>
      </div>
    </div>`;
  }

  let thumbObserver = null;
  function wirePlaylistThumbs() {
    if (thumbObserver) thumbObserver.disconnect();
    const targets = $content.querySelectorAll(".card-thumb[data-pl-url]");
    if (!targets.length) return;
    thumbObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        thumbObserver.unobserve(entry.target);
        fetchPlaylistThumb(entry.target);
      });
    }, { rootMargin: "200px" });
    targets.forEach(t => thumbObserver.observe(t));
  }
  async function fetchPlaylistThumb(el) {
    const url = el.getAttribute("data-pl-url");
    try {
      const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.thumbnail_url) {
        thumbCache[url] = data.thumbnail_url;
        saveThumbCache();
        const img = document.createElement("img");
        img.src = data.thumbnail_url;
        img.loading = "lazy";
        img.alt = "";
        img.onerror = () => img.remove();
        el.appendChild(img);
      }
    } catch (e) { /* offline or blocked — placeholder icon stays */ }
  }

  function wireContentEvents() {
    wirePlaylistThumbs();
    $content.querySelectorAll(".card-thumb").forEach(el => {
      el.addEventListener("click", () => {
        const videoId = el.getAttribute("data-video-id");
        const playlistId = el.getAttribute("data-playlist-id");
        const vimeoId = el.getAttribute("data-vimeo-id");
        const gifSrc = el.getAttribute("data-gif-src");
        if (videoId) openVideoModal({ type: "video", id: videoId });
        else if (playlistId) openVideoModal({ type: "playlist", id: playlistId });
        else if (vimeoId) openVideoModal({ type: "vimeo", id: vimeoId });
        else if (gifSrc) openImageModal(gifSrc);
        else window.open(el.getAttribute("data-url"), "_blank", "noopener");
      });
    });
    $content.querySelectorAll("[data-source]").forEach(el => el.addEventListener("click", () => { ui.source = el.getAttribute("data-source"); renderContent(); }));
    $content.querySelectorAll("[data-featured]").forEach(el => el.addEventListener("click", () => { ui.featuredOnly = !ui.featuredOnly; renderContent(); }));
    $content.querySelectorAll("[data-unwatched]").forEach(el => el.addEventListener("click", () => { ui.unwatchedOnly = !ui.unwatchedOnly; renderContent(); }));
    $content.querySelectorAll("[data-tag]").forEach(el => el.addEventListener("click", () => { ui.activeTag = el.getAttribute("data-tag"); renderContent(); }));
    $content.querySelectorAll("[data-cleartag]").forEach(el => el.addEventListener("click", () => { ui.activeTag = null; renderContent(); }));

    $content.querySelectorAll(".card").forEach(card => {
      const url = card.getAttribute("data-url");
      const key = card.getAttribute("data-key");
      const favBtn = card.querySelector(".fav-btn");
      const watchBtn = card.querySelector(".watch-btn");
      const hideBtn = card.querySelector(".hide-btn");
      const editBtn = card.querySelector(".edit-btn");
      const delBtn = card.querySelector(".del-btn");
      const moveBtn = card.querySelector(".move-btn");
      const restoreBtn = card.querySelector(".restore-btn");
      const note = card.querySelector(".card-note textarea");

      if (favBtn) favBtn.addEventListener("click", () => { setState(url, { favorite: !getState(url).favorite }); renderContent(); });
      if (watchBtn) watchBtn.addEventListener("click", () => { setState(url, { watched: !getState(url).watched }); renderContent(); });
      if (hideBtn) hideBtn.addEventListener("click", () => {
        if (confirm("이 레퍼런스를 휴지통으로 이동할까요?")) {
          const it = renderedByKey.get(key);
          if (it) moveItemToTrash(it, key);
        }
      });
      if (moveBtn) moveBtn.addEventListener("click", () => openMoveModal(key));
      if (editBtn) editBtn.addEventListener("click", () => openItemModal(customItems.find(c => c.id === editBtn.getAttribute("data-id"))));
      if (delBtn) delBtn.addEventListener("click", () => {
        if (confirm("이 항목을 휴지통으로 이동할까요?")) {
          const it = renderedByKey.get(key);
          if (it) moveItemToTrash(it, key);
        }
      });
      if (restoreBtn) restoreBtn.addEventListener("click", () => restoreItem(restoreBtn.getAttribute("data-id")));
      if (note) {
        let t;
        note.addEventListener("input", () => {
          clearTimeout(t);
          t = setTimeout(() => setState(url, { note: note.value }), 300);
        });
      }
    });
  }

  function renderAll() {
    renderSidebar();
    renderContent();
    $statTotal.textContent = `${currentItems().length} / ${allItems.length + customItems.length}개`;
  }

  // ── search ──────────────────────────────────────────────────
  let searchDebounce;
  $search.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { ui.query = $search.value; renderContent(); }, 150);
  });

  // ── add/edit modal ─────────────────────────────────────────
  function allCatOptions() {
    let opts = "";
    CATALOG.categories.forEach(cat => {
      if (cat.id === TRASH_ID) return;
      opts += `<option value="${cat.id}|">${cat.name}</option>`;
      (cat.subcategories || []).forEach(sub => {
        opts += `<option value="${cat.id}|${sub.id}">　└ ${sub.name}</option>`;
      });
    });
    return opts;
  }

  function openMoveModal(key) {
    const it = currentItems().find(x => itemKey(x) === key);
    if (!it) return;
    const modalHtml = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal">
        <h3>카테고리 이동</h3>
        <div class="field"><label>${escapeHtml(it.t)}</label></div>
        <div class="field"><label>이동할 카테고리</label>
          <select id="f_move_cat">${allCatOptions()}</select>
        </div>
        <div class="modal-actions">
          <button id="f_move_cancel">취소</button>
          <button id="f_move_save" class="primary">이동</button>
        </div>
      </div>
    </div>`;
    $modalRoot.innerHTML = modalHtml;
    const sel = document.getElementById("f_move_cat");
    sel.value = `${it._cat}|${it._sub || ""}`;

    document.getElementById("f_move_cancel").addEventListener("click", closeModal);
    document.getElementById("modalBackdrop").addEventListener("click", (e) => { if (e.target.id === "modalBackdrop") closeModal(); });
    document.getElementById("f_move_save").addEventListener("click", () => {
      const [catId, subId] = sel.value.split("|");
      if (it.custom) {
        const c = customItems.find(x => x.id === it.customId);
        if (c) {
          c.catId = catId; c.subId = subId || null;
          delete c.trashedFrom; delete c.trashedOriginalKey;
          saveCustom();
        }
      } else {
        hiddenItems.add(key);
        saveHidden();
        customItems.push({
          id: "c" + Date.now() + Math.random().toString(36).slice(2, 7),
          t: it.t, u: it.u, s: it.s, tags: it.tags, d: it.d, thumb: it.thumb || undefined,
          catId, subId: subId || null,
        });
        saveCustom();
      }
      closeModal();
      renderAll();
    });
  }

  function openAddCategoryModal() {
    const parentOptions = CATALOG.categories.filter(cat => cat.id !== TRASH_ID).map(cat => `<option value="${cat.id}">${cat.name}</option>`).join("");
    const modalHtml = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal">
        <h3>새 카테고리 만들기</h3>
        <div class="field"><label>카테고리 이름</label><input id="f_cat_name" placeholder="예: 크리처 채널"></div>
        <div class="field"><label>설명 (선택)</label><textarea id="f_cat_desc" placeholder="이 카테고리에 대한 설명"></textarea></div>
        <div class="field"><label>상위 카테고리</label>
          <select id="f_cat_parent">
            <option value="">없음 (최상위 카테고리로 추가)</option>
            ${parentOptions}
          </select>
        </div>
        <div class="modal-actions">
          <button id="f_cat_cancel">취소</button>
          <button id="f_cat_save" class="primary">추가</button>
        </div>
      </div>
    </div>`;
    $modalRoot.innerHTML = modalHtml;
    document.getElementById("f_cat_cancel").addEventListener("click", closeModal);
    document.getElementById("modalBackdrop").addEventListener("click", (e) => { if (e.target.id === "modalBackdrop") closeModal(); });
    document.getElementById("f_cat_save").addEventListener("click", () => {
      const name = document.getElementById("f_cat_name").value.trim();
      if (!name) { alert("카테고리 이름은 필수입니다."); return; }
      const desc = document.getElementById("f_cat_desc").value.trim();
      const parentId = document.getElementById("f_cat_parent").value || null;
      const cc = {
        id: "cc" + Date.now() + Math.random().toString(36).slice(2, 7),
        name, desc, parentId,
      };
      if (!applyCustomCategoryToCatalog(cc)) { alert("상위 카테고리를 찾을 수 없습니다."); return; }
      registerCategoryNode(cc);
      customCategories.push(cc);
      saveCustomCategories();
      if (!parentId) ui.openCats.add(cc.id);
      closeModal();
      renderAll();
    });
  }

  function openItemModal(existing) {
    const isEdit = !!existing;
    const val = existing || { t: "", u: "", s: "YouTube", tags: [], d: "", catId: CATALOG.categories[0].id, subId: "" };
    const modalHtml = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal">
        <h3>${isEdit ? "레퍼런스 편집" : "레퍼런스 추가"}</h3>
        <div class="field"><label>제목</label><input id="f_t" value="${escapeAttr(val.t)}" placeholder="제목"></div>
        <div class="field"><label>URL</label><input id="f_u" value="${escapeAttr(val.u)}" placeholder="https://..."></div>
        <div class="field"><label>소스 타입</label>
          <select id="f_s">
            ${["YouTube","게임 캡처","기타","Sketchfab"].map(s => `<option value="${s}" ${val.s===s?"selected":""}>${s}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>카테고리</label>
          <select id="f_cat">${allCatOptions()}</select>
        </div>
        <div class="field"><label>태그 (쉼표로 구분)</label><input id="f_tags" value="${escapeAttr((val.tags||[]).join(", "))}" placeholder="Walk, Idle, Attack"></div>
        <div class="field"><label>설명</label><textarea id="f_d">${escapeHtml(val.d || "")}</textarea></div>
        <div class="modal-actions">
          <button id="f_cancel">취소</button>
          <button id="f_save" class="primary">${isEdit ? "저장" : "추가"}</button>
        </div>
      </div>
    </div>`;
    $modalRoot.innerHTML = modalHtml;
    const sel = document.getElementById("f_cat");
    sel.value = `${val.catId || CATALOG.categories[0].id}|${val.subId || ""}`;

    document.getElementById("f_cancel").addEventListener("click", closeModal);
    document.getElementById("modalBackdrop").addEventListener("click", (e) => { if (e.target.id === "modalBackdrop") closeModal(); });
    document.getElementById("f_save").addEventListener("click", () => {
      const t = document.getElementById("f_t").value.trim();
      const u = document.getElementById("f_u").value.trim();
      if (!t || !u) { alert("제목과 URL은 필수입니다."); return; }
      const [catId, subId] = document.getElementById("f_cat").value.split("|");
      const s = document.getElementById("f_s").value;
      const tags = document.getElementById("f_tags").value.split(",").map(x => x.trim()).filter(Boolean);
      const d = document.getElementById("f_d").value.trim();

      if (isEdit) {
        Object.assign(existing, { t, u, s, tags, d, catId, subId: subId || null });
      } else {
        customItems.push({ id: "c" + Date.now() + Math.random().toString(36).slice(2, 7), t, u, s, tags, d, catId, subId: subId || null });
      }
      saveCustom();
      closeModal();
      renderAll();
    });
  }
  function closeModal() { $modalRoot.innerHTML = ""; }

  function openVideoModal({ type, id }) {
    const src = type === "playlist"
      ? `https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(id)}&autoplay=1`
      : type === "vimeo"
      ? `https://player.vimeo.com/video/${encodeURIComponent(id)}?autoplay=1`
      : `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1`;
    $modalRoot.innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal video-modal">
        <button class="icon-btn video-modal-close" id="videoModalClose" title="닫기">✕</button>
        <div class="video-modal-frame">
          <iframe src="${escapeAttr(src)}" title="video player" frameborder="0"
            allow="autoplay; encrypted-media; picture-in-picture; clipboard-write; web-share" allowfullscreen></iframe>
        </div>
      </div>
    </div>`;
    document.getElementById("videoModalClose").addEventListener("click", closeModal);
    document.getElementById("modalBackdrop").addEventListener("click", (e) => { if (e.target.id === "modalBackdrop") closeModal(); });
  }

  function openImageModal(src) {
    $modalRoot.innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal video-modal image-modal">
        <button class="icon-btn video-modal-close" id="videoModalClose" title="닫기">✕</button>
        <div class="video-modal-frame">
          <img src="${escapeAttr(src)}" alt="">
        </div>
      </div>
    </div>`;
    document.getElementById("videoModalClose").addEventListener("click", closeModal);
    document.getElementById("modalBackdrop").addEventListener("click", (e) => { if (e.target.id === "modalBackdrop") closeModal(); });
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $modalRoot.firstElementChild) closeModal(); });

  $addBtn.addEventListener("click", () => openItemModal(null));
  $addCatBtn.addEventListener("click", () => openAddCategoryModal());

  // ── export / import ────────────────────────────────────────
  $exportBtn.addEventListener("click", () => {
    const payload = {
      itemState, customItems,
      hiddenItems: Array.from(hiddenItems),
      hiddenCats: Array.from(hiddenCats),
      customCategories,
      exportedAt: new Date().toISOString(), catalogVersion: CATALOG.updated,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `anim-library-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $importInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.itemState) itemState = data.itemState;
        if (data.customItems) customItems = data.customItems;
        if (data.hiddenItems) hiddenItems = new Set(data.hiddenItems);
        if (data.hiddenCats) hiddenCats = new Set(data.hiddenCats);
        if (data.customCategories) {
          // merge: reuse an existing category (default or custom) with the same
          // name+parent instead of creating a duplicate; only add ones with no match.
          const idMap = {}; // incoming category id -> resolved id in this session
          const findExistingId = (name, parentId) => {
            for (const nid in nodes) {
              const n = nodes[nid];
              const isMatch = parentId ? (!n.isTop && n.parent === parentId) : n.isTop;
              if (isMatch && n.name === name) return nid;
            }
            return null;
          };
          const registerNew = (cc) => {
            registerCategoryNode(cc);
            applyCustomCategoryToCatalog(cc);
            customCategories.push(cc);
            idMap[cc.id] = cc.id;
          };
          data.customCategories.filter(cc => !cc.parentId).forEach(cc => {
            const existing = findExistingId(cc.name, null);
            if (existing) idMap[cc.id] = existing;
            else registerNew(cc);
          });
          data.customCategories.filter(cc => cc.parentId).forEach(cc => {
            const resolvedParent = idMap[cc.parentId] || cc.parentId;
            const existing = findExistingId(cc.name, resolvedParent);
            if (existing) idMap[cc.id] = existing;
            else registerNew(resolvedParent === cc.parentId ? cc : Object.assign({}, cc, { parentId: resolvedParent }));
          });
          customItems.forEach(it => {
            if (idMap[it.catId]) it.catId = idMap[it.catId];
            if (it.subId && idMap[it.subId]) it.subId = idMap[it.subId];
          });
        }
        saveState(); saveCustom(); saveHidden(); saveHiddenCats(); saveCustomCategories();
        renderAll();
        alert("가져오기 완료.");
      } catch (err) { alert("파일을 읽을 수 없습니다: " + err.message); }
      e.target.value = "";
    };
    reader.readAsText(file);
  });

  // ── utils ───────────────────────────────────────────────────
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(str) { return escapeHtml(str); }

  // ── init ────────────────────────────────────────────────────
  renderAll();
})();

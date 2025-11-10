// Shared cart helpers for listing pages.
// Provides: Cart.getCart, Cart.setCart, Cart.addItem, Cart.addItemByMeta, Cart.changeQtyByMeta, Cart.syncMenuButtons, Cart.updateCartCount
(function(){
  const KEY = 'tindo_cart';

  function getCart(){
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
    catch(e){ return []; }
  }
  function setCart(cart){
    localStorage.setItem(KEY, JSON.stringify(cart || []));
    // notify other tabs/pages
    try { window.dispatchEvent(new Event('storage')); } catch(e){}
  }

  function updateCartCount(){
    const cart = getCart();
    const total = cart.reduce((s,i)=>s + (i.qty||0), 0);
    // try to update common counter in index header
    const el = document.getElementById('cartCount');
    if(el) el.textContent = total;
    return total;
  }

  function addItemByDetails(name, price, image_url, restaurant_id){
    const cart = getCart();
    let existing = cart.find(i => i.name === name && i.restaurant_id === restaurant_id);
    if(existing){ existing.qty = (existing.qty || 0) + 1; }
    else { cart.push({ name, price: Number(price)||0, image_url: image_url||'', restaurant_id: restaurant_id||null, qty: 1 }); }
    setCart(cart);
    updateCartCount();
  }

  function addItemByMeta(menuId, restaurantId, name, price, image){
    const meta = (window.__menuIndex && window.__menuIndex[menuId]) || {};
    const itemName = name || meta.name || (`item-${menuId}`);
    const itemPrice = (typeof price === 'number') ? price : (meta.price || 0);
    const image_url = image || meta.image_url || '';
    const rest = (restaurantId !== undefined && restaurantId !== null) ? restaurantId : meta.restaurant_id || null;

    const cart = getCart();
    let existing = cart.find(i => i.name === itemName && i.restaurant_id === rest);
    if(existing) { existing.qty = (existing.qty || 0) + 1; }
    else { cart.push({ name: itemName, price: Number(itemPrice)||0, image_url, restaurant_id: rest, qty: 1 }); }
    setCart(cart);
    // update UI elements if present
    const btn = document.getElementById(`add-btn-${menuId}`);
    const qtyRow = document.getElementById(`qty-row-${menuId}`);
    const qtyEl = document.getElementById(`qty-${menuId}`);
    if(btn){ const lbl = btn.querySelector('.btn-label'); if(lbl) lbl.textContent = 'Added to Cart'; const span = document.createElement('span'); span.textContent = '👍'; span.className = 'thumb-float absolute right-3 -top-2 text-xl'; btn.appendChild(span); setTimeout(()=>{ try{ span.remove(); }catch(e){} }, 700); }
    if(qtyRow) qtyRow.classList.remove('hidden');
    if(qtyEl) qtyEl.textContent = String((existing && existing.qty) ? existing.qty : 1);
    updateCartCount();
  }

  function changeQtyByMeta(menuId, delta){
    const meta = (window.__menuIndex && window.__menuIndex[menuId]) || {};
    const name = meta.name || (`item-${menuId}`);
    const rest = meta.restaurant_id || null;
    const cart = getCart();
    const idx = cart.findIndex(i => i.name === name && i.restaurant_id === rest);
    if(idx === -1){ if(delta > 0) cart.push({ name, price: meta.price || 0, image_url: meta.image_url || '', restaurant_id: rest, qty: 1 }); }
    else { cart[idx].qty = Math.max(0, (cart[idx].qty || 0) + delta); if(cart[idx].qty === 0) cart.splice(idx,1); }
    setCart(cart);
    const qtyRow = document.getElementById(`qty-row-${menuId}`);
    const qtyEl = document.getElementById(`qty-${menuId}`);
    const qtyVal = (cart.find(i => i.name === name && i.restaurant_id === rest) || {}).qty || 0;
    if(qtyEl) qtyEl.textContent = String(qtyVal);
    if(qtyRow && qtyVal <= 0) qtyRow.classList.add('hidden');
    updateCartCount();
    // Ensure button labels and qty rows are consistent across the page
    try { syncMenuButtons(); } catch(e) {}
  }
  function syncMenuButtons(){
    const cart = getCart();
    document.querySelectorAll('[id^="add-btn-"]').forEach(btn => {
      const id = Number(btn.id.replace('add-btn-',''));
      const meta = window.__menuIndex && window.__menuIndex[id];
      if(!meta) return;
      const exists = cart.find(i => i.name === meta.name && i.restaurant_id === meta.restaurant_id);
      const lbl = btn.querySelector('.btn-label');
      const qtyRow = document.getElementById(`qty-row-${id}`);
      const qtyEl = document.getElementById(`qty-${id}`);
      if(exists){ if(lbl) lbl.textContent = 'Added to Cart'; if(qtyRow) qtyRow.classList.remove('hidden'); if(qtyEl) qtyEl.textContent = String(exists.qty); }
      else { if(lbl) lbl.textContent = 'Add to Cart'; if(qtyRow) qtyRow.classList.add('hidden'); }
    });
  }

  // expose API
  window.Cart = window.Cart || {};
  window.Cart.getCart = getCart;
  window.Cart.setCart = setCart;
  window.Cart.addItemByDetails = addItemByDetails;
  window.Cart.addItemByMeta = addItemByMeta;
  window.Cart.changeQtyByMeta = changeQtyByMeta;
  window.Cart.syncMenuButtons = syncMenuButtons;
  window.Cart.updateCartCount = updateCartCount;

  // Convenience globals (only if not already defined by page)
  if(!window.addToCart){ window.addToCart = function(itemName, price, imageUrl, restaurantId){ return addItemByDetails(itemName, price, imageUrl, restaurantId); }; }
  if(!window.addToCartUI){ window.addToCartUI = function(menuId, restaurantId, itemName, price, image){ return addItemByMeta(menuId, restaurantId, itemName, price, image); }; }
  if(!window.changeQtyUI){ window.changeQtyUI = changeQtyByMeta; }
  if(!window.syncMenuButtons){ window.syncMenuButtons = syncMenuButtons; }
  if(!window.updateCartCount){ window.updateCartCount = updateCartCount; }

  // keep UI in sync on load
  document.addEventListener('DOMContentLoaded', ()=>{ try{ syncMenuButtons(); updateCartCount(); }catch(e){} });
})();

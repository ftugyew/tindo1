/* js/scripts.js */
const SERVER = "http://localhost:5000"; // change if your backend runs elsewhere

// ---------- Auth helpers ----------
function getUser(){
  try { return JSON.parse(localStorage.getItem("user")); } catch(e){ return null; }
}
function saveUser(u){ localStorage.setItem("user", JSON.stringify(u)); }
function logout(){ localStorage.removeItem("user"); window.location.href = "login.html"; }

// ---------- Toast ----------
function showToast(msg, time=1800){
  let t = document.getElementById("toast");
  if(!t){ t = document.createElement("div"); t.id="toast"; document.body.appendChild(t); }
  t.innerText = msg; t.style.display = "block"; t.style.opacity = "1";
  setTimeout(()=>{ t.style.opacity=0; setTimeout(()=>t.style.display="none",300); }, time);
}

// ---------- Cart helpers ----------
function getCart(){ return JSON.parse(localStorage.getItem("cart")) || []; }
function saveCart(cart){ localStorage.setItem("cart", JSON.stringify(cart)); updateCartBadge(); }

function clearCart(){ localStorage.removeItem("cart"); updateCartBadge(); }

function updateCartBadge(){
  const cart = getCart();
  const count = cart.reduce((s,i)=>s + (i.quantity||1), 0);
  const el = document.getElementById("cart-badge");
  if(el) el.innerText = count;
}

// Adds an item; enforces single-restaurant cart: if cart exists and restaurant different, ask to clear
function addToCart(item){
  // item = { restaurant_id, menu_item_id, name, price, quantity }
  let cart = getCart();
  if(cart.length > 0 && cart[0].restaurant_id !== item.restaurant_id){
    if(!confirm("Your cart has items from another restaurant. Clear cart and add this item?")) return;
    cart = [];
  }
  const idx = cart.findIndex(ci => ci.menu_item_id === item.menu_item_id);
  if(idx >= 0){
    cart[idx].quantity = (cart[idx].quantity || 1) + (item.quantity || 1);
  } else {
    cart.push(Object.assign({quantity:1}, item));
  }
  saveCart(cart);
  showToast("Added to cart");
}

// change quantity
function changeQty(index, delta){
  let cart = getCart();
  if(!cart[index]) return;
  cart[index].quantity = (cart[index].quantity || 1) + delta;
  if(cart[index].quantity <= 0) cart.splice(index,1);
  saveCart(cart);
}

// remove item
function removeItem(index){
  let cart = getCart();
  cart.splice(index,1);
  saveCart(cart);
}

// totals
function calculateTotals(){
  const cart = getCart();
  const subtotal = cart.reduce((s,i)=>s + (i.price * (i.quantity||1)), 0);
  const deliveryFee = subtotal > 499 ? 0 : 30; // example rule
  const tax = +(subtotal * 0.05).toFixed(2);
  const total = +(subtotal + deliveryFee + tax).toFixed(2);
  return { subtotal, deliveryFee, tax, total };
}

// Apply promo (simple demo)
function applyPromo(code){
  // example: FOOD10 => 10% off
  const totals = calculateTotals();
  if(code === "FOOD10"){
    const discount = +(totals.subtotal * 0.10).toFixed(2);
    return { success:true, discount };
  }
  return { success:false, message:"Invalid promo" };
}

// ---------- Order placement ----------
async function placeOrderOnServer(payload){
  // payload: { user_id, restaurant_id, items, total_amount, address }
  try{
    const res = await fetch(`${SERVER}/api/orders`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });
    return res.json();
  } catch(e){
    console.error(e);
    return { error: "Network error" };
  }
}

// ---------- small helper to run page-transition on load ----------
document.addEventListener("DOMContentLoaded", () => {
  document.body.classList.add("page-transition");
  setTimeout(()=>document.body.classList.add("active"), 20);
  updateCartBadge();
});

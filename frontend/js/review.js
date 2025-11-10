// Tindo Reviews: 5-star modal for order rating
(function(){
  const BASE = 'http://localhost:5000';
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function el(html){ const d=document.createElement('div'); d.innerHTML=html.trim(); return d.firstElementChild; }

  const modalTpl = `
  <div id="reviewModal" class="fixed inset-0 z-[9999] hidden items-center justify-center bg-black/50">
    <div class="bg-white rounded-2xl w-[92%] max-w-md p-6 shadow-xl">
      <div class="flex items-start justify-between mb-3">
        <h3 class="text-lg font-semibold text-gray-800">Rate your order</h3>
        <button id="reviewCloseBtn" class="w-8 h-8 rounded-full text-gray-600 hover:bg-gray-100">×</button>
      </div>
      <div class="text-center">
        <div id="starRow" class="flex items-center justify-center gap-2 my-3 text-2xl">
          ${[1,2,3,4,5].map(n=>`<button class="star" data-val="${n}">☆</button>`).join('')}
        </div>
        <textarea id="reviewComment" rows="3" class="w-full border border-gray-200 rounded-xl p-3" placeholder="Add a comment (optional)"></textarea>
        <button id="reviewSubmitBtn" class="btn btn-primary w-full mt-4" data-ripple>Submit Review</button>
      </div>
    </div>
  </div>`;

  function ensureModal(){
    let m = document.getElementById('reviewModal');
    if (!m){
      m = el(modalTpl);
      document.body.appendChild(m);
      const close = m.querySelector('#reviewCloseBtn');
      close.addEventListener('click', ()=> hide());
      m.addEventListener('click', (e)=>{ if(e.target===m) hide(); });
      // star behavior
      const stars = m.querySelectorAll('.star');
      stars.forEach(btn=> btn.addEventListener('click', ()=>{
        const val = Number(btn.dataset.val);
        m.dataset.rating = String(val);
        stars.forEach((s,idx)=>{ s.textContent = (idx < val) ? '★' : '☆'; s.style.color = idx < val ? '#f59e0b' : '#9ca3af'; });
      }));
    }
    return m;
  }

  function show(orderId, restaurantId){
    const m = ensureModal();
    m.dataset.orderId = String(orderId);
    m.dataset.restaurantId = String(restaurantId || '');
    m.dataset.rating = '';
    m.querySelector('#reviewComment').value = '';
    m.classList.remove('hidden');
    m.classList.add('flex');
  }
  function hide(){
    const m = document.getElementById('reviewModal');
    if (!m) return;
    m.classList.add('hidden');
    m.classList.remove('flex');
  }

  async function submit(){
    const m = document.getElementById('reviewModal');
    if (!m) return;
    const orderId = m.dataset.orderId;
    const rating = Number(m.dataset.rating || '0');
    const comment = m.querySelector('#reviewComment').value.trim();
    if (!rating || rating < 1){ alert('Please select a rating'); return; }
    try{
      const res = await fetch(`${BASE}/api/orders/${encodeURIComponent(orderId)}/review`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ rating, comment })
      });
      const data = await res.json();
      if(!res.ok){ throw new Error(data.error || 'Review failed'); }
      // remember reviewed
      const mem = JSON.parse(localStorage.getItem('reviewedOrders')||'[]');
      if (!mem.includes(String(orderId))){ mem.push(String(orderId)); localStorage.setItem('reviewedOrders', JSON.stringify(mem)); }
      alert('Thanks for your feedback!');
      hide();
    } catch(e){
      alert(e.message);
    }
  }

  document.addEventListener('click', (e)=>{
    if (e.target && e.target.id === 'reviewSubmitBtn') submit();
  });

  // expose API
  window.TindoReview = { show, hide };
})();

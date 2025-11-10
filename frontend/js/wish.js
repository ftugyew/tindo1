/* Tindo Wish Animation - lightweight sparkle/confetti effect
   Usage:
   - Add data-wish to any clickable element (button, a, etc.)
   - Or call window.makeWish(x, y, opts)
   Accessibility:
   - Respects prefers-reduced-motion
   - Auto-disables if window.WISH_DISABLE === true
*/
(function(){
  const prefersReduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(prefersReduce || window.WISH_DISABLE){
    window.makeWish = function(){};
    return; // No-op on reduced motion
  }

  const COLORS = ['#10b981','#34d399','#059669','#f59e0b','#ef4444','#3b82f6','#a855f7','#ec4899'];
  const SHAPES = ['circle','square','star'];

  function rand(min, max){ return Math.random() * (max - min) + min; }
  function pick(arr){ return arr[(Math.random()*arr.length)|0]; }

  function createCanvas(){
    const c = document.createElement('canvas');
    c.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999;';
    document.body.appendChild(c);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ctx = c.getContext('2d');
    function resize(){
      c.width = Math.floor(window.innerWidth * dpr);
      c.height = Math.floor(window.innerHeight * dpr);
      ctx.setTransform(dpr,0,0,dpr,0,0); // draw in CSS pixels
    }
    resize();
    window.addEventListener('resize', resize);
    return { canvas:c, ctx, dpr, cleanup:()=>{ window.removeEventListener('resize', resize); c.remove(); } };
  }

  function drawStar(ctx, x, y, r, rot){
    ctx.save();
    ctx.translate(x,y); ctx.rotate(rot);
    ctx.beginPath();
    for(let i=0;i<5;i++){
      ctx.lineTo(Math.cos((18+i*72)/180*Math.PI)*r, -Math.sin((18+i*72)/180*Math.PI)*r);
      ctx.lineTo(Math.cos((54+i*72)/180*Math.PI)*r*0.5, -Math.sin((54+i*72)/180*Math.PI)*r*0.5);
    }
    ctx.closePath();
    ctx.restore();
  }

  function particleBurst(x, y, opts){
    const count = opts.count || 24;
    const gravity = opts.gravity ?? 0.25;
    const spread = opts.spread || Math.PI * 2; // full circle
    const speed = opts.speed || 6;
    const life = opts.life || 800; // ms

    const { canvas, ctx, cleanup } = createCanvas();
    const rect = { left:0, top:0 }; // canvas is full-screen

    const particles = Array.from({ length: count }).map(()=>{
      const angle = rand(-spread/2, spread/2);
      return {
        x, y,
        vx: Math.cos(angle) * (speed + rand(-2, 2)),
        vy: Math.sin(angle) * (speed + rand(-2, 2)) - rand(1, 2),
        rot: rand(0, Math.PI*2),
        vr: rand(-0.2, 0.2),
        size: rand(4, 8),
        color: pick(COLORS),
        shape: pick(SHAPES),
        alpha: 1,
      };
    });

    const start = performance.now();
    let raf = 0;
    function frame(now){
      const t = now - start;
      ctx.clearRect(0,0,canvas.width,canvas.height);
      for(const p of particles){
        p.vy += gravity * 0.25; // lighten gravity over time
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        // fade out
        p.alpha = Math.max(0, 1 - t / life);
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        ctx.strokeStyle = p.color;
        switch(p.shape){
          case 'square':
            ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot);
            ctx.fillRect(-p.size/2, -p.size/2, p.size, p.size);
            ctx.restore();
            break;
          case 'star':
            ctx.save();
            ctx.beginPath();
            drawStar(ctx, p.x, p.y, p.size, p.rot);
            ctx.fill();
            ctx.restore();
            break;
          default:
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size/2, 0, Math.PI*2);
            ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      if(t < life) raf = requestAnimationFrame(frame); else { cancelAnimationFrame(raf); cleanup(); }
    }
    raf = requestAnimationFrame(frame);
  }

  // Public API
  window.makeWish = function(x, y, options){
    try {
      // Clamp to viewport
      const cx = Math.max(0, Math.min(window.innerWidth, x));
      const cy = Math.max(0, Math.min(window.innerHeight, y));
      particleBurst(cx, cy, options || {});
    } catch(e){ console.warn('wish animation failed', e); }
  };

  // Auto-bind to elements with [data-wish]
  document.addEventListener('click', (e)=>{
    const el = e.target.closest('[data-wish]');
    if(!el) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width/2; 
    const y = rect.top + rect.height/2; 
    window.makeWish(x, y, {});
  }, true);

})();

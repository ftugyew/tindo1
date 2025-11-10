// Tindo UI interactions: ripple + scroll reveal

(function(){
  // Respect reduced motion
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Ripple effect on [data-ripple]
  function addRipple(e){
    const target = e.currentTarget;
    const rect = target.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size/2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size/2) + 'px';
    target.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  }

  function bindRipples(){
    if (prefersReduced) return;
    document.querySelectorAll('[data-ripple]').forEach(el => {
      if (!el.__hasRipple){
        el.addEventListener('click', addRipple);
        el.__hasRipple = true;
      }
    });
  }

  // Reveal on scroll for elements with .reveal
  function bindReveals(){
    if (prefersReduced) return;
    const els = document.querySelectorAll('.reveal');
    if (!els.length) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const el = entry.target;
          el.style.transition = 'transform .6s cubic-bezier(.2,.7,0,1), opacity .6s ease';
          el.style.transform = 'translateY(0)';
          el.style.opacity = '1';
          io.unobserve(el);
        }
      });
    }, { threshold: 0.15 });
    els.forEach(el => {
      el.style.transform = 'translateY(14px)';
      el.style.opacity = '0';
      io.observe(el);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindRipples();
    bindReveals();
    // Also bind on DOM changes (for dynamic lists)
    const mo = new MutationObserver(() => bindRipples());
    mo.observe(document.body, { childList: true, subtree: true });
  });
})();

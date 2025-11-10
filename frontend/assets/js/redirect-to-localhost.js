(function(){
  try {
    if (window.location.protocol === 'file:') {
      // Map file path to URL path under localhost:5000
      const pathParts = window.location.pathname.split('/');
      // Find index of the workspace folder name if present; fallback to last segment
      const fileName = pathParts[pathParts.length - 1] || '';
      // Prefer localhost port from env fallback
      const host = 'http://localhost:5000';
      const target = host + '/' + fileName;
      console.info('[redirect-to-local] Redirecting file:// to', target);
      window.location.replace(target);
    }
  } catch (e) { console.error('redirect-to-local failed', e); }
})();
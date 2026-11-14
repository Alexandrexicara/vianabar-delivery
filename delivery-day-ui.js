(() => {
  const STYLE = `
    /* Cabeçalho compacto: logo do comerciante à esquerda e nome ao lado. */
    #establishmentHeader{display:flex!important;flex-direction:row!important;align-items:center!important;justify-content:flex-start!important;gap:12px!important;text-align:left!important;min-width:0}
    #establishmentLogo{display:grid!important;grid-template-columns:auto minmax(0,1fr)!important;grid-template-rows:auto auto!important;align-items:center!important;column-gap:10px!important;row-gap:2px!important;min-width:0;flex:1 1 auto;text-align:left!important}
    #establishmentLogo > img,#establishmentLogo > #establishmentLogoImg,#establishmentLogo > .brand-mark{grid-column:1!important;grid-row:1 / span 2!important;align-self:center!important;justify-self:start!important;width:48px!important;height:48px!important;max-width:48px!important;max-height:48px!important;object-fit:contain!important;margin:0!important;flex:none!important}
    #establishmentLogo #establishmentName{grid-column:2!important;grid-row:1!important;min-width:0;overflow-wrap:anywhere;text-align:left!important;margin:0!important;line-height:1.2!important}
    #establishmentLogo #establishmentTagline{grid-column:2!important;grid-row:2!important;min-width:0;overflow-wrap:anywhere;text-align:left!important;margin:2px 0 0!important;line-height:1.25!important}
    #establishmentHeader .establishment-info,#establishmentHeader .user-info{flex:0 1 auto;min-width:0;text-align:right}
    @media(max-width:600px){#establishmentHeader{gap:8px!important;padding:10px 12px!important;flex-wrap:nowrap!important}#establishmentLogo{column-gap:8px!important}#establishmentLogo > img,#establishmentLogo > #establishmentLogoImg,#establishmentLogo > .brand-mark{width:40px!important;height:40px!important;max-width:40px!important;max-height:40px!important}#establishmentLogo #establishmentName{font-size:clamp(15px,4vw,19px)!important}#establishmentLogo #establishmentTagline{font-size:11px!important}#establishmentHeader .establishment-info{font-size:10px!important;max-width:42%;overflow-wrap:anywhere}}
    .dd-nav-controls{position:fixed;left:12px;bottom:max(12px,env(safe-area-inset-bottom));z-index:2147483001;display:flex;gap:8px;font:600 14px Arial,sans-serif}
    .dd-nav-controls button{border:1px solid rgba(212,255,0,.55);border-radius:999px;background:#071226;color:#fff;padding:11px 15px;box-shadow:0 5px 18px #0005;cursor:pointer}
    .dd-nav-controls button:active{transform:scale(.97)}
    .dd-nav-controls button:focus-visible{outline:3px solid #d4ff00;outline-offset:2px}
    .dd-nav-controls .dd-nav-forward{background:#d4ff00;color:#071226;border-color:#d4ff00}
    @media(max-width:480px){.dd-nav-controls{left:9px;bottom:max(9px,env(safe-area-inset-bottom))}.dd-nav-controls button{padding:10px 12px;font-size:13px}}
    @media print{.dd-nav-controls{display:none!important}}
    .dd-install-banner{position:fixed;z-index:2147483000;left:14px;right:14px;bottom:14px;max-width:520px;margin-left:auto;background:#071226;color:#fff;border:1px solid rgba(212,255,0,.45);border-radius:16px;padding:14px;box-shadow:0 10px 35px #0005;font:14px Arial,sans-serif;display:flex;gap:12px;align-items:center}
    .dd-install-copy{flex:1;min-width:0}.dd-install-copy strong{display:block;font-size:16px;margin-bottom:4px;color:#d4ff00}
    .dd-install-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}
    .dd-install-actions button{border:0;border-radius:8px;padding:9px 12px;font-weight:700;cursor:pointer}
    .dd-install-yes{background:#d4ff00;color:#071226}.dd-install-no{background:#26334a;color:#fff}
    @media(max-width:480px){.dd-install-banner{left:9px;right:9px;bottom:82px;padding:11px}.dd-install-actions button{padding:8px 10px}}
  `;
  // Não existe injeção de logo global no cabeçalho. O logo pertence à loja.
  function isMerchantPage() {
    return !!document.querySelector('#establishmentLogo, #establishmentName, #establishmentLogoImg, [data-merchant-slug], [data-merchant-id], .merchant-logo, .merchant-brand') ||
      /(?:^|[?&])(?:loja|merchant|store|slug)=/i.test(location.search) ||
      ['/delivery.html','/totem.html','/cozinha.html','/balcao.html','/garcom.html','/usuario.html'].includes(location.pathname);
  }

  function addNavigation() {
    if (document.querySelector('.dd-nav-controls')) return;
    const nav = document.createElement('nav');
    nav.className = 'dd-nav-controls';
    nav.setAttribute('aria-label', 'Navegação entre páginas');
    nav.innerHTML = '<button type="button" class="dd-nav-back" aria-label="Voltar à página anterior">← Voltar</button><button type="button" class="dd-nav-forward" aria-label="Avançar para a próxima página">Avançar →</button>';
    nav.querySelector('.dd-nav-back').addEventListener('click', () => {
      if (history.length > 1) history.back();
      else if (location.pathname !== '/' && location.pathname !== '/index.html') location.assign('/');
    });
    nav.querySelector('.dd-nav-forward').addEventListener('click', () => history.forward());
    document.body.appendChild(nav);
  }
  let installEvent = null;
  const key = 'dd-install-dismissed-until';
  function dismissed() { try { return Number(localStorage.getItem(key) || 0) > Date.now(); } catch (_) { return false; } }
  function hideBanner() { document.querySelector('.dd-install-banner')?.remove(); }
  function showBanner() {
    if (isMerchantPage()) return;
    if (dismissed() || window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) return;
    if (document.querySelector('.dd-install-banner')) return;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const banner = document.createElement('aside');
    banner.className = 'dd-install-banner';
    banner.innerHTML = '<div class="dd-install-copy"><strong>Instale o Delivery Day</strong><span>' +
      (ios ? 'Tenha o Delivery Day na tela inicial: toque em Compartilhar e depois em “Adicionar à Tela de Início”.' : 'Acesse mais rápido, em uma janela própria, como um aplicativo.') +
      '</span><div class="dd-install-actions"><button type="button" class="dd-install-yes">' + (ios ? 'Como instalar' : 'Instalar aplicativo') + '</button><button type="button" class="dd-install-no">Agora não</button></div></div>';
    banner.querySelector('.dd-install-no').addEventListener('click', () => {
      try { localStorage.setItem(key, String(Date.now() + 7 * 86400000)); } catch (_) {}
      hideBanner();
    });
    banner.querySelector('.dd-install-yes').addEventListener('click', async () => {
      if (installEvent) {
        installEvent.prompt();
        await installEvent.userChoice;
        installEvent = null;
        hideBanner();
      } else if (ios) {
        alert('No Safari: toque em Compartilhar e escolha “Adicionar à Tela de Início”.');
      } else {
        alert('Abra o menu do navegador e escolha “Instalar aplicativo” ou “Instalar Delivery Day”.');
      }
    });
    document.body.appendChild(banner);
  }
  const style = document.createElement('style'); style.textContent = STYLE; document.head.appendChild(style);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { addNavigation(); showBanner(); });
  else { addNavigation(); showBanner(); }
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installEvent = event; showBanner(); });
  window.addEventListener('appinstalled', hideBanner);
})();

/* Identidade visual: substitui emojis da interface por ícones Font Awesome consistentes. */
(() => {
  const ICONS = {
    '🍽':'utensils','⚙':'gear','🔍':'magnifying-glass','🥗':'leaf','🥤':'glass-water','🍰':'cake-candles',
    '📦':'box','🛒':'cart-shopping','📱':'mobile-screen','📘':'book-open','📷':'camera','🐦':'comment',
    '📋':'clipboard-list','🏪':'store','🏆':'trophy','🍕':'pizza-slice','🍔':'burger','💼':'briefcase',
    '💰':'money-bill-wave','💸':'money-bill-transfer','👥':'users','🏦':'building-columns','📊':'chart-column',
    '📅':'calendar-days','📈':'chart-line','💳':'credit-card','⚡':'bolt','📄':'file-lines','👁':'eye',
    '🗺':'map-location-dot','📍':'location-dot','🏁':'flag-checkered','📏':'ruler','🧹':'broom','❌':'xmark',
    '✅':'circle-check','⚠':'triangle-exclamation','🔥':'fire','🕒':'clock','🏠':'house','🚚':'truck-fast',
    '🛵':'motorcycle','🏍':'motorcycle','👨':'user','👍':'thumbs-up','🔔':'bell','🔊':'volume-high',
    '🔇':'volume-xmark','🛑':'octagon-stop','📞':'phone','🎉':'party-horn','💵':'money-bill-1',
    '💳':'credit-card','🏡':'house','👑':'crown','🎯':'bullseye','💾':'floppy-disk','🗑':'trash',
    '✏':'pen','➤':'arrow-right','✓':'check','✗':'xmark','★':'star','❤️':'heart','🎁':'gift',
    '🍟':'bowl-food','🍣':'fish','🍜':'bowl-rice','🍦':'ice-cream','🍺':'beer-mug-empty','☕':'mug-hot',
    '🥪':'bread-slice','🥩':'drumstick-bite','🥘':'bowl-food','🍱':'box','🍹':'martini-glass',
    '🧾':'receipt','💲':'dollar-sign','📝':'pen-to-square','🔄':'arrows-rotate','🔓':'lock-open',
    '🔒':'lock','🚀':'rocket','📡':'tower-broadcast','🧪':'flask','🧭':'compass','🧑':'user',
    '👋':'hand','💬':'comments','📦':'box','🛍':'bag-shopping','🧾':'receipt'
  };
  const pattern = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css';
  if (!document.querySelector('link[data-dd-icon-font]')) {
    style.dataset.ddIconFont = 'true';
    document.head.appendChild(style);
  }
  const iconClass = emoji => ICONS[emoji] || 'circle';
  function replaceTextNode(node) {
    if (!node || !node.parentNode || !pattern.test(node.nodeValue)) { pattern.lastIndex = 0; return; }
    pattern.lastIndex = 0;
    const value = node.nodeValue;
    const fragment = document.createDocumentFragment();
    let last = 0;
    value.replace(pattern, (emoji, offset) => {
      if (offset > last) fragment.appendChild(document.createTextNode(value.slice(last, offset)));
      const icon = document.createElement('i');
      icon.className = 'fa-solid fa-' + iconClass(emoji) + ' dd-professional-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.title = emoji;
      fragment.appendChild(icon);
      last = offset + emoji.length;
      return emoji;
    });
    if (last < value.length) fragment.appendChild(document.createTextNode(value.slice(last)));
    node.parentNode.replaceChild(fragment, node);
  }
  function scan(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest('script,style,textarea,input,select,option,code,pre,[contenteditable="true"],.dd-professional-icon')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(replaceTextNode);
  }
  const css = document.createElement('style');
  css.textContent = '.dd-professional-icon{display:inline-block;font-size:.9em;line-height:1;vertical-align:-.06em;margin-inline:.08em;color:inherit}';
  document.head.appendChild(css);
  const run = () => {
    scan(document.body);
    if (!window.__ddProfessionalIconsObserver) {
      window.__ddProfessionalIconsObserver = new MutationObserver(records => records.forEach(record => {
        record.addedNodes.forEach(node => {
          if (node.nodeType === Node.TEXT_NODE) replaceTextNode(node);
          else if (node.nodeType === Node.ELEMENT_NODE && !node.matches('script,style')) scan(node);
        });
      }));
      window.__ddProfessionalIconsObserver.observe(document.body, { childList: true, subtree: true });
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
})();

/* A marca da plataforma nunca é exibida nas páginas dos comerciantes. */
(() => {
  const isMerchantPage = () => !!document.querySelector('#establishmentLogo, #establishmentName, #establishmentLogoImg, [data-merchant-slug], [data-merchant-id], .merchant-logo, .merchant-brand') ||
    /(?:^|[?&])(?:loja|merchant|store|slug)=/i.test(location.search) ||
    ['/delivery.html','/totem.html','/cozinha.html','/balcao.html','/garcom.html','/usuario.html'].includes(location.pathname);
  const removePlatformMarks = () => {
    if (!isMerchantPage()) return;
    document.querySelectorAll('.dd-brand-wrap, .dd-brand-mark, .dd-install-banner, [data-platform-logo], .dd-platform-logo').forEach(el => el.remove());
  };
  removePlatformMarks();
  if (document.body && !window.__ddMerchantLogoGuard) {
    window.__ddMerchantLogoGuard = new MutationObserver(removePlatformMarks);
    window.__ddMerchantLogoGuard.observe(document.documentElement, {childList:true,subtree:true});
  }
})();

/* Imagens institucionais: splash e banner somente nas páginas da plataforma. */
(() => {
  const isMerchantPage = () => !!document.querySelector('#establishmentLogo, #establishmentName, #establishmentLogoImg, [data-merchant-slug], [data-merchant-id], .merchant-logo, .merchant-brand') ||
    /(?:^|[?&])(?:loja|merchant|store|slug)=/i.test(location.search) ||
    ['/delivery.html','/totem.html','/cozinha.html','/balcao.html','/garcom.html','/usuario.html'].includes(location.pathname);
  const endpoint = '/api/platform-branding';
  fetch(endpoint, { credentials:'same-origin', cache:'no-store' })
    .then(response => response.ok ? response.json() : null)
    .then(data => {
      if (!data?.images) return;
      // Nenhum elemento institucional pode aparecer nas páginas de comerciantes.
      if (isMerchantPage()) return;
      const splash = data.images.splash;
      if (splash) {
        const showPlatformSplash = () => {
          try { if (sessionStorage.getItem('dd-platform-splash-seen') === '1') return; sessionStorage.setItem('dd-platform-splash-seen','1'); } catch (_) {}
          if (document.querySelector('.dd-platform-splash')) return;
          const overlay = document.createElement('div');
          overlay.className = 'dd-platform-splash';
          overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#fff;display:flex;align-items:center;justify-content:center;opacity:1;transition:opacity .35s ease;';
          const image = document.createElement('img');
          image.src = splash + '?v=' + Date.now();
          image.alt = 'Delivery Day';
          image.style.cssText = 'max-width:88vw;max-height:78vh;object-fit:contain;';
          overlay.appendChild(image);
          document.body.appendChild(overlay);
          setTimeout(() => { overlay.style.opacity='0'; setTimeout(() => overlay.remove(), 400); }, 1400);
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showPlatformSplash, {once:true});
        else showPlatformSplash();
      }
      const login = data.images.loginBackground;
      if (login && /(?:login|acesso)/i.test(location.pathname)) {
        const applyLoginBackground = () => {
          document.body.style.backgroundImage = 'linear-gradient(rgba(0,0,0,.18),rgba(0,0,0,.18)),url("' + login + '?v=' + Date.now() + '")';
          document.body.style.backgroundSize = 'cover';
          document.body.style.backgroundPosition = 'center';
          document.body.style.backgroundAttachment = 'fixed';
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyLoginBackground, {once:true});
        else applyLoginBackground();
      }
      const banner = data.images.banner;
      if (banner && ['/', '/index.html', '/landing-page.html'].includes(location.pathname)) {
        const addPlatformBanner = () => {
          const header = document.querySelector('header');
          if (!header || document.querySelector('.dd-platform-banner')) return;
          const element = document.createElement('div');
          element.className = 'dd-platform-banner';
          element.setAttribute('aria-label','Banner principal do Delivery Day');
          element.style.cssText = 'width:100%;height:clamp(110px,22vw,230px);margin:12px 0 18px;background-image:url("' + banner + '?v=' + Date.now() + '");background-position:center;background-size:cover;background-repeat:no-repeat;border-radius:12px;';
          header.insertAdjacentElement('afterend',element);
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addPlatformBanner, {once:true});
        else addPlatformBanner();
      }
    })
    .catch(error => console.warn('[DELIVERY DAY] Identidade visual não carregada:', error));
})();

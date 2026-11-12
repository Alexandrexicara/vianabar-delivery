(() => {
  const LOGO = '/icons/delivery-day.svg';
  const STYLE = `
    .dd-brand-mark{width:124px;height:74px;object-fit:contain;flex:0 0 auto;display:block}
    .dd-brand-wrap{display:flex;align-items:center;gap:10px;min-width:0}
    .dd-brand-wrap img{width:124px;height:74px;object-fit:contain}
    .dd-nav-controls{position:fixed;left:12px;bottom:max(12px,env(safe-area-inset-bottom));z-index:2147483001;display:flex;gap:8px;font:600 14px Arial,sans-serif}
    .dd-nav-controls button{border:1px solid rgba(212,255,0,.55);border-radius:999px;background:#071226;color:#fff;padding:11px 15px;box-shadow:0 5px 18px #0005;cursor:pointer}
    .dd-nav-controls button:active{transform:scale(.97)}
    .dd-nav-controls button:focus-visible{outline:3px solid #d4ff00;outline-offset:2px}
    .dd-nav-controls .dd-nav-forward{background:#d4ff00;color:#071226;border-color:#d4ff00}
    @media(max-width:480px){.dd-brand-mark,.dd-brand-wrap img{width:108px;height:64px}.dd-nav-controls{left:9px;bottom:max(9px,env(safe-area-inset-bottom))}.dd-nav-controls button{padding:10px 12px;font-size:13px}}
    @media print{.dd-nav-controls{display:none!important}}
    .dd-install-banner{position:fixed;z-index:2147483000;left:14px;right:14px;bottom:14px;max-width:520px;margin-left:auto;background:#071226;color:#fff;border:1px solid rgba(212,255,0,.45);border-radius:16px;padding:14px;box-shadow:0 10px 35px #0005;font:14px Arial,sans-serif;display:flex;gap:12px;align-items:center}
    .dd-install-banner img{width:68px;height:50px;object-fit:contain;flex:0 0 auto}
    .dd-install-copy{flex:1;min-width:0}.dd-install-copy strong{display:block;font-size:16px;margin-bottom:4px;color:#d4ff00}
    .dd-install-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}
    .dd-install-actions button{border:0;border-radius:8px;padding:9px 12px;font-weight:700;cursor:pointer}
    .dd-install-yes{background:#d4ff00;color:#071226}.dd-install-no{background:#26334a;color:#fff}
    @media(max-width:480px){.dd-install-banner{left:9px;right:9px;bottom:82px;padding:11px}.dd-install-banner img{width:56px;height:42px}.dd-install-actions button{padding:8px 10px}}
  `;
  function addBrand() {
    const header = document.querySelector('header');
    if (!header || header.querySelector('.dd-brand-wrap') || header.querySelector('.dd-install-banner')) return;
    const img = document.createElement('img');
    img.src = LOGO; img.alt = 'Delivery Day'; img.className = 'dd-brand-mark';
    img.onerror = () => img.remove();
    const wrap = document.createElement('div');
    wrap.className = 'dd-brand-wrap';
    header.insertBefore(wrap, header.firstChild);
    wrap.appendChild(img);
    const original = header.querySelector('.logo, .header-title, #establishmentLogo, #establishmentName');
    if (original && original !== wrap) {
      if (original.parentElement && original.parentElement !== header && original.parentElement.children.length === 1) {
        wrap.appendChild(original);
      }
    }
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
    if (dismissed() || window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) return;
    if (document.querySelector('.dd-install-banner')) return;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const banner = document.createElement('aside');
    banner.className = 'dd-install-banner';
    banner.innerHTML = '<img src="' + LOGO + '" alt="Delivery Day"><div class="dd-install-copy"><strong>Instale o Delivery Day</strong><span>' +
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
  const pattern = /[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/gu;
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
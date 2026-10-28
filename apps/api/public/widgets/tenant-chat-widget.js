/**
 * KGT Solutions tenant chat widget — drop-in loader for any resold tenant
 * (see routes/tenantChat.routes.js, routes/publicRegister.routes.js). Unlike
 * sales-chat-widget.js (hardcoded to FLATBRIZ's own sales bot via an
 * iframe), this one is generic: it reads which tenant and which bot to talk
 * to from the script tag's own attributes, so the exact same file works for
 * every tenant this platform ever provisions.
 *
 * Embed with:
 *   <script src="https://api.kgt.solutions/widgets/tenant-chat-widget.js"
 *           data-tenant-id="acme-a1b2c3" data-api-key="tk_..." data-bot="sales" defer></script>
 * It talks to the host it was loaded from (see apiBase below for overrides).
 *
 * data-bot picks the bot this widget talks to, and is sent as botType on
 * every message so the API applies that bot's persona and knowledge weighting:
 *   "sales"   — public pages (landing, pricing, marketing)
 *   "support" — logged-in areas (dashboards, portals, help centers)
 * With data-bot set the widget is locked to that one bot (no toggle). An
 * unrecognised value falls back to support, with a console warning.
 *
 * data-tenant-id is the tenant's SLUG (returned as `slug` by
 * POST /api/v1/public/register/complete) — it addresses
 * /api/v1/tenant-chat/:slug/chat, which is the actual routing key; "tenant
 * id" here means "your public tenant identifier," not the internal DB id.
 *
 * Without data-bot (snippets issued before it existed), renders both bots
 * with a Support/Sales toggle in one widget (a visitor
 * can start on Support and switch to Sales without leaving the panel) —
 * default bot on open is configurable via data-default-bot ("support" or
 * "sales", defaults to "support"). No iframe: the widget calls the API
 * directly with fetch(), which works cross-origin because the API's CORS
 * policy (app.js) is already open to any origin.
 */
(function () {
  if (window.__kgtTenantChatLoaded) return;
  window.__kgtTenantChatLoaded = true;

  var currentScript = document.currentScript;
  if (!currentScript) return;

  var tenantSlug = currentScript.getAttribute('data-tenant-id');
  var apiKey = currentScript.getAttribute('data-api-key');
  var BOT_LABELS = { support: 'Support', sales: 'Sales' };
  var botAttr = currentScript.getAttribute('data-bot');
  var lockedBot = null; // set when the snippet names one bot: no toggle, every message goes to it
  if (botAttr !== null) {
    lockedBot = String(botAttr).trim().toLowerCase();
    if (!BOT_LABELS[lockedBot]) {
      console.warn('[kgt-chat-widget] data-bot must be "sales" or "support" — got "' + botAttr + '", using support.');
      lockedBot = 'support';
    }
  }
  var defaultBot = lockedBot || (currentScript.getAttribute('data-default-bot') === 'sales' ? 'sales' : 'support');
  // The API: data-api-base, else window.KGTChatConfig.apiBase (for a site
  // that sets it before loading the widget), else the host this script was
  // served from — the API itself. A script with no src (inlined or bundled
  // into the site's own JS) has no host to go by, so production. A local API
  // on a site that isn't local (a dev snippet copied into production) can
  // never be reached by a visitor, and is blocked by CSP: the script's own
  // host, or production, instead.
  var DEFAULT_API_BASE = 'https://api.kgt.solutions';
  var isLocalUrl = function (u) {
    try { return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(u, window.location.href).hostname); } catch (e) { return false; }
  };
  var scriptOrigin = currentScript.src ? new URL(currentScript.src, window.location.href).origin : null;
  var config = window.KGTChatConfig || {};
  var apiBase = currentScript.getAttribute('data-api-base') || config.apiBase || scriptOrigin || DEFAULT_API_BASE;
  if (isLocalUrl(apiBase) && !isLocalUrl(window.location.href)) {
    var fallback = scriptOrigin && !isLocalUrl(scriptOrigin) ? scriptOrigin : DEFAULT_API_BASE;
    console.warn('[kgt-chat-widget] ' + apiBase + ' is a local address, unreachable from this site; using ' + fallback + '. Re-copy the embed snippet from the dashboard.');
    apiBase = fallback;
  }
  apiBase = String(apiBase).replace(/\/+$/, '');

  if (!tenantSlug || !apiKey) {
    console.error('[kgt-chat-widget] data-tenant-id and data-api-key are both required.');
    return;
  }

  var ns = 'kgt-chat-' + tenantSlug.replace(/[^a-zA-Z0-9_-]/g, '');
  var botType = defaultBot;
  var sessionIds = {}; // botType -> sessionId, kept separate like the wizard's own test widget
  var open = false;
  var sending = false;

  // --- Language (English / Hindi) -------------------------------------
  // The widget's UI language: labels, the welcome greeting, placeholders. It
  // is NOT what the bot answers in — the backend answers in whatever language
  // the visitor actually typed (see engine/language.js) — but it is sent as a
  // hint so a too-short message ("ok") still comes back in the chosen one.
  // Remembered per browser (best-effort; private windows may throw).
  var LANG_KEY = ns + '-lang';
  var lang = 'en';
  try {
    var savedLang = window.localStorage.getItem(LANG_KEY);
    if (savedLang === 'en' || savedLang === 'hi') lang = savedLang;
  } catch (e) { /* storage unavailable: default to English */ }

  function setLang(next) {
    if (next !== 'en' && next !== 'hi') return;
    lang = next;
    try { window.localStorage.setItem(LANG_KEY, lang); } catch (e) { /* ignore */ }
    applyStaticStrings();
    renderTabs();
    renderMessages();
  }

  // All visitor-facing copy, per language. Bot answers and backend-generated
  // follow-up chips are not here — those arrive already in the right language.
  var STRINGS = {
    en: {
      titleSupport: 'Support', titleSales: 'Talk to sales',
      tabSupport: 'Support', tabSales: 'Sales',
      placeholder: 'Ask a question…', send: 'Send', close: 'Close',
      emptySupport: 'Need help? Ask anything — answers come from this company’s own content.',
      emptySales: 'Questions about plans, pricing or features? Ask away — answers come from this company’s own content.',
      langPrompt: 'Choose your language', suggested: 'Suggested questions',
      products: 'Products', inquire: 'Inquire', inquirePrefix: 'Tell me more about ', view: 'View product',
      errorGeneric: 'The bot could not respond.'
    },
    hi: {
      titleSupport: 'सहायता', titleSales: 'सेल्स से बात करें',
      tabSupport: 'सहायता', tabSales: 'सेल्स',
      placeholder: 'अपना सवाल पूछें…', send: 'भेजें', close: 'बंद करें',
      emptySupport: 'मदद चाहिए? कुछ भी पूछें — जवाब इसी कंपनी की अपनी जानकारी से आते हैं।',
      emptySales: 'प्लान, कीमत या फ़ीचर्स के बारे में सवाल हैं? बेझिझक पूछें — जवाब इसी कंपनी की अपनी जानकारी से आते हैं।',
      langPrompt: 'अपनी भाषा चुनें', suggested: 'सुझाए गए सवाल',
      products: 'उत्पाद', inquire: 'जानकारी लें', inquirePrefix: 'इसके बारे में और बताइए: ', view: 'उत्पाद देखें',
      errorGeneric: 'बॉट जवाब नहीं दे सका।'
    }
  };
  function t(key) { return (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || ''; }

  var style = document.createElement('style');
  style.textContent =
    '#' + ns + '-launcher{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;' +
    'background:#0f172a;border:none;box-shadow:0 8px 24px rgba(15,23,42,.35);cursor:pointer;' +
    'z-index:2147483000;display:flex;align-items:center;justify-content:center;transition:transform .15s ease;}' +
    '#' + ns + '-launcher:hover{transform:scale(1.06);}' +
    '#' + ns + '-launcher svg{width:26px;height:26px;fill:#fff;}' +
    '#' + ns + '-panel{position:fixed;bottom:88px;right:20px;width:360px;max-width:calc(100vw - 24px);' +
    'height:520px;max-height:calc(100vh - 120px);border-radius:18px;box-shadow:0 20px 48px rgba(6,10,26,.25);' +
    'z-index:2147483000;display:none;background:#fff;overflow:hidden;flex-direction:column;' +
    'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;}' +
    '#' + ns + '-panel.open{display:flex;}' +
    '@media (max-width:480px){#' + ns + '-panel{right:12px;bottom:84px;width:calc(100vw - 24px);height:calc(100vh - 110px);}}' +
    '#' + ns + '-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;' +
    'border-bottom:1px solid #e2e8f0;flex-shrink:0;}' +
    '#' + ns + '-tabs{display:flex;background:#f1f5f9;border-radius:8px;padding:2px;gap:2px;}' +
    '#' + ns + '-tabs button{border:none;background:transparent;font-size:12px;font-weight:600;padding:5px 10px;' +
    'border-radius:6px;cursor:pointer;color:#64748b;text-transform:capitalize;}' +
    '#' + ns + '-tabs button.active{background:#fff;color:#0f172a;box-shadow:0 1px 2px rgba(0,0,0,.08);}' +
    '#' + ns + '-title{font-size:13.5px;font-weight:600;color:#0f172a;}' +
    '#' + ns + '-close{border:none;background:none;cursor:pointer;color:#94a3b8;font-size:18px;line-height:1;padding:2px 6px;}' +
    '#' + ns + '-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;}' +
    '#' + ns + '-body .msg{max-width:85%;padding:8px 11px;border-radius:12px;font-size:13.5px;line-height:1.4;white-space:pre-line;}' +
    '#' + ns + '-body .msg.user{align-self:flex-end;background:#0f172a;color:#fff;}' +
    '#' + ns + '-body .msg.bot{align-self:flex-start;background:#f1f5f9;color:#0f172a;}' +
    '#' + ns + '-body .msg.bot p{margin:0 0 8px;}' +
    '#' + ns + '-body .msg.bot ul,#' + ns + '-body .msg.bot ol{margin:0 0 8px;padding-left:18px;}' +
    '#' + ns + '-body .msg.bot li{margin:0 0 4px;padding-left:2px;}' +
    '#' + ns + '-body .msg.bot > :last-child,#' + ns + '-body .msg.bot li:last-child{margin-bottom:0;}' +
    '#' + ns + '-body .msg.bot strong{font-weight:600;}' +
    '#' + ns + '-body .msg.err{align-self:flex-start;background:#fef2f2;color:#b91c1c;}' +
    '#' + ns + '-body .empty{margin:auto;text-align:center;color:#94a3b8;font-size:12.5px;padding:0 10px;}' +
    '#' + ns + '-body .chips{align-self:flex-start;display:flex;flex-wrap:wrap;gap:6px;max-width:92%;}' +
    '#' + ns + '-body .chip{border:1px solid #cbd5e1;background:#fff;color:#0f172a;border-radius:999px;' +
    'padding:5px 10px;font-size:12px;line-height:1.3;text-align:left;cursor:pointer;font-family:inherit;}' +
    '#' + ns + '-body .chip:hover{border-color:#0f172a;background:#f8fafc;}' +
    '#' + ns + '-form{display:flex;gap:8px;padding:10px;border-top:1px solid #e2e8f0;flex-shrink:0;}' +
    '#' + ns + '-input{flex:1;border:1px solid #cbd5e1;border-radius:8px;padding:8px 10px;font-size:13px;outline:none;}' +
    '#' + ns + '-input:focus{border-color:#0f172a;}' +
    '#' + ns + '-send{border:none;background:#0f172a;color:#fff;font-size:13px;font-weight:600;padding:0 14px;' +
    'border-radius:8px;cursor:pointer;}' +
    '#' + ns + '-send:disabled{opacity:.4;cursor:not-allowed;}' +
    // Product cards under a bot reply.
    '#' + ns + '-body .cards{align-self:flex-start;display:flex;flex-direction:column;gap:8px;max-width:92%;width:100%;}' +
    '#' + ns + '-body .pcard{display:flex;gap:10px;align-items:center;border:1px solid #e2e8f0;border-radius:12px;' +
    'padding:8px;background:#fff;}' +
    '#' + ns + '-body .pcard-img{width:48px;height:48px;border-radius:8px;object-fit:cover;flex-shrink:0;background:#f1f5f9;}' +
    '#' + ns + '-body .pcard-body{min-width:0;flex:1;}' +
    '#' + ns + '-body .pcard-name{font-size:12.5px;font-weight:600;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '#' + ns + '-body .pcard-price{font-size:12px;color:#334155;margin-top:1px;}' +
    '#' + ns + '-body .pcard-btn{display:inline-flex;align-items:center;border:1px solid #0f172a;background:#0f172a;' +
    'color:#fff;border-radius:8px;padding:6px 10px;font-size:11.5px;font-weight:600;cursor:pointer;' +
    'font-family:inherit;flex-shrink:0;text-decoration:none;}' +
    '#' + ns + '-body .pcard-btn:hover{opacity:.9;}' +
    // Header right side: the small EN/हिं language toggle beside the close button.
    '#' + ns + '-head-right{display:flex;align-items:center;gap:6px;}' +
    '#' + ns + '-lang{display:flex;gap:2px;background:#f1f5f9;border-radius:999px;padding:2px;}' +
    '#' + ns + '-lang button{border:none;background:transparent;font-size:11px;font-weight:700;' +
    'padding:3px 8px;border-radius:999px;cursor:pointer;color:#64748b;font-family:inherit;line-height:1.4;}' +
    '#' + ns + '-lang button.active{background:#fff;color:#0f172a;box-shadow:0 1px 2px rgba(0,0,0,.08);}' +
    // Prominent language picker shown on the welcome/FAQ (empty) view.
    '#' + ns + '-body .langpick{margin:auto;display:flex;flex-direction:column;gap:10px;align-items:center;' +
    'text-align:center;padding:0 10px;}' +
    '#' + ns + '-body .langpick .lp-title{color:#64748b;font-size:12.5px;font-weight:600;}' +
    '#' + ns + '-body .langpick .lp-row{display:flex;gap:8px;}' +
    '#' + ns + '-body .langpick button{border:1px solid #cbd5e1;background:#fff;color:#0f172a;border-radius:999px;' +
    'padding:8px 18px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;}' +
    '#' + ns + '-body .langpick button:hover{border-color:#0f172a;}' +
    '#' + ns + '-body .langpick button.active{background:#0f172a;color:#fff;border-color:#0f172a;}' +
    '#' + ns + '-body .langpick .lp-hint{color:#94a3b8;font-size:12px;line-height:1.4;}';
  document.head.appendChild(style);

  var launcher = document.createElement('button');
  launcher.id = ns + '-launcher';
  launcher.setAttribute('aria-label', lockedBot === 'sales' ? 'Chat with sales' : lockedBot === 'support' ? 'Get support' : 'Chat with us');
  launcher.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    '<path d="M12 2C6.48 2 2 6.02 2 11c0 2.61 1.28 4.94 3.29 6.6L4 22l4.78-1.46C9.79 20.83 10.88 21 12 21c5.52 0 10-4.02 10-9s-4.48-10-10-10z"/></svg>';

  var panel = document.createElement('div');
  panel.id = ns + '-panel';
  panel.innerHTML =
    '<div id="' + ns + '-head">' +
    (lockedBot
      ? '<div id="' + ns + '-title"></div>'
      : '<div id="' + ns + '-tabs">' +
        '<button type="button" data-bot="support"></button>' +
        '<button type="button" data-bot="sales"></button>' +
        '</div>') +
    '<div id="' + ns + '-head-right">' +
    '<div id="' + ns + '-lang" role="group" aria-label="Language">' +
    '<button type="button" data-lang="en">EN</button>' +
    '<button type="button" data-lang="hi">हिं</button>' +
    '</div>' +
    '<button type="button" id="' + ns + '-close">×</button>' +
    '</div>' +
    '</div>' +
    '<div id="' + ns + '-body"></div>' +
    '<form id="' + ns + '-form">' +
    '<input id="' + ns + '-input" type="text" autocomplete="off" />' +
    '<button id="' + ns + '-send" type="submit"></button>' +
    '</form>';

  var byBotMessages = { support: [], sales: [] };

  function renderTabs() {
    var buttons = panel.querySelectorAll('#' + ns + '-tabs button');
    for (var i = 0; i < buttons.length; i++) {
      var bot = buttons[i].getAttribute('data-bot');
      buttons[i].className = bot === botType ? 'active' : '';
      buttons[i].textContent = t(bot === 'sales' ? 'tabSales' : 'tabSupport');
    }
  }

  // Fills every fixed UI label from the current language and marks the active
  // language pill. Called on mount and whenever the language changes.
  function applyStaticStrings() {
    var title = panel.querySelector('#' + ns + '-title');
    if (title) title.textContent = t(lockedBot === 'sales' ? 'titleSales' : 'titleSupport');
    var input = panel.querySelector('#' + ns + '-input');
    if (input) input.setAttribute('placeholder', t('placeholder'));
    var send = panel.querySelector('#' + ns + '-send');
    if (send) send.textContent = t('send');
    var close = panel.querySelector('#' + ns + '-close');
    if (close) close.setAttribute('aria-label', t('close'));
    var langButtons = panel.querySelectorAll('#' + ns + '-lang button');
    for (var i = 0; i < langButtons.length; i++) {
      langButtons[i].className = langButtons[i].getAttribute('data-lang') === lang ? 'active' : '';
    }
  }

  function renderMessages() {
    var body = panel.querySelector('#' + ns + '-body');
    var msgs = byBotMessages[botType];
    body.innerHTML = '';
    // Welcome / FAQ view: a prominent language picker above the greeting, so
    // the first thing a visitor can do is choose English or हिंदी.
    if (!msgs.length) {
      body.appendChild(buildLangPicker());
      return;
    }
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var el = document.createElement('div');
      el.className = 'msg ' + (m.role === 'user' ? 'user' : m.error ? 'err' : 'bot');
      if (m.role === 'assistant' && !m.error) renderRichText(el, m.text);
      else el.textContent = m.text;
      body.appendChild(el);
      // Rich product cards the API matched to this reply.
      if (m.role === 'assistant' && !m.error && m.products && m.products.length) {
        body.appendChild(buildProductCards(m.products));
      }
    }
    // Suggested follow-ups under the latest reply only; clicking one asks it.
    var last = msgs[msgs.length - 1];
    if (!sending && last.role === 'assistant' && !last.error && last.followUps && last.followUps.length) {
      var chips = document.createElement('div');
      chips.className = 'chips';
      chips.setAttribute('aria-label', t('suggested'));
      for (var j = 0; j < last.followUps.length; j++) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.textContent = last.followUps[j];
        chip.addEventListener('click', function (e) { sendQuery(e.currentTarget.textContent); });
        chips.appendChild(chip);
      }
      body.appendChild(chips);
    }
    body.scrollTop = body.scrollHeight;
  }

  // Rich product cards for the items the API matched to a reply. Built with
  // createElement/textContent only (never innerHTML), so catalog data can't
  // inject markup into the host page; the image is a plain src attribute and
  // hides itself if it fails to load.
  function buildProductCards(products) {
    var wrap = document.createElement('div');
    wrap.className = 'cards';
    wrap.setAttribute('aria-label', t('products'));
    for (var i = 0; i < products.length; i++) {
      var p = products[i] || {};
      var card = document.createElement('div');
      card.className = 'pcard';
      if (p.imageUrl) {
        var img = document.createElement('img');
        img.className = 'pcard-img';
        img.src = p.imageUrl;
        img.alt = p.name || '';
        img.addEventListener('error', function (e) { e.currentTarget.style.display = 'none'; });
        card.appendChild(img);
      }
      var info = document.createElement('div');
      info.className = 'pcard-body';
      var name = document.createElement('div');
      name.className = 'pcard-name';
      name.textContent = p.name || '';
      info.appendChild(name);
      if (p.price) {
        var price = document.createElement('div');
        price.className = 'pcard-price';
        price.textContent = p.price;
        info.appendChild(price);
      }
      card.appendChild(info);
      // A direct purchase/product link when we have a safe http(s) URL;
      // otherwise an "Inquire" button that asks the bot about the item.
      var url = p.productUrl && /^https?:\/\//i.test(p.productUrl) ? p.productUrl : '';
      if (url) {
        var link = document.createElement('a');
        link.className = 'pcard-btn';
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = t('view');
        card.appendChild(link);
      } else {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pcard-btn';
        btn.textContent = t('inquire');
        (function (productName) {
          btn.addEventListener('click', function () { sendQuery(t('inquirePrefix') + productName); });
        })(p.name || '');
        card.appendChild(btn);
      }
      wrap.appendChild(card);
    }
    return wrap;
  }

  // The welcome/FAQ view's language picker: a label, the two language buttons
  // (active one highlighted), and the current bot's localized greeting below.
  function buildLangPicker() {
    var wrap = document.createElement('div');
    wrap.className = 'langpick';

    var title = document.createElement('div');
    title.className = 'lp-title';
    title.textContent = t('langPrompt');
    wrap.appendChild(title);

    var row = document.createElement('div');
    row.className = 'lp-row';
    [['en', 'English'], ['hi', 'हिंदी']].forEach(function (pair) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = pair[1];
      if (lang === pair[0]) b.className = 'active';
      b.addEventListener('click', function () { setLang(pair[0]); });
      row.appendChild(b);
    });
    wrap.appendChild(row);

    var hint = document.createElement('div');
    hint.className = 'lp-hint';
    hint.textContent = t(botType === 'sales' ? 'emptySales' : 'emptySupport');
    wrap.appendChild(hint);
    return wrap;
  }

  // Bot replies use a small formatting subset (engine/promptBuilder.js "HOW
  // TO LAY IT OUT"): paragraphs split by blank lines, "- " / "* " / "• "
  // bullets, "1." steps and **bold**. Built with createElement + textContent
  // only, never innerHTML, so nothing in a reply can inject markup into the
  // host page. Anything else (a stray "#" heading) degrades to plain text.
  function appendInline(parent, text) {
    var parts = String(text).split(/\*\*(.+?)\*\*/g); // odd indexes are the bold runs
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (i % 2) {
        var b = document.createElement('strong');
        b.textContent = parts[i];
        parent.appendChild(b);
      } else {
        parent.appendChild(document.createTextNode(parts[i]));
      }
    }
  }

  function renderRichText(container, text) {
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    var para = null;
    var list = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^\s*#{1,6}\s+/, '').trim();
      var bullet = /^[-*•]\s+(.*)$/.exec(line);
      var step = bullet ? null : /^(\d+)[.)]\s+(.*)$/.exec(line);
      if (!line) {
        para = null;
        list = null;
      } else if (bullet || step) {
        var tag = bullet ? 'ul' : 'ol';
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = document.createElement(tag);
          if (step && step[1] !== '1') list.setAttribute('start', step[1]);
          container.appendChild(list);
        }
        var li = document.createElement('li');
        appendInline(li, bullet ? bullet[1] : step[2]);
        list.appendChild(li);
        para = null;
      } else {
        if (!para) {
          para = document.createElement('p');
          container.appendChild(para);
        } else {
          para.appendChild(document.createElement('br'));
        }
        appendInline(para, line);
        list = null;
      }
    }
  }

  function setOpen(next) {
    open = next;
    panel.className = open ? 'open' : '';
    if (open) renderMessages();
  }

  launcher.addEventListener('click', function () { setOpen(!open); });
  panel.querySelector('#' + ns + '-close').addEventListener('click', function () { setOpen(false); });

  var tabButtons = panel.querySelectorAll('#' + ns + '-tabs button');
  for (var ti = 0; ti < tabButtons.length; ti++) {
    tabButtons[ti].addEventListener('click', function (e) {
      botType = e.currentTarget.getAttribute('data-bot');
      renderTabs();
      renderMessages();
    });
  }

  var langButtons = panel.querySelectorAll('#' + ns + '-lang button');
  for (var li = 0; li < langButtons.length; li++) {
    langButtons[li].addEventListener('click', function (e) {
      setLang(e.currentTarget.getAttribute('data-lang'));
    });
  }

  panel.querySelector('#' + ns + '-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = panel.querySelector('#' + ns + '-input');
    if (sendQuery(input.value)) input.value = '';
  });

  // Sends one question to the current bot. Used by the form and the
  // follow-up chips. Returns false if there was nothing to send.
  function sendQuery(text) {
    var query = String(text || '').trim();
    if (!query || sending) return false;
    sending = true;
    panel.querySelector('#' + ns + '-send').disabled = true;
    // The bot this message went to. The visitor may switch tabs before the
    // reply arrives; the reply and its sessionId still belong to this bot.
    var sentBot = botType;
    byBotMessages[sentBot].push({ role: 'user', text: query });
    renderMessages();

    fetch(apiBase + '/api/v1/tenant-chat/' + encodeURIComponent(tenantSlug) + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-api-key': apiKey },
      // language: the selected UI language — authoritative, so the bot
      // replies in it whatever language the question is typed in.
      body: JSON.stringify({ query: query, botType: sentBot, sessionId: sessionIds[sentBot], language: lang })
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (result) {
        if (!result.ok) throw new Error(result.data && result.data.error ? result.data.error : t('errorGeneric'));
        sessionIds[sentBot] = result.data.sessionId;
        byBotMessages[sentBot].push({ role: 'assistant', text: result.data.answer, followUps: result.data.followUps || [], products: result.data.products || [] });
      })
      .catch(function (err) {
        byBotMessages[sentBot].push({ role: 'assistant', text: err.message, error: true });
      })
      .finally(function () {
        sending = false;
        panel.querySelector('#' + ns + '-send').disabled = false;
        renderMessages();
      });
    return true;
  }

  // Leaving the page ends this widget's conversations (sessionIds live only
  // in memory), so tell the API: it summarizes them now instead of after the
  // idle delay. keepalive lets the request outlive the page; sendBeacon can't
  // carry the API key header. Best-effort: the idle sweep covers a miss, and
  // a page restored from the back/forward cache simply carries on chatting.
  window.addEventListener('pagehide', function () {
    for (var bot in sessionIds) {
      if (!sessionIds[bot]) continue;
      try {
        fetch(apiBase + '/api/v1/tenant-chat/' + encodeURIComponent(tenantSlug) + '/session/end', {
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json', 'x-tenant-api-key': apiKey },
          body: JSON.stringify({ sessionId: sessionIds[bot] })
        }).catch(function () {});
      } catch (e) { /* keepalive unsupported: the idle sweep summarizes it */ }
    }
  });

  function mount() {
    document.body.appendChild(panel);
    document.body.appendChild(launcher);
    applyStaticStrings();
    renderTabs();
  }

  if (document.body) {
    mount();
  } else {
    document.addEventListener('DOMContentLoaded', mount);
  }
})();

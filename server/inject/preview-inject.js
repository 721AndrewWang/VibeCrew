// Injected into every page shown in the Crew preview.
// Talks to the Crew window (the iframe parent) via postMessage:
// console capture, navigation tracking, element picking, demo recording, live reload.
(() => {
  if (window.__crew) return;
  var cfg = window.__CREW_CFG__ || {};
  var inFrame = window.parent !== window;
  var hostOrigin = null;
  var outbox = [];
  var MAX_TEXT = 4000;
  window.__crew = { version: 1 };

  function post(msg) {
    if (!inFrame) return;
    msg.__crew = true;
    if (!hostOrigin) {
      if (outbox.length < 200) outbox.push(msg);
      return;
    }
    try {
      window.parent.postMessage(msg, hostOrigin);
    } catch {
      /* ignore */
    }
  }

  function announce(type) {
    if (!inFrame) return;
    // Only the URL and title go out before the host introduces itself.
    try {
      window.parent.postMessage({ __crew: true, type: type, url: location.href, title: document.title }, '*');
    } catch {
      /* ignore */
    }
  }

  // ---------- serialization ----------
  function describeNode(n) {
    if (!n?.tagName) return String(n);
    var s = '<' + n.tagName.toLowerCase();
    if (n.id) s += '#' + n.id;
    if (typeof n.className === 'string' && n.className.trim()) s += '.' + n.className.trim().split(/\s+/).slice(0, 3).join('.');
    return s + '>';
  }

  function fmt(v, depth) {
    depth = depth || 0;
    try {
      if (v instanceof Error) return (v.name || 'Error') + ': ' + v.message + (v.stack ? '\n' + String(v.stack).split('\n').slice(1, 6).join('\n') : '');
      if (v === null) return 'null';
      if (v === undefined) return 'undefined';
      if (typeof v === 'string') return v;
      if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
      if (typeof v !== 'object') return String(v);
      if (v.nodeType === 1) return describeNode(v);
      if (depth > 0) return Array.isArray(v) ? '[Array(' + v.length + ')]' : '{…}';
      var seen = [];
      return JSON.stringify(
        v,
        (_k, val) => {
          if (val && typeof val === 'object') {
            if (seen.indexOf(val) >= 0) return '[Circular]';
            seen.push(val);
            if (val.nodeType === 1) return describeNode(val);
          }
          if (typeof val === 'function') return '[Function]';
          return val;
        },
        0,
      );
    } catch {
      return String(v);
    }
  }

  function clip(s, n) {
    s = String(s == null ? '' : s);
    n = n || MAX_TEXT;
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function sendConsole(level, text, source) {
    post({ type: 'console', entry: { level: level, text: clip(text), ts: Date.now(), source: source || undefined } });
  }

  // ---------- console capture ----------
  ['error', 'warn', 'info', 'log'].forEach((level) => {
    var orig = console[level];
    if (typeof orig !== 'function') return;
    console[level] = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i]));
        var text = parts.join(' ');
        if (text.indexOf('[vite]') !== 0 || level === 'error') sendConsole(level, text);
      } catch {
        /* ignore */
      }
      return orig.apply(this, arguments);
    };
  });

  window.addEventListener(
    'error',
    (ev) => {
      try {
        var t = ev.target;
        if (t && t !== window && t.tagName) {
          var url = t.src || t.href || '';
          sendConsole('error', '资源加载失败: ' + describeNode(t) + (url ? ' ' + url : ''));
          return;
        }
        var loc = ev.filename ? ev.filename.replace(location.origin, '') + ':' + ev.lineno + ':' + ev.colno : '';
        sendConsole('error', 'Uncaught ' + (ev.error ? fmt(ev.error) : ev.message), loc);
      } catch {
        /* ignore */
      }
    },
    true,
  );

  window.addEventListener('unhandledrejection', (ev) => {
    sendConsole('error', 'Unhandled promise rejection: ' + fmt(ev.reason));
  });

  if (window.fetch) {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var method = init?.method || input?.method || 'GET';
      var url = typeof input === 'string' ? input : input?.url || String(input);
      return origFetch.apply(this, arguments).then(
        (res) => {
          if (res.status >= 400 && url.indexOf('/__crew') < 0) sendConsole('warn', '[network] ' + res.status + ' ' + method.toUpperCase() + ' ' + url);
          return res;
        },
        (err) => {
          sendConsole('error', '[network] ' + method.toUpperCase() + ' ' + url + ' 失败: ' + fmt(err));
          throw err;
        },
      );
    };
  }

  if (window.XMLHttpRequest) {
    var xo = XMLHttpRequest.prototype.open;
    var xs = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__vc = { m: m, u: u };
      return xo.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('loadend', () => {
        if (!this.__vc) return;
        if (this.status === 0) sendConsole('error', '[network] ' + this.__vc.m + ' ' + this.__vc.u + ' 失败');
        else if (this.status >= 400) sendConsole('warn', '[network] ' + this.status + ' ' + this.__vc.m + ' ' + this.__vc.u);
      });
      return xs.apply(this, arguments);
    };
  }

  // ---------- navigation ----------
  var lastUrl = location.href;
  function navChanged() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    post({ type: 'nav', url: location.href, title: document.title });
    if (recording) record({ type: 'navigate', url: location.pathname + location.search + location.hash });
  }
  ['pushState', 'replaceState'].forEach((fn) => {
    var orig = history[fn];
    history[fn] = function () {
      var r = orig.apply(this, arguments);
      setTimeout(navChanged, 0);
      return r;
    };
  });
  window.addEventListener('popstate', navChanged);
  window.addEventListener('hashchange', navChanged);

  // Keep the scroll position across live reloads.
  var SCROLL_KEY = '__crew_scroll:' + location.pathname;
  try {
    var saved = sessionStorage.getItem(SCROLL_KEY);
    if (saved) {
      sessionStorage.removeItem(SCROLL_KEY);
      var y = parseInt(saved, 10) || 0;
      var restore = () => {
        window.scrollTo(0, y);
      };
      if (document.readyState === 'complete') restore();
      else window.addEventListener('load', restore);
    }
  } catch {
    /* ignore */
  }

  function reloadKeepingScroll() {
    try {
      sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
    } catch {
      /* ignore */
    }
    location.reload();
  }

  // ---------- live reload (static projects) ----------
  if (cfg.liveReload && window.EventSource) {
    try {
      var es = new EventSource('/__crew/events');
      es.onmessage = (ev) => {
        var data = {};
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (data.type !== 'change') return;
        var paths = data.paths || [];
        var cssOnly = paths.length > 0 && paths.every((p) => /\.css$/i.test(p));
        if (cssOnly) {
          var links = document.querySelectorAll('link[rel="stylesheet"]');
          for (var i = 0; i < links.length; i++) {
            var href = links[i].getAttribute('href');
            if (!href || (/^(https?:)?\/\//.test(href) && href.indexOf(location.host) < 0)) continue;
            links[i].setAttribute('href', href.replace(/([?&])__vc=\d+/, '$1').replace(/[?&]$/, '') + (href.indexOf('?') >= 0 ? '&' : '?') + '__vc=' + Date.now());
          }
        } else {
          reloadKeepingScroll();
        }
      };
    } catch {
      /* ignore */
    }
  }

  // ---------- helpers for element info ----------
  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function isUnique(sel) {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  }

  function segment(el) {
    var tag = el.tagName.toLowerCase();
    if (el.id && !/^\d/.test(el.id) && isUnique('#' + cssEscape(el.id))) return { sel: '#' + cssEscape(el.id), anchor: true };
    var s = tag;
    var cls =
      typeof el.className === 'string'
        ? el.className
            .trim()
            .split(/\s+/)
            .filter((c) => c && c.length < 40 && !/^(active|hover|focus|open|show|is-|has-)/.test(c) && c.indexOf(':') < 0)
            .slice(0, 2)
        : [];
    if (cls.length) s += '.' + cls.map(cssEscape).join('.');
    var parent = el.parentElement;
    if (parent) {
      var same = Array.prototype.filter.call(parent.children, (c) => c.tagName === el.tagName);
      if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
    }
    return { sel: s, anchor: false };
  }

  function selectorFor(el) {
    var parts = [];
    var cur = el;
    for (var depth = 0; cur && cur.nodeType === 1 && depth < 8; depth++) {
      if (cur === document.body || cur === document.documentElement) {
        parts.unshift(cur.tagName.toLowerCase());
        break;
      }
      var seg = segment(cur);
      parts.unshift(seg.sel);
      var sel = parts.join(' > ');
      if (seg.anchor || isUnique(sel)) return sel;
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  var STYLE_KEYS = [
    'display',
    'position',
    'width',
    'height',
    'margin',
    'padding',
    'color',
    'background-color',
    'background-image',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'text-align',
    'border',
    'border-radius',
    'box-shadow',
    'gap',
    'flex-direction',
    'justify-content',
    'align-items',
    'grid-template-columns',
    'opacity',
    'z-index',
    'transform',
    'transition',
  ];
  var BORING = /^(none|normal|auto|0px|rgba\(0, 0, 0, 0\)|0px none rgb\(.*\)|static|visible|start|stretch|1)$/;

  function stylesOf(el) {
    var out = {};
    try {
      var cs = getComputedStyle(el);
      STYLE_KEYS.forEach((k) => {
        var v = cs.getPropertyValue(k);
        if (!v || BORING.test(v.trim())) return;
        if (k === 'margin' || k === 'padding') {
          if (/^(0px ?)+$/.test(v)) return;
        }
        out[k] = v.length > 160 ? v.slice(0, 160) + '…' : v;
      });
    } catch {
      /* ignore */
    }
    return out;
  }

  function stackLocation(stack) {
    if (!stack) return null;
    var lines = String(stack).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/(https?:\/\/[^\s)]+?):(\d+):(\d+)/);
      if (!m) continue;
      var url = m[1];
      if (/node_modules|react-dom|react\.development|jsx-dev-runtime|chunk-/.test(url)) continue;
      try {
        url = new URL(url).pathname;
      } catch {
        /* ignore */
      }
      // Line numbers here refer to the dev server's transformed output, so only the file is reliable.
      return url.replace(/\?.*$/, '');
    }
    return null;
  }

  function sourceOf(el) {
    var res = {};
    try {
      // Attributes added by inspector plugins.
      var n = el;
      for (var d = 0; n && d < 6; d++, n = n.parentElement) {
        var v = n.getAttribute && (n.getAttribute('data-v-inspector') || n.getAttribute('data-loc') || n.getAttribute('data-source'));
        if (v) {
          res.source = v;
          break;
        }
        var rp = n.getAttribute?.('data-inspector-relative-path');
        if (rp) {
          res.source = rp + ':' + (n.getAttribute('data-inspector-line') || '?');
          break;
        }
      }
      // React
      var key = Object.keys(el).find((k) => k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0);
      if (key) {
        var f = el[key];
        var hostSource = f?._debugSource;
        for (var i = 0; f && i < 40; i++, f = f.return) {
          var t = f.type;
          if (typeof t === 'function' || (t && typeof t === 'object' && (t.render || t.type))) {
            var fn = typeof t === 'function' ? t : t.render || t.type;
            var name = t.displayName || (fn && (fn.displayName || fn.name)) || '';
            if (name) {
              res.component = res.component || 'React: ' + name;
              if (!res.source) {
                var src = hostSource || f._debugSource;
                if (src?.fileName) res.source = src.fileName + ':' + src.lineNumber;
                else {
                  var loc = stackLocation(el[key]._debugStack?.stack) || stackLocation(f._debugStack?.stack);
                  if (loc) res.source = loc;
                }
              }
              break;
            }
          }
        }
      }
      // Vue 3
      if (!res.component && el.__vueParentComponent) {
        var ty = el.__vueParentComponent.type || {};
        res.component = 'Vue: ' + (ty.name || ty.__name || 'Anonymous');
        if (!res.source && ty.__file) res.source = ty.__file;
      }
      // Vue 2
      if (!res.component && el.__vue__) {
        var o = el.__vue__.$options || {};
        res.component = 'Vue: ' + (o.name || o._componentTag || 'Anonymous');
        if (!res.source && o.__file) res.source = o.__file;
      }
      // Svelte
      if (!res.source && el.__svelte_meta && el.__svelte_meta.loc) {
        var l = el.__svelte_meta.loc;
        res.source = l.file + ':' + (l.line + 1);
        res.component = res.component || 'Svelte';
      }
    } catch {
      /* ignore */
    }
    return res;
  }

  function infoOf(el) {
    var r = el.getBoundingClientRect();
    var src = sourceOf(el);
    var html = el.outerHTML || '';
    return {
      page: location.pathname + location.search + location.hash,
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      text: clip((el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' '), 200),
      html: clip(html, 2000),
      styles: stylesOf(el),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      source: src.source,
      component: src.component,
    };
  }

  // ---------- overlay ----------
  var overlay = null;
  var label = null;
  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.setAttribute('data-crew', 'overlay');
    overlay.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #0a84ff;background:rgba(10,132,255,.12);border-radius:3px;transition:all .06s ease-out;display:none;';
    label = document.createElement('div');
    label.setAttribute('data-crew', 'label');
    label.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483647;background:#0a84ff;color:#fff;font:600 11px/1.6 ui-monospace,Menlo,monospace;padding:1px 6px;border-radius:4px;white-space:nowrap;display:none;box-shadow:0 2px 8px rgba(0,0,0,.25);';
    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(label);
  }

  function showOverlay(el, color) {
    ensureOverlay();
    var r = el.getBoundingClientRect();
    overlay.style.borderColor = color || '#0a84ff';
    overlay.style.background = color ? 'rgba(52,199,89,.15)' : 'rgba(10,132,255,.12)';
    overlay.style.display = 'block';
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
    var name = el.tagName.toLowerCase();
    if (el.id) name += '#' + el.id;
    else if (typeof el.className === 'string' && el.className.trim()) name += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    label.textContent = name + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    label.style.background = color || '#0a84ff';
    label.style.display = 'block';
    label.style.left = Math.max(2, r.left) + 'px';
    label.style.top = (r.top > 22 ? r.top - 20 : r.bottom + 4) + 'px';
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
    if (label) label.style.display = 'none';
  }

  // ---------- element picker ----------
  var picking = false;
  function isOwn(el) {
    return el?.getAttribute?.('data-crew');
  }

  function onPickMove(ev) {
    var el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!el || isOwn(el)) return;
    showOverlay(el);
  }
  function swallow(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
  }
  function onPickClick(ev) {
    swallow(ev);
    var el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!el || isOwn(el)) return;
    post({ type: 'picked', info: infoOf(el) });
    showOverlay(el, '#34c759');
    setTimeout(hideOverlay, 600);
    if (!ev.shiftKey) setPicking(false);
  }
  function onPickKey(ev) {
    if (ev.key === 'Escape') {
      swallow(ev);
      setPicking(false);
    }
  }
  function setPicking(on) {
    if (on === picking) return;
    picking = on;
    var fn = on ? 'addEventListener' : 'removeEventListener';
    document[fn]('mousemove', onPickMove, true);
    document[fn]('click', onPickClick, true);
    document[fn]('mousedown', swallow, true);
    document[fn]('mouseup', swallow, true);
    document[fn]('pointerdown', swallow, true);
    document[fn]('keydown', onPickKey, true);
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (!on) {
      hideOverlay();
      post({ type: 'pick_end' });
    }
  }

  // ---------- recorder ----------
  var recording = false;
  var badge = null;
  var pendingFill = null;

  function record(step) {
    step.ts = Date.now();
    post({ type: 'recorded', step: step });
  }
  function flushFill() {
    if (!pendingFill) return;
    var el = pendingFill;
    pendingFill = null;
    var masked = el.type === 'password';
    record({ type: 'fill', selector: selectorFor(el), value: masked ? '******' : clip(el.value, 500), text: el.getAttribute('placeholder') || el.name || '' });
  }
  function labelOf(el) {
    return clip((el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' '), 80);
  }
  function onRecClick(ev) {
    var el = ev.target;
    if (!el || isOwn(el) || el.nodeType !== 1) return;
    var tag = el.tagName.toLowerCase();
    if ((tag === 'input' && /^(text|email|password|search|tel|url|number)$/.test(el.type)) || tag === 'textarea' || tag === 'select') return;
    if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) return;
    // Record the closest interactive ancestor, which gives a steadier selector.
    var target = el.closest('a,button,[role=button],label,summary,input,[onclick]') || el;
    flushFill();
    record({ type: 'click', selector: selectorFor(target), text: labelOf(target) });
  }
  function onRecInput(ev) {
    var el = ev.target;
    if (!el?.tagName) return;
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      if (el.type === 'checkbox' || el.type === 'radio') return;
      if (pendingFill && pendingFill !== el) flushFill();
      pendingFill = el;
    }
  }
  function onRecChange(ev) {
    var el = ev.target;
    if (!el?.tagName) return;
    var tag = el.tagName.toLowerCase();
    if (tag === 'select') record({ type: 'select', selector: selectorFor(el), value: el.value });
    else if (el.type === 'checkbox' || el.type === 'radio') record({ type: 'check', selector: selectorFor(el), value: String(el.checked), text: labelOf(el.closest('label') || el) });
    else if (el === pendingFill) flushFill();
  }
  function onRecKey(ev) {
    if (ev.key === 'Enter' || ev.key === 'Escape' || ev.key === 'Tab') {
      flushFill();
      var el = ev.target && ev.target.nodeType === 1 ? ev.target : null;
      record({ type: 'press', key: ev.key, selector: el && el !== document.body ? selectorFor(el) : undefined });
    }
  }
  function onRecSubmit(ev) {
    flushFill();
    record({ type: 'submit', selector: selectorFor(ev.target) });
  }
  function setRecording(on) {
    if (on === recording) return;
    recording = on;
    var fn = on ? 'addEventListener' : 'removeEventListener';
    document[fn]('click', onRecClick, true);
    document[fn]('input', onRecInput, true);
    document[fn]('change', onRecChange, true);
    document[fn]('keydown', onRecKey, true);
    document[fn]('submit', onRecSubmit, true);
    if (on) {
      if (!badge) {
        badge = document.createElement('div');
        badge.setAttribute('data-crew', 'badge');
        badge.textContent = '● 正在录制演示';
        badge.style.cssText =
          'position:fixed;top:8px;right:8px;z-index:2147483647;background:#ff3b30;color:#fff;font:600 12px/1.8 -apple-system,system-ui,sans-serif;padding:2px 10px;border-radius:999px;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.25);';
      }
      document.documentElement.appendChild(badge);
    } else {
      flushFill();
      if (badge?.parentNode) badge.parentNode.removeChild(badge);
    }
  }

  // ---------- messages from the host ----------
  window.addEventListener('message', (ev) => {
    if (ev.source !== window.parent) return;
    var d = ev.data;
    if (d?.__crew_host !== true) return;
    if (d.type === 'hello') {
      hostOrigin = ev.origin;
      var queued = outbox;
      outbox = [];
      queued.forEach(post);
      return;
    }
    if (!hostOrigin || ev.origin !== hostOrigin) return;
    if (d.type === 'pick') setPicking(!!d.on);
    else if (d.type === 'record') setRecording(!!d.on);
    else if (d.type === 'history') history.go(d.dir);
    else if (d.type === 'highlight') {
      try {
        var el = document.querySelector(d.selector);
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          setTimeout(() => {
            showOverlay(el, '#34c759');
            setTimeout(hideOverlay, 1500);
          }, 300);
        }
      } catch {
        /* ignore */
      }
    }
  });

  announce('ready');
  if (document.readyState !== 'complete') {
    window.addEventListener('load', () => {
      announce('nav');
    });
  }
})();

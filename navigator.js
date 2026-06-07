(() => {
  const app = window.ConeDeckApp;
  if (!app) return;

  app.registerModule({
    name: 'navigator',
    init(appInstance) {
      let observer = null;
      let scrollSpyTimer = null;
      let isCollapsed = false;
      let activeIndex = -1;
      let messageCache = [];
      let searchQuery = '';
      let boundScrollTarget = null;
      let unlistenRoute = null;
      let healthTimer = null;
      let latestRouteKey = appInstance.getCurrentRouteKey();
      let waitRenderToken = 0;
      let isSettling = false;
      const pendingWaitTimers = new Set();

      const { debounce, truncate, cleanText, createEl, uid } = appInstance.utils;
      const debouncedRefresh = debounce(() => {
        if (isSettling) return;
        refreshNavigator({ preserveActive: true });
      }, 250);

      // Grok user-message selector — each user message bubble carries data-testid="user-message"
      // (its class also includes "message-bubble"). The testid is the most stable hook.
      function getMessageElements() {
        // Primary: the stable testid Grok puts on every user message bubble
        const byTestId = Array.from(
          document.querySelectorAll('[data-testid="user-message"]')
        ).filter((el) => el instanceof HTMLElement);
        if (byTestId.length) return byTestId;
        // Fallback: any message bubble
        return Array.from(
          document.querySelectorAll('div[class*="message-bubble"]')
        ).filter((el) => el instanceof HTMLElement);
      }

      // Extract the message's actual text
      function extractMessageText(el) {
        // On Grok the typed text lives in a p[class*="break-words"] inside the bubble
        const p = el.querySelector('p[class*="break-words"]');
        if (p) {
          const text = cleanText(p.innerText || p.textContent || '');
          if (text) return text;
        }
        // Fallback: take the whole element's text
        return cleanText(el.innerText || el.textContent || '');
      }

      function getSnippetForQuery(text, query, max = 36) {
        const clean = cleanText(text);
        if (!query) return truncate(clean, max);
        const lower = clean.toLowerCase();
        const q = cleanText(query).toLowerCase();
        if (!q) return truncate(clean, max);
        const index = lower.indexOf(q);
        if (index === -1) return truncate(clean, max);
        const start = Math.max(0, index - Math.floor((max - q.length) / 2));
        const end = Math.min(clean.length, start + max);
        const slice = clean.slice(start, end);
        const prefix = start > 0 ? '…' : '';
        const suffix = end < clean.length ? '…' : '';
        return `${prefix}${slice}${suffix}`;
      }

      function highlight(text, query) {
        const snippet = getSnippetForQuery(text, query, 36);
        if (!query) return document.createTextNode(snippet);
        const lower = snippet.toLowerCase();
        const q = cleanText(query).toLowerCase();
        const idx = lower.indexOf(q);
        if (idx === -1) return document.createTextNode(snippet);
        const frag = document.createDocumentFragment();
        frag.appendChild(document.createTextNode(snippet.slice(0, idx)));
        const mark = document.createElement('mark');
        mark.className = 'cn-match';
        mark.textContent = snippet.slice(idx, idx + q.length);
        frag.appendChild(mark);
        frag.appendChild(document.createTextNode(snippet.slice(idx + q.length)));
        return frag;
      }

      function getScrollContainer() {
        const messageEls = getMessageElements();
        if (!messageEls.length) return document.scrollingElement || document.documentElement;

        const counts = new Map();
        messageEls.slice(0, 6).forEach((msg) => {
          let current = msg.parentElement;
          let depth = 0;
          while (current && current !== document.body && depth < 12) {
            const style = window.getComputedStyle(current);
            const isScrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll') && current.clientHeight > 0;
            if (isScrollable) {
              counts.set(current, (counts.get(current) || 0) + 1);
            }
            current = current.parentElement;
            depth += 1;
          }
        });

        const best = Array.from(counts.entries())
          .sort((a, b) => {
            if (b[1] !== a[1]) return b[1] - a[1];
            return (b[0].clientHeight || 0) - (a[0].clientHeight || 0);
          })[0]?.[0];

        return best || document.scrollingElement || document.documentElement;
      }

      function assignRecordId(el, index, text, previousCache, usedIds) {
        const existing = el.dataset.cnMsgId;
        if (existing && !usedIds.has(existing)) {
          usedIds.add(existing);
          return existing;
        }

        const previousAtIndex = previousCache[index];
        if (previousAtIndex && previousAtIndex.text === text && !usedIds.has(previousAtIndex.id)) {
          el.dataset.cnMsgId = previousAtIndex.id;
          usedIds.add(previousAtIndex.id);
          return previousAtIndex.id;
        }

        const fallback = previousCache.find((item) => item.text === text && !usedIds.has(item.id));
        if (fallback) {
          el.dataset.cnMsgId = fallback.id;
          usedIds.add(fallback.id);
          return fallback.id;
        }

        const id = uid('msg');
        el.dataset.cnMsgId = id;
        usedIds.add(id);
        return id;
      }

      // Collect navigator entries: the user's text messages + attachment groups (images / videos / other files), in DOM order.
      // Verified against grok.com: a user turn is a div[id^="response-"] holding the typed text in a bubble
      // ([data-testid="user-message"] > p[class*="break-words"]) and any uploads as chips ([class*="bg-chip"]) inside a
      // right-aligned attachment row (div.flex-wrap.justify-end) — the chips are SIBLINGS of the text bubble, not inside it.
      // A chip is a video if it contains <video>, an image if it contains <img>, otherwise a file (e.g. a PDF).
      // Markers are sorted by DOM order, then consecutive same-kind attachments are grouped into one
      // Image upload ×N / Video upload ×N / Attachment ×N, so mixed kinds aren't merged and mislabeled.
      const GROK_ATTACHMENT_CHIP_SELECTOR = '[id^="response-"] div[class*="flex-wrap"][class*="justify-end"] [class*="bg-chip"]';
      function collectEntries() {
        const usable = (el) => el && !el.closest('#cn-panel') && !el.closest('#cd-organizer-root');

        const markers = [];
        // text: each user message bubble's typed text
        getMessageElements().forEach((bubble) => {
          if (!usable(bubble)) return;
          const textEl = bubble.querySelector('p[class*="break-words"]') || bubble;
          if (usable(textEl)) markers.push({ el: textEl, type: 'text' });
        });
        // attachments: each upload chip inside a user turn's right-aligned attachment row
        document.querySelectorAll(GROK_ATTACHMENT_CHIP_SELECTOR).forEach((chip) => {
          if (!usable(chip)) return;
          const kind = chip.querySelector('video') ? 'video'
            : chip.querySelector('img') ? 'image'
            : 'file';
          markers.push({ el: chip, type: 'attach', kind });
        });

        markers.sort((a, b) =>
          (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);

        const entries = [];
        let i = 0;
        while (i < markers.length) {
          const marker = markers[i];
          if (marker.type === 'text') {
            const text = extractMessageText(marker.el);
            if (text) entries.push({ el: marker.el, text });
            i += 1;
            continue;
          }
          const kind = marker.kind;
          let count = 0;
          while (i < markers.length && markers[i].type === 'attach' && markers[i].kind === kind) {
            count += 1;
            i += 1;
          }
          const base = kind === 'image' ? 'Image upload' : kind === 'video' ? 'Video upload' : 'Attachment';
          entries.push({ el: marker.el, text: count > 1 ? `${base} ×${count}` : base });
        }
        return entries;
      }

      function scanMessages() {
        const previousCache = messageCache.slice();
        const usedIds = new Set();
        const nextCache = collectEntries()
          .map((entry, index) => {
            const text = entry.text;
            if (!text) return null;
            const id = assignRecordId(entry.el, index, text, previousCache, usedIds);
            return { id, text, el: entry.el };
          })
          .filter(Boolean);

        const changed = nextCache.length !== previousCache.length
          || nextCache.some((item, index) => item.id !== previousCache[index]?.id || item.text !== previousCache[index]?.text);

        messageCache = nextCache;
        return changed;
      }

      function buildPanel() {
        let panel = document.getElementById('cn-panel');
        if (panel) return panel;

        panel = createEl('div', { id: 'cn-panel' });
        panel.innerHTML = `
          <div id="cn-expanded">
            <div id="cn-header">
              <div id="cn-search-wrap">
                <span id="cn-search-icon">🔍</span>
                <input id="cn-search" type="text" placeholder="Search messages…" autocomplete="off" spellcheck="false">
                <button id="cn-search-clear" title="Clear">✕</button>
              </div>
              <div id="cn-header-right">
                <div id="cn-theme-picker">
                  <button class="cn-theme-btn" data-theme="light" title="Light">☀</button>
                  <button class="cn-theme-btn" data-theme="system" title="System">◑</button>
                  <button class="cn-theme-btn" data-theme="dark" title="Dark">☾</button>
                </div>
                <button id="cn-toggle" title="Collapse">«</button>
              </div>
            </div>
            <div id="cn-list"></div>
            <div id="cn-footer"><a id="cn-brand" href="https://conelab.ai" target="_blank" rel="noopener noreferrer">Made by conelab.ai</a></div>
          </div>
          <div id="cn-collapsed">
            <button id="cn-expand" title="Expand">»</button>
            <div id="cn-dots-wrap"><div id="cn-dots"></div></div>
          </div>
        `;
        document.body.appendChild(panel);

        document.getElementById('cn-toggle')?.addEventListener('click', () => setCollapsed(true));
        document.getElementById('cn-expand')?.addEventListener('click', () => setCollapsed(false));
        document.getElementById('cn-brand')?.addEventListener('click', (event) => event.stopPropagation());

        const searchInput = document.getElementById('cn-search');
        const searchClear = document.getElementById('cn-search-clear');
        if (searchInput && searchClear) {
          searchInput.value = searchQuery;
          searchClear.style.display = searchQuery ? 'flex' : 'none';
          searchInput.addEventListener('input', () => {
            searchQuery = cleanText(searchInput.value);
            searchClear.style.display = searchQuery ? 'flex' : 'none';
            rebuildList();
            renderDots();
          });
          searchInput.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            searchInput.value = '';
            searchQuery = '';
            searchClear.style.display = 'none';
            rebuildList();
            renderDots();
          });
          searchClear.addEventListener('click', () => {
            searchInput.value = '';
            searchQuery = '';
            searchClear.style.display = 'none';
            rebuildList();
            renderDots();
            searchInput.focus();
          });
        }

        panel.querySelectorAll('.cn-theme-btn').forEach((btn) => {
          btn.addEventListener('click', (event) => {
            event.stopPropagation();
            appInstance.applyTheme(btn.dataset.theme);
          });
        });

        panel.classList.toggle('cn-is-collapsed', isCollapsed);
        return panel;
      }

      function persistCollapsedState() {
        appInstance.storage.set({ [appInstance.storageKeys.navCollapsed]: isCollapsed });
      }

      function setCollapsed(value, options = {}) {
        isCollapsed = Boolean(value);
        const panel = buildPanel();
        panel.classList.toggle('cn-is-collapsed', isCollapsed);
        renderDots();
        if (!options.skipPersist) persistCollapsedState();
      }

      function getFilteredMessages() {
        if (!searchQuery) return messageCache;
        const q = searchQuery.toLowerCase();
        return messageCache.filter((message) => message.text.toLowerCase().includes(q));
      }

      function setActiveItem(index, scrollNav = true) {
        activeIndex = index;
        const list = document.getElementById('cn-list');
        if (list) {
          list.querySelectorAll('.cn-item').forEach((el) => {
            el.classList.toggle('cn-active', Number(el.dataset.index) === index);
          });
          if (scrollNav) {
            const activeEl = list.querySelector(`.cn-item[data-index="${index}"]`);
            activeEl?.scrollIntoView({ block: 'nearest' });
          }
        }
        const dots = document.getElementById('cn-dots');
        if (dots) {
          dots.querySelectorAll('.cn-dot').forEach((dot) => {
            dot.classList.toggle('cn-dot-active', Number(dot.dataset.index) === index);
          });
        }
      }

      function rebuildList() {
        const panel = buildPanel();
        const list = panel.querySelector('#cn-list');
        if (!list) return;
        list.innerHTML = '';

        const filtered = getFilteredMessages();
        if (!filtered.length) {
          list.innerHTML = `<div class="cn-empty">${searchQuery ? 'No matches' : 'No messages yet'}</div>`;
          return;
        }

        filtered.forEach((record) => {
          const index = messageCache.findIndex((item) => item.id === record.id);
          if (index === -1) return;
          const item = createEl('div', {
            class: `cn-item${index === activeIndex ? ' cn-active' : ''}`,
            dataset: { index: String(index) }
          });
          const idx = createEl('span', { class: 'cn-index', text: String(index + 1) });
          const txt = createEl('span', { class: 'cn-text' });
          txt.appendChild(highlight(record.text, searchQuery));
          item.append(idx, txt);
          item.addEventListener('click', () => {
            setActiveItem(index);
            scrollToMessage(index);
          });
          list.appendChild(item);
        });
      }

      function renderDots() {
        const panel = buildPanel();
        const dots = panel.querySelector('#cn-dots');
        if (!dots) return;

        const existing = dots.querySelectorAll('.cn-dot');

        // Same message count: only toggle the active class instead of rebuilding the DOM, to avoid flicker
        if (existing.length === messageCache.length) {
          existing.forEach((dot) => {
            dot.classList.toggle('cn-dot-active', Number(dot.dataset.index) === activeIndex);
            // Sync the title (message text may have changed)
            const idx = Number(dot.dataset.index);
            if (messageCache[idx]) dot.title = truncate(messageCache[idx].text, 28);
          });
          return;
        }

        // Rebuild only when the message count changes
        dots.innerHTML = '';
        messageCache.forEach((message, index) => {
          const dot = createEl('div', {
            class: `cn-dot${index === activeIndex ? ' cn-dot-active' : ''}`,
            dataset: { index: String(index) }
          });
          dot.title = truncate(message.text, 28);
          dot.addEventListener('click', () => {
            setActiveItem(index);
            scrollToMessage(index);
          });
          dots.appendChild(dot);
        });
      }

      function updateScrollBinding() {
        const scrollTarget = getScrollContainer();
        const nextTarget = scrollTarget === document.documentElement ? window : scrollTarget;
        if (boundScrollTarget === nextTarget) return;

        const onScroll = handleScroll;
        if (boundScrollTarget) {
          boundScrollTarget.removeEventListener('scroll', onScroll);
        }
        boundScrollTarget = nextTarget;
        boundScrollTarget.addEventListener('scroll', onScroll, { passive: true });
      }

      function detectActiveIndex() {
        const candidates = messageCache.filter((message) => message.el && document.contains(message.el));
        if (!candidates.length) return -1;

        const scrollContainer = getScrollContainer();
        const containerRect = scrollContainer === document.documentElement || scrollContainer === document.scrollingElement
          ? { top: 0, bottom: window.innerHeight, height: window.innerHeight }
          : scrollContainer.getBoundingClientRect();

        let bestIndex = -1;
        let bestScore = Number.POSITIVE_INFINITY;
        candidates.forEach((message) => {
          const rect = message.el.getBoundingClientRect();
          const visibleTop = Math.max(rect.top, containerRect.top);
          const visibleBottom = Math.min(rect.bottom, containerRect.bottom);
          const visibleHeight = Math.max(0, visibleBottom - visibleTop);
          if (visibleHeight <= 0) return;
          const distance = Math.abs(rect.top - containerRect.top);
          const coveragePenalty = 1 / visibleHeight;
          const score = distance + coveragePenalty;
          const index = messageCache.findIndex((item) => item.id === message.id);
          if (index !== -1 && score < bestScore) {
            bestScore = score;
            bestIndex = index;
          }
        });

        return bestIndex;
      }

      function handleScroll() {
        scanMessages();
        clearTimeout(scrollSpyTimer);
        scrollSpyTimer = setTimeout(() => {
          updateScrollBinding();
          refreshNavigator({ preserveActive: true });
        }, 120);
      }

      function tryResolveElementById(recordId) {
        if (!recordId) return null;
        const direct = document.querySelector(`[data-cn-msg-id="${CSS.escape(recordId)}"]`);
        return direct instanceof HTMLElement ? direct : null;
      }

      function scrollToMessage(index) {
        scanMessages();
        const target = messageCache[index];
        if (!target) return;

        const flash = (el) => {
          let cancelled = false;
          const stop = () => { cancelled = true; };
          const teardown = () => ['wheel', 'touchstart', 'keydown'].forEach((ev) => window.removeEventListener(ev, stop));
          // as soon as the user actively scrolls or presses a key, stop auto-centering so we don't yank them back
          ['wheel', 'touchstart', 'keydown'].forEach((ev) => window.addEventListener(ev, stop, { once: true, passive: true }));
          // find the target's scroll viewport, used to tell whether it's centered
          let viewport = el.parentElement;
          while (viewport && viewport !== document.body) {
            const st = getComputedStyle(viewport);
            if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && viewport.clientHeight > 0) break;
            viewport = viewport.parentElement;
          }
          const viewportCenter = () => (viewport && viewport !== document.body)
            ? (viewport.getBoundingClientRect().top + viewport.clientHeight / 2)
            : (window.innerHeight / 2);
          try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
          el.classList.add('cn-highlight');
          setTimeout(() => el.classList.remove('cn-highlight'), 1400);
          // in long chats, lazy-loading/virtualization keeps changing the heights above after the jump, making the target drift.
          // each frame, check whether the target is off the viewport center and re-center if so; stop after ~15 stable frames, a ~4s cap, or a user scroll.
          let stable = 0;
          let frames = 0;
          const tick = () => {
            if (cancelled) { teardown(); return; }
            const r = el.getBoundingClientRect();
            if (Math.abs((r.top + r.height / 2) - viewportCenter()) > 2) {
              try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
              stable = 0;
            } else {
              stable += 1;
            }
            frames += 1;
            if (stable >= 15 || frames >= 240) { teardown(); return; }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          const img = el.tagName === 'IMG' ? el : (el.querySelector && el.querySelector('img'));
          if (img && !img.complete) img.addEventListener('load', () => { stable = 0; }, { once: true });
        };

        const directEl = (target.el && document.contains(target.el)) ? target.el : tryResolveElementById(target.id);
        if (directEl) {
          target.el = directEl;
          flash(directEl);
          return;
        }

        const scrollEl = getScrollContainer();
        const ratio = messageCache.length > 1 ? index / (messageCache.length - 1) : 0;
        if (scrollEl === document.documentElement || scrollEl === document.scrollingElement) {
          window.scrollTo({
            top: ratio * ((document.documentElement.scrollHeight || document.body.scrollHeight) - window.innerHeight),
            behavior: 'smooth'
          });
        } else {
          scrollEl.scrollTo({
            top: ratio * Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight),
            behavior: 'smooth'
          });
        }

        let attempts = 0;
        const tryJump = () => {
          scanMessages();
          const refreshed = messageCache.find((item) => item.id === target.id) || messageCache[index];
          if (refreshed?.el && document.contains(refreshed.el)) {
            flash(refreshed.el);
          } else if (attempts++ < 5) {
            setTimeout(tryJump, 350);
          }
        };
        setTimeout(tryJump, 450);
      }

      function refreshNavigator({ preserveActive = false } = {}) {
        buildPanel();
        const changed = scanMessages();
        updateScrollBinding();
        rebuildList();
        renderDots();

        if (!messageCache.length) {
          activeIndex = -1;
          return;
        }

        if (!preserveActive || activeIndex < 0 || activeIndex >= messageCache.length || changed) {
          const nextActive = detectActiveIndex();
          setActiveItem(nextActive !== -1 ? nextActive : 0, false);
        } else {
          setActiveItem(activeIndex, false);
        }
      }

      function resetSearchState() {
        searchQuery = '';
        const searchInput = document.getElementById('cn-search');
        const searchClear = document.getElementById('cn-search-clear');
        if (searchInput) searchInput.value = '';
        if (searchClear) searchClear.style.display = 'none';
      }

      function clearPendingWaitTimers() {
        pendingWaitTimers.forEach((timerId) => window.clearTimeout(timerId));
        pendingWaitTimers.clear();
      }

      function scheduleWaitTimer(callback, delay) {
        const timerId = window.setTimeout(() => {
          pendingWaitTimers.delete(timerId);
          callback();
        }, delay);
        pendingWaitTimers.add(timerId);
        return timerId;
      }

      function waitAndRender({ preserveActive = false, maxAttempts = 15, initialDelay = 300, retryDelay = 400 } = {}) {
        const token = ++waitRenderToken;
        let attempts = 0;
        let lastCount = -1;
        clearPendingWaitTimers();

        const tryRender = () => {
          if (token !== waitRenderToken) return;
          const count = getMessageElements().length;
          const stable = count > 0 && count === lastCount;
          lastCount = count;
          if (stable || attempts >= maxAttempts) {
            isSettling = false;
            refreshNavigator({ preserveActive });
            return;
          }
          attempts += 1;
          scheduleWaitTimer(tryRender, retryDelay);
        };

        scheduleWaitTimer(tryRender, initialDelay);
      }

      function resetForRoute() {
        latestRouteKey = appInstance.getCurrentRouteKey();
        messageCache = [];
        activeIndex = -1;
        isSettling = true;
        resetSearchState();
        const list = document.getElementById('cn-list');
        if (list) list.innerHTML = '<div class="cn-empty">Loading…</div>';
        const dots = document.getElementById('cn-dots');
        if (dots) dots.innerHTML = '';
        waitAndRender({ preserveActive: false });
      }

      function startObserver() {
        if (observer) observer.disconnect();
        observer = new MutationObserver((mutations) => {
          const relevant = mutations.some((mutation) => {
            if (mutation.type === 'characterData') return true;
            if (mutation.type === 'attributes') {
              return mutation.target instanceof HTMLElement
                && (mutation.target.matches('[class*="message-bubble"], [class*="items-end"]')
                    || mutation.target.closest?.('[class*="message-bubble"], [class*="items-end"]'));
            }
            const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
            return changedNodes.some((node) => {
              if (!(node instanceof HTMLElement)) return false;
              return node.matches?.('[class*="message-bubble"], [class*="items-end"]')
                || node.querySelector?.('[class*="message-bubble"], [class*="items-end"]');
            });
          });
          if (relevant) debouncedRefresh();
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class']
        });
      }

      function startHealthCheck() {
        if (healthTimer) clearInterval(healthTimer);
        healthTimer = setInterval(() => {
          if (!document.getElementById('cn-panel')) {
            buildPanel();
            setCollapsed(isCollapsed, { skipPersist: true });
            refreshNavigator({ preserveActive: true });
            return;
          }
          const currentRouteKey = appInstance.getCurrentRouteKey();
          if (currentRouteKey !== latestRouteKey) {
            resetForRoute();
            return;
          }
          updateScrollBinding();
        }, 1200);
      }

      (async () => {
        try {
          const stored = await appInstance.storage.get(appInstance.storageKeys.navCollapsed);
          isCollapsed = Boolean(stored?.[appInstance.storageKeys.navCollapsed]);
        } catch (error) {
          console.warn('[Cone Deck] load nav collapsed failed:', error);
        }

        buildPanel();
        setCollapsed(isCollapsed, { skipPersist: true });
        appInstance.applyTheme(appInstance.currentTheme || 'system');
        startObserver();
        updateScrollBinding();
        isSettling = true;
        waitAndRender({ preserveActive: false });
        startHealthCheck();
        unlistenRoute = appInstance.onRouteChange(() => resetForRoute());
      })();

      window.addEventListener('beforeunload', () => {
        observer?.disconnect();
        clearPendingWaitTimers();
        waitRenderToken += 1;
        if (boundScrollTarget) boundScrollTarget.removeEventListener('scroll', handleScroll);
        if (healthTimer) clearInterval(healthTimer);
        if (typeof unlistenRoute === 'function') unlistenRoute();
      }, { once: true });
    }
  });
})();
/* ============================================================
   Old Reddit Restyle - content script

   Runs at document_start on feed pages only. Reads the posts
   Reddit already delivered and re-renders them old-reddit style.

   Makes no network requests of its own.
   ============================================================ */

(() => {
  'use strict';

  /* Set to false to silence. Everything logs with an [ORR] prefix so you
     can filter Reddit's console noise out. */
  const DEBUG = false;   /* flip to true for [ORR] console logging */
  const log = (...a) => DEBUG && console.log('[ORR]', ...a);

  if (DEBUG) {
    document.addEventListener('securitypolicyviolation', (e) => {
      log('CSP BLOCKED', e.effectiveDirective || e.violatedDirective,
          '->', (e.blockedURI || '').slice(0, 120));
    });
    log('loaded. Hls:', typeof Hls,
        '| isSupported:', typeof Hls !== 'undefined' ? Hls.isSupported() : 'n/a',
        '| MediaSource:', typeof MediaSource !== 'undefined');
  }

  /* Hide Reddit immediately, before it paints. */
  document.documentElement.classList.add('or-hide');

  /* New Reddit intercepts link clicks anywhere in the document and turns
     them into soft SPA navigations. That changes the URL without reloading,
     so our content script never re-runs and the page appears frozen.
     Registering in the capture phase at document_start puts us ahead of
     Reddit's handler, so clicks inside our UI become real navigations.
     Old reddit did full page loads too, so nothing is lost. */
  window.addEventListener('click', (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = e.target instanceof Element && e.target.closest('#or-root a[href]');
    if (!link) return;

    const href = link.getAttribute('href');
    if (!href || href.startsWith('#') || link.target === '_blank') return;

    e.preventDefault();
    e.stopImmediatePropagation();
    hardNavigate(link.href);
  }, true);

  /* Chrome's Navigation API lets a site intercept script-initiated
     navigations too, so location.assign() alone can still be turned into a
     soft one. If the URL moved but we're still running a moment later, that
     is what happened - reload to get a real document. */
  function hardNavigate(url) {
    const before = location.href;
    log('navigate ->', url);
    location.assign(url);
    setTimeout(() => {
      if (location.href !== before) {
        log('intercepted as soft navigation - forcing reload');
        location.reload();
      } else {
        log('navigation still pending (normal for a slow load)');
      }
    }, 250);
  }

  /* Back/forward has the same problem in the other direction. Reddit's
     Navigation API turns a history move into a soft render, so the URL
     changes but our rendered page doesn't - and if the browser serves the
     old page from bfcache, the content script never re-runs at all.
     Either way the fix is to insist on a real document. */
  const BOOT_URL = location.href;

  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;             /* normal load - nothing to do */
    log('restored from bfcache - reloading');
    location.reload();
  });

  window.addEventListener('popstate', () => {
    if (location.href === BOOT_URL) return;
    log('history navigation -> forcing reload');
    location.reload();
  });

  /* ----------------------------------------------------------
     THE VOLATILE PART.
     Every Reddit-specific name in the extension lives here.
     When Reddit ships a change that breaks this, start here.
     ---------------------------------------------------------- */
  const REDDIT = {
    postElement: 'shreddit-post',
    attr: {
      title: 'post-title', permalink: 'permalink', link: 'content-href',
      domain: 'domain', score: 'score', comments: 'comment-count',
      created: 'created-timestamp', author: 'author',
      subreddit: 'subreddit-prefixed-name', id: 'id', type: 'post-type',
    },
    selfText: '[slot="text-body"] [id$="post-rtjson-content"], [slot="text-body"] .md',
    subredditHeader: 'shreddit-subreddit-header',
    ruleBody: '[id^="rule-"]',
    headerAttr: {
      name: 'prefixed-name',
      displayName: 'display-name',
      description: 'description',
      activeUsers: 'weekly-active-users',
      contributions: 'weekly-contributions',
    },
    player: 'shreddit-player, shreddit-player-2',
    playerAttr: {
      hls: 'src',            /* signed HLS manifest - expires, must be captured */
      poster: 'poster',
      preview: 'preview',    /* unsigned low-res mp4, plays anywhere */
      captions: 'caption-url',
    },
    thumb: {
      reject: /emoji\.redditmedia|styles\.redditmedia|snoovatar|snoo_assets|redditstatic\.com\/avatars|communityIcon|profileIcon|award/i,
      best: /b\.thumbs\.redditmedia\.com/i,
      okay: /(external-)?preview\.redd\.it/i,
      imageFile: /\.(jpe?g|png|gif|webp)(\?|$)/i,
    },
  };

  /* preview.redd.it URLs carry a signature tied to the exact width
     requested, so we can never rewrite the params. To get a bigger image
     we have to pick a wider entry out of srcset, each of which is signed
     separately. */
  function bestFromSrcset(img) {
    const raw = img.getAttribute('srcset');
    if (!raw) return img.getAttribute('src');
    let bestUrl = null, bestW = -1;
    for (const part of raw.split(',')) {
      const [url, desc] = part.trim().split(/\s+/);
      const w = desc && desc.endsWith('w') ? parseInt(desc, 10) : 0;
      if (url && w > bestW) { bestW = w; bestUrl = url; }
    }
    return bestUrl || img.getAttribute('src');
  }

  /* Captured while the post is still in the DOM. Reddit recycles posts
     out of the page, so anything not copied now is gone by click time. */
  function captureMedia(el) {
    const href = el.getAttribute(REDDIT.attr.link) || '';

    if (el.hasAttribute('gallery')) {
      const carousel = el.querySelector('gallery-carousel, faceplate-carousel');
      if (carousel) {
        /* Walk slides rather than images: each slide holds two <img> tags
           with the same source, and slide order is gallery order. */
        const slides = [...carousel.querySelectorAll('li')];
        const images = [];
        for (const slide of slides) {
          const img = slide.querySelector('img');
          const url = img && bestFromSrcset(img);
          if (url && /preview\.redd\.it|i\.redd\.it/.test(url) && !images.includes(url)) {
            images.push(url);
          }
        }
        if (images.length) {
          /* expected lets the retry loop tell "one image so far" from
             "a genuinely single-image gallery". */
          return { kind: 'gallery', images, expected: slides.length || images.length };
        }
      }
    }

    if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(href)) {
      return { kind: 'image', images: [href] };
    }

    const player = el.querySelector(REDDIT.player);
    if (player) {
      const pa = REDDIT.playerAttr;
      return {
        kind: 'video',
        hls: player.getAttribute(pa.hls) || null,
        poster: player.getAttribute(pa.poster) || null,
        preview: player.getAttribute(pa.preview) || null,
        captions: player.getAttribute(pa.captions) || null,
      };
    }

    const body = el.querySelector(REDDIT.selfText);
    if (body && (body.textContent || '').trim().length > 0) {
      return { kind: 'text', html: sanitize(body) };
    }

    const embed = embedFrom(href);
    if (embed) return embed;

    return null;
  }

  /* This is user-authored content being moved into our own DOM, so it
     gets stripped down to a known set of tags with no attributes except
     safe hrefs. Also drops Reddit's classes, which we don't want. */
  const SAFE_TAGS = /^(P|BR|HR|A|STRONG|EM|B|I|U|S|DEL|CODE|PRE|BLOCKQUOTE|UL|OL|LI|H1|H2|H3|H4|H5|H6|SPAN|DIV|TABLE|THEAD|TBODY|TR|TD|TH|SUP|SUB)$/;
  const DROP_TAGS = /^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|LINK|META|FORM|INPUT|BUTTON)$/;

  function sanitize(node) {
    const clone = node.cloneNode(true);
    for (const el of [...clone.querySelectorAll('*')]) {
      if (DROP_TAGS.test(el.tagName)) { el.remove(); continue; }
      if (!SAFE_TAGS.test(el.tagName)) { el.replaceWith(...el.childNodes); continue; }
      for (const attr of [...el.attributes]) {
        const keep = attr.name.toLowerCase() === 'href' &&
                     el.tagName === 'A' &&
                     /^(https?:\/\/|\/)/i.test(attr.value);
        if (!keep) el.removeAttribute(attr.name);
      }
      if (el.tagName === 'A') {
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
    return clone.innerHTML;
  }

  /* Third-party embeds. Add more hosts here - each needs a pattern that
     captures an id, and a matching branch in mediaHtml. */
  const EMBEDS = {
    youtube: /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/,
  };

  /* Start offsets appear as t=90, t=90s, or t=1h2m3s. */
  function startSeconds(url) {
    const hms = url.match(/[?&#]t=(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)/);
    if (hms) {
      return (+(hms[1] || 0)) * 3600 + (+(hms[2] || 0)) * 60 + (+(hms[3] || 0));
    }
    const plain = url.match(/[?&#](?:t|start)=(\d+)/);
    return plain ? parseInt(plain[1], 10) : 0;
  }

  function embedFrom(href) {
    const yt = href.match(EMBEDS.youtube);
    if (yt) return { kind: 'youtube', id: yt[1], start: startSeconds(href) };
    return null;
  }

  const PER_PAGE = 25;
  const GIVE_UP_MS = 15000;

  /* ---------------- extraction ---------------- */

  function collectImageUrls(el) {
    const found = [];
    const walk = (root, depth = 0) => {
      if (depth > 8) return;
      for (const n of root.querySelectorAll('*')) {
        const tag = n.tagName.toLowerCase();
        if (tag === 'img' || tag === 'faceplate-img') {
          const s = n.getAttribute('src');
          if (s) found.push(s);
        }
        const poster = n.getAttribute('poster');
        if (poster) found.push(poster);
        if (n.shadowRoot) walk(n.shadowRoot, depth + 1);
      }
    };
    walk(el);
    return found;
  }

  /* Poster image for an embeddable link, derived from its id.
     hqdefault is the only size YouTube guarantees for every video -
     maxresdefault 404s on older or low-quality uploads. */
  function embedThumb(href) {
    const embed = embedFrom(href);
    if (embed && embed.kind === 'youtube') {
      return 'https://i.ytimg.com/vi/' + embed.id + '/hqdefault.jpg';
    }
    return null;
  }

  function findThumb(el) {
    const t = REDDIT.thumb;
    const clean = collectImageUrls(el).filter((u) => !t.reject.test(u));
    const best = clean.find((u) => t.best.test(u));
    if (best) return best;
    const okay = clean.find((u) => t.okay.test(u));
    if (okay) return okay;

    const href = el.getAttribute(REDDIT.attr.link) || '';
    if (t.imageFile.test(href)) return href;

    /* Last resort: reddit usually generates a b.thumbs crop for youtube
       links, so this only fires when it hasn't. */
    return embedThumb(href);
  }

  function extract(el) {
    const get = (k) => el.getAttribute(REDDIT.attr[k]) || '';
    return {
      id: get('id'),
      title: get('title'),
      permalink: get('permalink'),
      link: get('link') || get('permalink'),
      domain: get('domain') || 'self.' + get('subreddit').replace('r/', ''),
      score: parseInt(get('score'), 10) || 0,
      comments: parseInt(get('comments'), 10) || 0,
      created: get('created'),
      author: get('author'),
      subreddit: get('subreddit'),
      type: get('type') || 'text',
      thumb: findThumb(el),
      media: captureMedia(el),
    };
  }

  /* ---------------- the store ---------------- */

  const store = new Map();
  let page = 0;
  let started = false;
  let rendered = 0;   // rows currently drawn for this page

  /* Reddit inserts a post element before filling in its media, so an
     early capture can miss the thumbnail and the player. Those posts go
     on a retry list and get re-read while they're still on the page. */
  const incomplete = new Map();   /* id -> attempts */
  const MAX_RETRIES = 12;
  const EXPECTS_MEDIA = /^(video|image|gallery|gif)$/;

  /* Deliberately does NOT treat a partial gallery as incomplete. Galleries
     are completed on demand when opened (see completeGallery), so having
     the retry loop chase them too means re-reading every gallery on the
     page twelve times over for nothing. */
  function looksIncomplete(data) {
    if (!data.thumb) return true;
    return EXPECTS_MEDIA.test(data.type) && !data.media;
  }

  function absorb(el) {
    const id = el.getAttribute(REDDIT.attr.id);
    if (!id || store.has(id)) return false;
    const data = extract(el);
    store.set(id, data);
    if (looksIncomplete(data)) incomplete.set(id, 0);
    return true;
  }

  /* Redraw a single row in place, leaving the rest of the page alone. */
  function patchRow(id) {
    const row = document.querySelector('[data-post="' + id + '"]');
    if (!row) return;
    /* Redrawing would collapse an open expando under the reader. */
    const panel = document.querySelector('[data-panel="' + id + '"]');
    if (panel && !panel.hidden) return;
    const index = [...store.keys()].indexOf(id);
    if (index < 0) return;
    row.outerHTML = renderRow(store.get(id), index + 1);
  }

  function retryIncomplete() {
    if (!incomplete.size) return;

    for (const [id, tries] of [...incomplete]) {
      if (tries >= MAX_RETRIES) { incomplete.delete(id); continue; }
      incomplete.set(id, tries + 1);

      const el = document.querySelector(
        REDDIT.postElement + '[' + REDDIT.attr.id + '="' + id + '"]'
      );
      if (!el) continue;          /* recycled out; may come back */

      const post = store.get(id);
      if (!post) { incomplete.delete(id); continue; }

      const thumb = post.thumb || findThumb(el);

      /* Media isn't only present-or-absent: a gallery can arrive partial
         and fill in, so take a fresh read when it beats what we have. */
      const fresh = captureMedia(el);
      let media = post.media;
      if (!media) {
        media = fresh;
      } else if (fresh && fresh.kind === 'gallery' && media.kind === 'gallery' &&
                 fresh.images.length > media.images.length) {
        media = fresh;
      }

      if (thumb !== post.thumb || media !== post.media) {
        post.thumb = thumb;
        post.media = media;
        patchRow(id);
        log('filled in late:', id, '| thumb:', !!thumb, '| media:', media && media.kind);
      }
      if (DEBUG && tries === 3) {
        log('still incomplete:', id,
            '| type:', post.type,
            '| thumb:', !!post.thumb,
            '| media:', post.media && post.media.kind,
            '| has [slot=text-body]:', !!el.querySelector('[slot="text-body"]'),
            '| selfText selector matches:', !!el.querySelector(REDDIT.selfText),
            '| body chars:', (el.querySelector(REDDIT.selfText)?.textContent || '').trim().length);
      }
      if (!looksIncomplete(post)) incomplete.delete(id);
    }
  }

  function scanNow() {
    let added = 0;
    for (const el of document.querySelectorAll(REDDIT.postElement)) {
      if (absorb(el)) added++;
    }
    return added;
  }

  const observer = new MutationObserver((records) => {
    let added = 0;
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.(REDDIT.postElement) && absorb(node)) added++;
        for (const inner of node.querySelectorAll?.(REDDIT.postElement) || []) {
          if (absorb(inner)) added++;
        }
      }
    }
    if (added) {
      updateStatus();
      if (!started) firstDraw();
      else topUp();
    }
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function pullMore(target, maxTries = 40) {
    for (let i = 0; i < maxTries && store.size < target; i++) {
      window.scrollBy(0, window.innerHeight * 2);
      await sleep(250);
      scanNow();
    }
  }

  /* ---------------- rendering ---------------- */

  function ago(iso) {
    const secs = (Date.now() - new Date(iso).getTime()) / 1000;
    const units = [['year', 31536000], ['month', 2592000], ['day', 86400],
                   ['hour', 3600], ['minute', 60]];
    for (const [name, size] of units) {
      const n = Math.floor(secs / size);
      if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
    return 'just now';
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function renderRow(post, rank) {
    const label = { link: 'link', image: 'image', video: 'video',
                    gallery: 'gallery' }[post.type] || 'self';
    const thumb = post.thumb
      ? `<a href="${post.link}"><img src="${post.thumb}" alt=""></a>`
      : `<div class="or-thumb-blank">${label}</div>`;
    return `
      <div class="or-thing" data-post="${post.id}">
        <span class="or-rank">${rank}</span>
        <div class="or-mid">
          <div class="or-arrow or-up"></div>
          <div class="or-score">${post.score}</div>
          <div class="or-arrow or-down"></div>
        </div>
        <div class="or-thumb">${thumb}</div>
        <div class="or-entry">
          <a class="or-title" href="${post.link}">${esc(post.title)}</a>
          <span class="or-domain">&nbsp;(${esc(post.domain)})</span>
          <div class="or-tagline">
            submitted ${ago(post.created)} by
            <a href="/user/${post.author}">${esc(post.author)}</a>
            to <a href="/${post.subreddit}">${esc(post.subreddit)}</a>
          </div>
          <div class="or-buttons">
            ${post.media ? `<span class="or-expando" data-expand="${post.id}">+</span>` : ''}
            <a href="${post.permalink}">${post.comments} comments</a>
          </div>
          <div class="or-panel" data-panel="${post.id}" hidden></div>
        </div>
      </div>`;
  }

  /* ---------------- expando ---------------- */

  const galleryIndex = new Map();

  function mediaHtml(post) {
    const m = post.media;
    if (!m) return '';
    if (m.kind === 'image') {
      return `<img class="or-media" src="${m.images[0]}" alt="" loading="lazy">`;
    }
    if (m.kind === 'video') {
      if (!m.hls) return '<div class="or-note">no playable source found</div>';
      /* src is set after insertion - see attachVideo */
      const poster = m.poster ? ` poster="${m.poster}"` : '';
      return `<video class="or-media" controls playsinline${poster}></video>`;
    }
    if (m.kind === 'youtube') {
      /* Nothing is requested from YouTube until the expando is opened,
         since this markup is only built at that point.
         Swap the host for www.youtube-nocookie.com if you'd rather - but
         check it isn't blocked by reddit's frame-src first, as it's a
         different origin as far as CSP is concerned. */
      const src = 'https://www.youtube.com/embed/' + m.id +
                  '?rel=0' + (m.start ? '&start=' + m.start : '');
      return `<div class="or-embed">
                <iframe src="${src}"
                        title="YouTube video"
                        referrerpolicy="strict-origin-when-cross-origin"
                        allow="clipboard-write; encrypted-media; picture-in-picture"
                        allowfullscreen></iframe>
              </div>`;
    }
    if (m.kind === 'text') {
      return `<div class="or-md">${m.html}</div>`;
    }
    if (m.kind === 'gallery') {
      galleryIndex.set(post.id, 0);
      const have = m.images.length;
      const total = Math.max(m.expected || have, have);
      /* Reddit only ever loads the current slide plus fetch-ahead-count
         (3), so a long gallery is usually capped at four in the page.
         Say so rather than quietly presenting four as the whole post. */
      const nav = have > 1
        ? `<div class="or-gnav">
             <button type="button" data-gnav="prev" data-gid="${post.id}">&lt; prev</button>
             <span data-gcount="${post.id}">1 of ${have}</span>
             <button type="button" data-gnav="next" data-gid="${post.id}">next &gt;</button>
           </div>`
        : '';
      const short = have < total
        ? `<div class="or-note" data-gshort="${post.id}">only ${have} of ${total} available &mdash;
             <a href="${post.permalink}">open the post</a> for the rest</div>`
        : '';
      /* Nav sits above the image on purpose: image heights vary, so
         controls below would shift under the cursor between slides. */
      return `
        ${nav}
        <img class="or-media" data-gimg="${post.id}" src="${m.images[0]}" alt="" loading="lazy">
        <div class="or-note" data-gstatus="${post.id}"></div>
        ${short}`;
    }
    return '';
  }

  const players = new Map();

  function destroyPlayer(id) {
    const inst = players.get(id);
    if (inst) { try { inst.destroy(); } catch (e) {} players.delete(id); }
  }

  function destroyAllPlayers() {
    for (const id of [...players.keys()]) destroyPlayer(id);
  }

  function videoFailed(panel, post, why) {
    panel.innerHTML =
      `<div class="or-note">couldn't play this video (${why}) - ` +
      `<a href="${post.permalink}">open on reddit</a></div>`;
  }

  function attachVideo(post, panel) {
    const m = post.media;
    const video = panel.querySelector('video');
    if (!video || !m || !m.hls) return;

    log('attachVideo', post.id, '| hls url:', (m.hls || '').slice(0, 90));

    if (DEBUG) {
      for (const ev of ['error', 'stalled', 'waiting', 'canplay', 'playing', 'loadedmetadata']) {
        video.addEventListener(ev, () => {
          const err = video.error;
          log('video event:', ev, err ? `code=${err.code} ${err.message || ''}` : '',
              '| readyState=' + video.readyState + ' networkState=' + video.networkState);
        });
      }
    }

    /* hls.js is tried FIRST, deliberately.
       canPlayType() returns "", "maybe" or "probably" - and Chrome answers
       "maybe" for HLS despite being unable to play it. Checking native
       support first therefore routes Chrome down the native path, where it
       fails with SRC_NOT_SUPPORTED. Only fall back to native when hls.js
       genuinely isn't available, which in practice means Safari. */
    if (typeof Hls === 'undefined' || !Hls.isSupported()) {
      if (video.canPlayType('application/vnd.apple.mpegURL')) {
        log('hls.js unavailable - falling back to native HLS');
        video.src = m.hls;
        return;
      }
      log('NO HLS SUPPORT. Hls is', typeof Hls);
      videoFailed(panel, post, 'no HLS support');
      return;
    }

    log('using hls.js');

    /* Workers are disabled deliberately: hls.js spawns them from blob URLs,
       which is an easy thing for a page's CSP to refuse. Costs some CPU,
       removes a whole category of failure. Revisit once this is proven. */
    const hls = new Hls({ enableWorker: false });
    players.set(post.id, hls);

    if (DEBUG) {
      for (const name of ['MEDIA_ATTACHED', 'MANIFEST_LOADING', 'MANIFEST_LOADED',
                          'MANIFEST_PARSED', 'LEVEL_LOADED', 'FRAG_LOADED']) {
        if (Hls.Events[name]) {
          hls.on(Hls.Events[name], () => log('hls:', name));
        }
      }
    }

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      log('hls ERROR', {
        fatal: data.fatal,
        type: data.type,
        details: data.details,
        reason: data.reason,
        status: data.response && data.response.code,
        text: data.response && String(data.response.text || '').slice(0, 120),
        url: (data.url || '').slice(0, 100),
      });
      if (!data.fatal) return;
      /* The manifest URL is signed and expires - a stale one lands here. */
      videoFailed(panel, post, data.details || data.type);
      destroyPlayer(post.id);
    });

    hls.loadSource(m.hls);
    hls.attachMedia(video);
  }

  /* querySelector stops at shadow boundaries, and the carousel's controls
     live inside one. This walks through them. */
  function deepQuery(root, selector, depth = 0) {
    if (depth > 8) return null;
    const direct = root.querySelector(selector);
    if (direct) return direct;
    for (const n of root.querySelectorAll('*')) {
      if (!n.shadowRoot) continue;
      const found = deepQuery(n.shadowRoot, selector, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function findCarouselNext(el) {
    const selectors = [
      'button[aria-label*="next" i]',
      'button[aria-label*="forward" i]',
      '[data-testid*="next"]',
    ];
    for (const sel of selectors) {
      const found = deepQuery(el, sel);
      if (found) return { sel, node: found };
    }
    return null;
  }

  /* A gallery only loads its current slide plus three ahead, and only once
     the post has been near the viewport. Both are things we can cause:
     scroll the hidden page to it, then walk the carousel forward. No
     synthetic requests - Reddit fetches its own media, as if you'd swiped. */
  async function completeGallery(post) {
    const m = post.media;
    if (!m || m.kind !== 'gallery' || m.images.length >= m.expected) return false;

    const el = document.querySelector(
      REDDIT.postElement + '[' + REDDIT.attr.id + '="' + post.id + '"]'
    );
    if (!el) { log('gallery: post already recycled out of the page'); return false; }

    el.scrollIntoView({ block: 'center' });
    await sleep(500);

    let best = captureMedia(el) || m;
    log('gallery after scroll:', best.images.length, 'of', best.expected);

    const first = findCarouselNext(el);
    log('gallery next control:', first ? first.sel : 'NOT FOUND');

    let guard = 0;
    while (best.images.length < best.expected && guard++ < 40) {
      const next = findCarouselNext(el);
      if (!next) break;
      next.node.click();
      await sleep(320);
      const now = captureMedia(el);
      if (now && now.images.length > best.images.length) best = now;
      else break;              /* stopped yielding anything new */
    }

    if (best.images.length > m.images.length) {
      post.media = best;
      log('gallery completed:', best.images.length, 'of', best.expected);
      return true;
    }
    return false;
  }

  function toggleExpando(id, btn) {
    const post = store.get(id);
    const panel = document.querySelector('[data-panel="' + id + '"]');
    if (!post || !panel) return;

    if (!panel.hidden) {
      destroyPlayer(id);
      panel.hidden = true;
      panel.innerHTML = '';
      btn.textContent = '+';
      return;
    }
    panel.innerHTML = mediaHtml(post);
    panel.hidden = false;
    btn.textContent = '\u2212';
    if (post.media?.kind === 'video') attachVideo(post, panel);

    /* Show what we have straight away, then fetch the rest behind it. */
    if (post.media?.kind === 'gallery' && post.media.images.length < post.media.expected) {
      const status = panel.querySelector('[data-gstatus]');
      if (status) status.textContent = 'loading the rest of the gallery...';
      /* Don't tell the reader images are missing while we're still
         fetching them - only after the attempt has actually fallen short. */
      panel.querySelector('[data-gshort]')?.remove();

      completeGallery(post).then(() => {
        if (panel.hidden) return;              /* collapsed while we worked */
        panel.innerHTML = mediaHtml(post);     /* redraw with whatever we ended up with */
      });
    }
  }

  function stepGallery(id, delta) {
    const post = store.get(id);
    if (!post || post.media?.kind !== 'gallery') return;
    const images = post.media.images;
    const next = (galleryIndex.get(id) + delta + images.length) % images.length;
    galleryIndex.set(id, next);
    const img = document.querySelector('[data-gimg="' + id + '"]');
    const count = document.querySelector('[data-gcount="' + id + '"]');
    if (img) img.src = images[next];
    if (count) count.textContent = `${next + 1} of ${images.length}`;
  }

  function wireExpando(list) {
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('.or-expando');
      if (btn) { toggleExpando(btn.dataset.expand, btn); return; }
      const nav = e.target.closest('[data-gnav]');
      if (nav) stepGallery(nav.dataset.gid, nav.dataset.gnav === 'next' ? 1 : -1);
    });
  }

  function updateStatus() {
    const el = document.getElementById('or-status');
    if (el) el.textContent = `${store.size} collected`;
  }

  function draw() {
    destroyAllPlayers();
    const all = [...store.values()];
    const slice = all.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
    const list = document.getElementById('or-list');
    if (!list) return;
    list.innerHTML = slice.map((p, i) => renderRow(p, page * PER_PAGE + i + 1)).join('')
      || '<div class="or-empty">waiting for posts...</div>';
    rendered = slice.length;
    document.getElementById('or-prev').disabled = page === 0;
    document.getElementById('or-root').scrollTop = 0;
    updateStatus();
  }

  /* Posts keep arriving after a page is drawn. Append the new ones
     rather than re-rendering, so images don't flicker and the scroll
     position stays put. */
  function topUp() {
    if (rendered >= PER_PAGE) return;
    const all = [...store.values()];
    const slice = all.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
    if (slice.length <= rendered) return;

    const list = document.getElementById('or-list');
    if (!list) return;
    if (rendered === 0) { draw(); return; }

    const fresh = slice.slice(rendered)
      .map((p, i) => renderRow(p, page * PER_PAGE + rendered + i + 1))
      .join('');
    list.insertAdjacentHTML('beforeend', fresh);
    rendered = slice.length;
  }

  async function goNext(btn) {
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = 'loading...';
    await pullMore((page + 2) * PER_PAGE);
    page++;
    btn.textContent = was;
    btn.disabled = false;
    draw();
  }

  function showOriginal() {
    /* On comment pages Reddit's own tree is living inside our container -
       put it back before removing it, or we delete their content. */
    restoreCommentTree();
    restoreUserFeed();
    document.documentElement.classList.remove('or-hide');
    document.getElementById('or-root')?.remove();
    observer.disconnect();
  }

  /* ---------------- boot ---------------- */

  /* ---------------- sidebar ---------------- */

  const SUBREDDIT = (location.pathname.match(/^\/r\/([^/]+)/) || [])[1] || null;
  /* Only BARE user URLs are profile pages. /user/x/comments/<id>/<slug>/ is a
     post - Reddit files profile posts under /user/, so the anchor matters. */
  const USER_MATCH =
    location.pathname.match(/^\/user\/([^/]+)\/?(overview|comments|submitted)?\/?$/);
  const USER = USER_MATCH ? USER_MATCH[1] : null;
  const USER_TAB = (USER_MATCH && USER_MATCH[2]) || 'overview';

  /* Without the USER guard this would swallow /user/x/comments/. */
  const COMMENTS_PAGE = !USER && /\/comments\//.test(location.pathname);
  let sidebar = null;

  function captureSidebar() {
    const header = document.querySelector(REDDIT.subredditHeader);
    if (!header) return null;

    const ha = REDDIT.headerAttr;
    const get = (k) => header.getAttribute(ha[k]) || '';
    const num = (k) => parseInt(get(k).replace(/[^0-9]/g, ''), 10) || null;

    const data = {
      name: get('name') || ('r/' + SUBREDDIT),
      displayName: get('displayName'),
      description: get('description'),
      activeUsers: num('activeUsers'),
      contributions: num('contributions'),
      rules: [],
    };

    /* Each rule is a <details> whose body carries an id of rule-<uuid>.
       The body is the same rtjson markdown shape as a self-post, so it
       goes through the same sanitiser. */
    for (const body of document.querySelectorAll(REDDIT.ruleBody)) {
      const details = body.closest('details');
      const summary = details && details.querySelector('summary');
      const title = summary
        ? summary.textContent.trim().replace(/\s+/g, ' ').replace(/^\d+\s*/, '')
        : '';
      data.rules.push({ title, html: sanitize(body) });
    }

    if (!data.description && !data.rules.length) return null;
    return data;
  }

  function renderSidebar() {
    const box = document.getElementById('or-side');
    if (!box || !sidebar) return;

    const stat = (n, label) =>
      n ? `<div class="or-stat"><span class="or-statnum">${n.toLocaleString()}</span> ${label}</div>` : '';

    const rules = sidebar.rules.length
      ? `<div class="or-box">
           <h2 class="or-boxhead">${esc(sidebar.name)} Rules</h2>
           <ol class="or-rules">
             ${sidebar.rules.map((r) => `
               <li>
                 <div class="or-ruletitle">${esc(r.title)}</div>
                 <div class="or-md or-rulebody">${r.html}</div>
               </li>`).join('')}
           </ol>
         </div>`
      : '';

    box.innerHTML = `
      <a class="or-submit" href="/r/${SUBREDDIT}/submit">Submit a new post</a>
      <form class="or-search" data-search>
        <input type="text" name="q" placeholder="search this subreddit" autocomplete="off">
      </form>
      <div class="or-box">
        <h2 class="or-boxhead">${esc(sidebar.name)}</h2>
        ${sidebar.displayName ? `<div class="or-subtitle">${esc(sidebar.displayName)}</div>` : ''}
        ${sidebar.description ? `<p class="or-desc">${esc(sidebar.description)}</p>` : ''}
        ${stat(sidebar.activeUsers, 'weekly active users')}
        ${stat(sidebar.contributions, 'weekly contributions')}
      </div>
      ${rules}`;

    const form = box.querySelector('[data-search]');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const q = form.querySelector('input').value.trim();
        if (!q) return;
        location.href = `/r/${SUBREDDIT}/search?q=${encodeURIComponent(q)}&restrict_sr=1`;
      });
    }
  }

  function retrySidebar() {
    if (!SUBREDDIT || sidebar) return;
    const found = captureSidebar();
    if (found) {
      sidebar = found;
      log('sidebar captured |', found.rules.length, 'rules');
      renderSidebar();
    }
  }

  /* ---------------- header ---------------- */

  /* Which sort is showing, from the URL. Old reddit put this in the tab bar. */
  function currentSort() {
    const m = location.pathname.match(/\/(best|hot|new|rising|controversial|top)\/?$/);
    if (m) return m[1];
    return SUBREDDIT ? 'hot' : 'best';
  }

  /* Reddit takes the period for /top as ?t=<key>. */
  const TIME_RANGES = [
    ['hour',  'past hour'],
    ['day',   'past 24 hours'],
    ['week',  'past week'],
    ['month', 'past month'],
    ['year',  'past year'],
    ['all',   'all time'],
  ];

  function timeBarHtml(base) {
    if (currentSort() !== 'top') return '';

    /* Our own /top tab always carries ?t=day, so the label matches the
       actual listing rather than guessing at reddit's default. */
    const current = new URLSearchParams(location.search).get('t') || 'day';
    const label = (TIME_RANGES.find(([k]) => k === current) || TIME_RANGES[1])[1];

    const items = TIME_RANGES
      .filter(([key]) => key !== current)
      .map(([key, text]) => `<li><a href="${base}/top/?t=${key}">${text}</a></li>`)
      .join('');

    return `
      <div id="or-timebar">
        links from:
        <details id="or-timesel">
          <summary>${label}</summary>
          <ul>${items}</ul>
        </details>
      </div>`;
  }

  function headerHtml() {
    const base = SUBREDDIT ? `/r/${SUBREDDIT}` : '';
    const sorts = SUBREDDIT
      ? ['hot', 'new', 'top', 'rising']
      : ['best', 'hot', 'new', 'top', 'rising'];
    const active = currentSort();

    const tabs = sorts.map((sort) => {
      const href = sort === 'top' ? `${base}/top/?t=day` : `${base}/${sort}/`;
      return `<li class="${sort === active ? 'or-tab-on' : ''}">` +
             `<a href="${href}">${sort}</a></li>`;
    }).join('');

    const logo = chrome.runtime.getURL('images/reddit-logo.png');

    return `
      <div id="or-topbar">
        <span class="or-topnav">
          <a href="/">home</a>
          <a href="/r/popular/">popular</a>
          <a href="/r/all/">all</a>
        </span>
        <span class="or-topright">
          <span id="or-status">starting...</span>
          <button id="or-off" type="button">show original reddit</button>
        </span>
      </div>
      <div id="or-brand">
        <a href="/"><img id="or-logo" src="${logo}" alt="reddit"></a>
        ${SUBREDDIT ? `<a id="or-srname" href="${base}/">${esc(SUBREDDIT)}</a>` : ''}
        <ul id="or-tabs">${tabs}</ul>
      </div>
      ${timeBarHtml(base)}`;
  }

  function buildShell() {
    const root = document.createElement('div');
    root.id = 'or-root';
    root.innerHTML = `
      <div id="or-inner">
        ${headerHtml()}
        <div id="or-body">
          <div id="or-content">
            <div id="or-list"><div class="or-empty">waiting for posts...</div></div>
            <div id="or-nav">
              <button id="or-prev" type="button" disabled>&lt; prev</button>
              <button id="or-next" type="button">next &gt;</button>
            </div>
          </div>
          ${SUBREDDIT ? '<div id="or-side"></div>' : ''}
        </div>
      </div>`;
    document.body.appendChild(root);
    document.getElementById('or-prev').onclick = () => { page--; draw(); };
    document.getElementById('or-next').onclick = (e) => goNext(e.currentTarget);
    document.getElementById('or-off').onclick = showOriginal;
    wireExpando(document.getElementById('or-list'));
  }

  function firstDraw() {
    started = true;
    draw();
  }

  /* ================= comments =================
     REBUILT, not restyled. The first version of this file rebuilt them,
     the second borrowed Reddit's tree, and this is a return to rebuilding
     - for a concrete reason rather than taste.

     Two requirements settle it: the score has to sit beside the username
     (it lives in a different branch of Reddit's DOM, so CSS cannot move
     it), and "N more replies" has to read "load more comments (N replies)"
     (that is text content, which CSS cannot rewrite).

     Rebuilding is also easier here than anywhere else in the extension:
     shreddit-comment carries thingid, parentid, depth, author, score,
     created and permalink as attributes. Only the body comes from the DOM.
     ============================================ */

  const COMMENT = {
    tree: 'shreddit-comment-tree',
    element: 'shreddit-comment',
    body: '[id$="-comment-rtjson-content"]',
    moreLink: 'a[slot="more-comments-permalink"]',
    attr: {
      id: 'thingid',
      parent: 'parentid',
      depth: 'depth',
      author: 'author',
      score: 'score',
      created: 'created',
      permalink: 'permalink',
    },
  };

  const COMMENT_SORTS = ['top', 'new', 'controversial', 'old', 'qa'];

  const comments = new Map();      /* id -> comment, insertion order */
  let commentsDrawn = false;
  let postHeaderDone = false;

  function captureComments() {
    let added = 0;
    for (const el of document.querySelectorAll(COMMENT.element)) {
      const get = (k) => el.getAttribute(COMMENT.attr[k]) || '';
      const id = get('id');
      if (!id || comments.has(id)) continue;

      const bodyEl = el.querySelector(COMMENT.body);

      /* "N more replies" belongs to THIS comment only - querySelectorAll
         would also return the ones inside nested replies. */
      let more = null;
      for (const a of el.querySelectorAll(COMMENT.moreLink)) {
        if (a.closest(COMMENT.element) !== el) continue;
        const n = (a.textContent || '').match(/([\d,]+)/);
        more = { href: a.getAttribute('href'), count: n ? n[1] : '' };
        break;
      }

      comments.set(id, {
        id,
        parent: get('parent') || null,
        depth: parseInt(get('depth'), 10) || 0,
        author: get('author'),
        score: parseInt(get('score'), 10),
        created: get('created'),
        permalink: get('permalink'),
        body: bodyEl ? sanitize(bodyEl) : '',
        more,
      });
      added++;
    }
    return added;
  }

  function commentHtml(c, isShut) {
    const score = Number.isFinite(c.score)
      ? `${c.score} point${c.score === 1 ? '' : 's'}`
      : '';
    /* The vote column is a sibling of EVERYTHING else, not just the body -
       old reddit puts the arrows to the left of the tagline, the text and
       the links alike. Nesting them beside the body alone starts them a
       line too low. */
    return `
      <div class="or-crow">
        <div class="or-cvote">
          <div class="or-arrow or-up"></div>
          <div class="or-arrow or-down"></div>
        </div>
        <div class="or-cmain">
          <div class="or-chead">
            <button class="or-ctoggle" type="button" data-cid="${c.id}">${
              isShut ? '[+]' : '[&ndash;]'}</button>
            <a class="or-cauthor" href="/user/${esc(c.author)}/">${esc(c.author)}</a>
            <span class="or-cscore">${score}</span>
            <span class="or-ctime">${ago(c.created)}</span>
          </div>
          <div class="or-ctext">
            <div class="or-md">${c.body}</div>
            <div class="or-clinks">
              <a href="${c.permalink}">permalink</a>
              <a href="${c.permalink}?context=3">context</a>
            </div>
          </div>
        </div>
      </div>`;
  }

  function drawComments() {
    const slot = document.getElementById('or-ctree');
    if (!slot || !comments.size) return;

    const byParent = new Map();
    for (const c of comments.values()) {
      const key = c.parent && comments.has(c.parent) ? c.parent : 'root';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(c);
    }

    const renderKids = (key, depth) => {
      const kids = byParent.get(key);
      if (!kids) return '';
      return kids.map((c) => {
        /* A button, not a link: the link navigates, and old reddit
           expanded these in place. The click drives Reddit's own hidden
           "more replies" control, which fetches into the hidden tree
           where captureComments() picks the replies up. */
        const more = c.more
          ? `<div class="or-cmore" data-more="${c.id}">
               <button type="button" class="or-cmorebtn" data-more-id="${c.id}">load more comments</button>
               <span class="or-cdim">(${esc(c.more.count)} replies)</span>
               <a class="or-cmorelink" href="${c.more.href}">open thread</a>
             </div>`
          : '';
        /* Nested markup rather than indent-by-margin: the dotted guide
           lines are a border on the child container, which only forms an
           unbroken line if children are genuinely nested. */
        const isShut = collapsed.has(c.id);
        return `<div class="or-c${isShut ? ' or-collapsed' : ''}" data-cid="${c.id}">
                  ${commentHtml(c, isShut)}
                  <div class="or-ckids">${renderKids(c.id, depth + 1)}${more}</div>
                </div>`;
      }).join('');
    };

    slot.innerHTML = renderKids('root', 0);
    commentsDrawn = true;

    const status = document.getElementById('or-status');
    if (status) status.textContent = `${comments.size} comments`;
  }

  /* Redrawing replaces the whole tree, so collapse state has to live
     outside the DOM or it resets every time new comments arrive. */
  const collapsed = new Set();

  function wireCommentToggles(slot) {
    if (slot.dataset.orToggles) return;
    slot.dataset.orToggles = '1';

    slot.addEventListener('click', (e) => {
      const toggle = e.target.closest('.or-ctoggle');
      if (toggle) {
        e.preventDefault();
        const box = toggle.closest('.or-c');
        if (!box) return;
        const id = box.dataset.cid;
        const now = box.classList.toggle('or-collapsed');
        if (now) collapsed.add(id); else collapsed.delete(id);
        toggle.innerHTML = now ? '[+]' : '[&ndash;]';
        return;
      }

      const more = e.target.closest('.or-cmorebtn');
      if (more) {
        e.preventDefault();
        expandReplies(more.dataset.moreId, more);
      }
    });
  }

  /* Reddit's own control lives beside the permalink we captured. Look it
     up at click time rather than storing a node - Reddit replaces these
     elements as the tree loads. */
  function findMoreControl(id) {
    const host = document.querySelector(
      `${COMMENT.element}[${COMMENT.attr.id}="${id}"]`);
    if (!host) return null;
    for (const el of host.querySelectorAll('button, faceplate-partial')) {
      if (el.closest(COMMENT.element) !== host) continue;
      const label = (el.textContent || '').trim();
      if (/more repl/i.test(label)) return el;
    }
    return null;
  }

  async function expandReplies(id, btn) {
    const control = findMoreControl(id);
    if (!control) {
      /* Nothing to click - fall back to the link rather than doing nothing
         silently, since the replies do exist on the linked page. */
      log('no more-replies control for', id, '- falling back to link');
      const link = btn.parentElement.querySelector('.or-cmorelink');
      if (link) hardNavigate(link.href);
      return;
    }

    btn.disabled = true;
    btn.textContent = 'loading...';
    const before = comments.size;

    control.click();
    for (let i = 0; i < 12; i++) {
      await sleep(400);
      if (captureComments() && comments.size > before) break;
    }

    log('expand replies', id, ':', before, '->', comments.size);
    if (comments.size > before) {
      const c = comments.get(id);
      if (c) c.more = null;           /* replies are in the tree now */
      drawComments();
    } else {
      btn.disabled = false;
      btn.textContent = 'load more comments';
    }
  }

  function postHeaderHtml(post) {
    const expando = post.media
      ? `<button class="or-expando" type="button" data-expand="${post.id}">+</button>`
      : '';
    return `
      <div class="or-pheader">
        <div class="or-pscore">
          <div class="or-arrow or-up"></div>
          <div class="or-pnum">${post.score}</div>
          <div class="or-arrow or-down"></div>
        </div>
        <div class="or-pmain">
          <a class="or-ptitle" href="${post.link || post.permalink}">${esc(post.title)}</a>
          <span class="or-domain">(${esc(post.domain)})</span>
          <div class="or-tagline">
            submitted ${ago(post.created)} by
            <a href="/user/${esc(post.author)}/">${esc(post.author)}</a>
            to <a href="/${esc(post.sub)}/">${esc(post.sub)}</a>
          </div>
          ${expando}
          <div class="or-panel" data-panel="${post.id}" hidden></div>
          <div class="or-plinks">${post.comments} comments</div>
        </div>
      </div>`;
  }

  function sortBarHtml() {
    const current = new URLSearchParams(location.search).get('sort') || 'top';
    const items = COMMENT_SORTS
      .map((x) => `<li><a href="?sort=${x}">${x}</a></li>`).join('');
    return `
      <div id="or-cbar">
        <span>sorted by:</span>
        <details class="or-sortmenu">
          <summary>${esc(current)}</summary>
          <ul>${items}</ul>
        </details>
      </div>`;
  }

  /* The post is rendered with its expando CLOSED and then opened
     programmatically, so video attachment and gallery completion run
     through the feed's own toggleExpando rather than a second copy. */
  function renderPostHeader() {
    if (postHeaderDone) return;
    const el = document.querySelector(REDDIT.postElement);
    const head = document.getElementById('or-post');
    if (!el || !head) return;

    const post = extract(el);
    if (!post || !post.id) return;
    store.set(post.id, post);

    head.innerHTML = postHeaderHtml(post);
    postHeaderDone = true;

    const btn = head.querySelector('.or-expando');
    if (btn) toggleExpando(post.id, btn);      /* open on arrival */
    log('post header |', post.media ? post.media.kind : 'no media');
  }

  async function loadMoreComments(btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'loading...'; }
    const before = comments.size;
    for (let i = 0; i < 10; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(500);
      if (captureComments() && comments.size >= before + 25) break;
    }
    window.scrollTo(0, 0);
    log('load more comments:', before, '->', comments.size);
    drawComments();
    if (btn) { btn.disabled = false; btn.textContent = 'load more comments'; }
  }

  function bootComments() {
    const root = document.createElement('div');
    root.id = 'or-root';
    root.innerHTML = `
      <div id="or-inner">
        ${headerHtml()}
        <div id="or-body">
          <div id="or-content">
            <div id="or-post"></div>
            ${sortBarHtml()}
            <div id="or-ctree"><div class="or-empty">waiting for comments...</div></div>
            <div id="or-cnav">
              <button id="or-cmore" type="button">load more comments</button>
            </div>
          </div>
          ${SUBREDDIT ? '<div id="or-side"></div>' : ''}
        </div>
      </div>`;
    document.body.appendChild(root);
    document.getElementById('or-off').onclick = showOriginal;

    const slot = document.getElementById('or-ctree');
    wireCommentToggles(slot);
    wireExpando(document.getElementById('or-post'));

    const more = document.getElementById('or-cmore');
    if (more) more.onclick = () => loadMoreComments(more);

    const tick = () => {
      renderPostHeader();
      if (captureComments()) drawComments();
    };
    tick();
    const poll = setInterval(tick, 400);

    const observer = new MutationObserver(tick);
    const watch = setInterval(() => {
      const tree = document.querySelector(COMMENT.tree);
      if (!tree) return;
      clearInterval(watch);
      observer.observe(tree, { childList: true, subtree: true });
    }, 200);

    retrySidebar();
    setInterval(retrySidebar, 1000);

    setTimeout(() => {
      clearInterval(poll);
      if (!commentsDrawn && !postHeaderDone) {
        console.warn('[old-reddit-restyle] nothing found on comments page - restoring');
        showOriginal();
      }
    }, GIVE_UP_MS);
  }

  /* Nothing is borrowed any more - kept so showOriginal stays valid. */
  function restoreCommentTree() {}

  /* ================= user pages =================
     REBUILT, not restyled - unlike comment pages.

     The deciding evidence: shreddit-post carries everything in attributes
     (post-title, score, author, created-timestamp, comment-count, domain),
     and shreddit-profile-comment carries a score attribute on its action
     row plus a timestamp on faceplate-timeago. Only the comment BODY has
     to be read from rendered DOM.

     Rebuilding also fixes three things restyling could not: Reddit's card
     padding (which no amount of un-padding flattened), the "ADMIN replied
     to" tagline, and expandos - the toggle is now our own element rather
     than a button inside Reddit's clickable card, which is what kept
     hijacking the click.

     Reddit's feed stays on the page, hidden, and is scrolled to load more.
     ============================================ */

  const userItems = new Map();          /* id -> item, insertion order = page order */
  let userBodySelector = null;          /* which selector actually worked */
  let userDrawn = false;

  /* The body is definitely rendered - the earlier probe just had the wrong
     selector. Try candidates and report the winner instead of guessing. */
  const COMMENT_BODY_SELECTORS = [
    '[id$="-comment-rtjson-content"]',
    '[id*="rtjson"]',
    '[slot="comment"]',
    '.md',
  ];

  function findCommentBody(el) {
    for (const sel of COMMENT_BODY_SELECTORS) {
      const found = el.querySelector(sel);
      if (found && (found.textContent || '').trim()) {
        if (!userBodySelector) {
          userBodySelector = sel;
          log('comment body found via', sel);
        }
        return found;
      }
    }
    if (!userBodySelector) log('WARNING: no comment body selector matched');
    return null;
  }

  /* /r/foo/comments/... -> r/foo   |   /user/bar/comments/... -> u/bar */
  function subFromHref(href) {
    if (!href) return null;
    const r = href.match(/^\/r\/([^/]+)/);
    if (r) return 'r/' + r[1];
    const u = href.match(/^\/user\/([^/]+)/);
    if (u) return 'u/' + u[1];
    return null;
  }

  /* A post on a profile is the same object as a post in the feed, so it
     goes through the feed's own extract() - which brings thumbnails,
     media capture and the expando along with it for free. */
  function capturePost(el) {
    const post = extract(el);
    post.kind = 'post';
    return post;
  }

  function captureProfileComment(el) {
    const link = [...el.querySelectorAll('a[href*="/comments/"]')]
      .find((a) => (a.textContent || '').trim());
    const row = el.querySelector('shreddit-comment-action-row');
    const time = el.querySelector('faceplate-timeago');
    const body = findCommentBody(el);
    if (!link) return null;

    const postHref = link.getAttribute('href');
    return {
      kind: 'comment',
      id: el.getAttribute('comment-id'),
      postTitle: (link.textContent || '').trim(),
      postHref,
      sub: subFromHref(postHref),
      score: parseInt(row && row.getAttribute('score'), 10),
      created: time ? (time.getAttribute('ts') || time.getAttribute('datetime')) : '',
      permalink: el.getAttribute('href'),
      body: body ? sanitize(body) : '',
    };
  }

  function captureUserItems() {
    const feed = document.querySelector('shreddit-feed');
    if (!feed) return 0;
    let added = 0;
    /* querySelectorAll returns document order, so chronology survives the
       feed being split across lazily-appended chunks. */
    for (const el of feed.querySelectorAll('shreddit-post, shreddit-profile-comment')) {
      const id = el.getAttribute('id') || el.getAttribute('comment-id');
      if (!id || userItems.has(id)) continue;
      const item = el.tagName.toLowerCase() === 'shreddit-post'
        ? capturePost(el)
        : captureProfileComment(el);
      if (item && item.id) { userItems.set(id, item); added++; }
    }
    return added;
  }

  function userRowHtml(it) {
    const sub = it.sub || '';
    const subLink = sub ? `<a href="/${sub}/">${esc(sub)}</a>` : '';

    if (it.kind === 'comment') {
      const score = Number.isFinite(it.score) ? it.score : null;
      /* No "by <author>" here: old reddit names the POST's author, and the
         profile comment row doesn't carry it - the only other name present
         is the parent commenter ("replied to X"), which is a different
         person. Showing the profile owner would be confidently wrong, so
         the subreddit stands alone. */
      return `
        <div class="or-urow or-ucomment">
          <div class="or-uhead">
            <a class="or-ulink" href="${it.postHref}">${esc(it.postTitle)}</a>
            ${sub ? `<span class="or-udim">in ${subLink}</span>` : ''}
          </div>
          <div class="or-ucols">
            <div class="or-uvote">
              <div class="or-arrow or-up"></div>
              <div class="or-arrow or-down"></div>
            </div>
            <div class="or-ubody-col">
              <div class="or-utag">[&ndash;]
                <a class="or-uauthor" href="/user/${esc(USER)}/">${esc(USER)}</a>
                ${score === null ? '' : `${score} point${score === 1 ? '' : 's'}`}
                ${ago(it.created)}
              </div>
              <div class="or-md or-ubody">${it.body}</div>
              <div class="or-ulinks">
                <a href="${it.permalink}">permalink</a>
                <a href="${it.postHref}">full comments</a>
              </div>
            </div>
          </div>
        </div>`;
    }

    /* No rank number on profiles - old reddit didn't number these. */
    return renderRow(it, '');
  }

  let userPage = 0;

  function drawUser() {
    const slot = document.getElementById('or-ufeed');
    if (!slot || !userItems.size) return;

    destroyAllPlayers();
    const all = [...userItems.values()];
    const slice = all.slice(userPage * PER_PAGE, (userPage + 1) * PER_PAGE);
    const hasMorePages = all.length > (userPage + 1) * PER_PAGE;

    slot.innerHTML =
      (slice.map(userRowHtml).join('') ||
       '<div class="or-empty">waiting for activity...</div>') +
      `<div id="or-unav">
         <button id="or-uprev" type="button"${userPage ? '' : ' disabled'}>&lsaquo; prev</button>
         <span class="or-upage">page ${userPage + 1}</span>
         <button id="or-unext" type="button">next &rsaquo;</button>
       </div>`;
    userDrawn = true;

    document.getElementById('or-uprev').onclick = () => {
      if (!userPage) return;
      userPage--;
      drawUser();
    };

    /* Next either turns the page or, at the end of what's captured,
       scrolls Reddit's hidden feed for more first. */
    document.getElementById('or-unext').onclick = async (e) => {
      if (hasMorePages) { userPage++; drawUser(); return; }
      const btn = e.currentTarget;
      const before = userItems.size;
      await loadMoreUser(btn);
      if (userItems.size > before) { userPage++; drawUser(); }
    };

    const root = document.getElementById('or-root');
    if (root) root.scrollTop = 0;

    const status = document.getElementById('or-status');
    if (status) status.textContent = `${userItems.size} collected`;
  }

  /* Posts now render with renderRow, so they carry the feed's own expando
     markup - wireExpando handles images, galleries, video and self text. */
  function installUserExpandos() {
    const slot = document.getElementById('or-ufeed');
    if (!slot || slot.dataset.orExpandos) return;
    slot.dataset.orExpandos = '1';
    wireExpando(slot);
  }

  /* Reddit's feed is hidden but still laid out, so scrolling the real page
     drives its loader - same trick the front page uses. */
  async function loadMoreUser(btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'loading...'; }
    const before = userItems.size;

    for (let i = 0; i < 10; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(500);
      if (captureUserItems() && userItems.size >= before + PER_PAGE) break;
    }
    window.scrollTo(0, 0);

    log('load more:', before, '->', userItems.size);
    if (btn) { btn.disabled = false; btn.innerHTML = 'next &rsaquo;'; }
    if (userItems.size === before) {
      const nav = document.getElementById('or-unav');
      if (nav) nav.innerHTML = '<span class="or-upage">no more items</span>';
    }
  }

  function userHeaderHtml() {
    const base = `/user/${USER}`;
    const tabs = [
      ['overview', `${base}/`],
      ['comments', `${base}/comments/`],
      ['submitted', `${base}/submitted/`],
    ].map(([name, href]) =>
      `<li class="${name === USER_TAB ? 'or-tab-on' : ''}">` +
      `<a href="${href}">${name}</a></li>`).join('');

    /* Reddit showed no sort control on the logged-out profile, so these are
       built rather than copied - ?sort= is unverified and may do nothing. */
    const current = new URLSearchParams(location.search).get('sort') || 'new';
    const items = ['new', 'hot', 'top', 'controversial']
      .map((s) => `<li><a href="?sort=${s}">${s}</a></li>`).join('');

    const logo = chrome.runtime.getURL('images/reddit-logo.png');

    return `
      <div id="or-topbar">
        <span class="or-topnav">
          <a href="/">home</a>
          <a href="/r/popular/">popular</a>
          <a href="/r/all/">all</a>
        </span>
        <span class="or-topright">
          <span id="or-status">starting...</span>
          <button id="or-off" type="button">show original reddit</button>
        </span>
      </div>
      <div id="or-brand">
        <a href="/"><img id="or-logo" src="${logo}" alt="reddit"></a>
        <a id="or-srname" href="/user/${USER}/">${esc(USER)}</a>
        <ul id="or-tabs">${tabs}</ul>
      </div>
      <div id="or-timebar">sorted by:
        <details class="or-sortmenu">
          <summary>${current}</summary>
          <ul>${items}</ul>
        </details>
      </div>`;
  }

  /* Karma is plain text on the page, not an attribute, so read it as text. */
  function userKarma() {
    const t = document.body.textContent || '';
    const post = (t.match(/([\d,]+)\s*post karma/i) || [])[1];
    const comment = (t.match(/([\d,]+)\s*comment karma/i) || [])[1];
    const age = (t.match(/redditor for ([a-z0-9 ]{1,24})/i) || [])[1];
    return (post || comment) ? { post, comment, age } : null;
  }

  function renderUserSidebar() {
    const side = document.getElementById('or-side');
    if (!side || side.dataset.done) return;
    const k = userKarma();
    if (!k) return;

    side.innerHTML = `
      <div class="or-box">
        <div class="or-username">${esc(USER)}</div>
        <div class="or-karma">
          <div><b>${esc(k.post || '?')}</b> post karma</div>
          <div><b>${esc(k.comment || '?')}</b> comment karma</div>
        </div>
        ${k.age ? `<div class="or-age">redditor for ${esc(k.age.trim())}</div>` : ''}
      </div>`;
    side.dataset.done = '1';
  }

  /* Kept so showOriginal stays valid - nothing is borrowed any more. */
  function restoreUserFeed() {}

  function bootUser() {
    const root = document.createElement('div');
    root.id = 'or-root';
    root.innerHTML = `
      <div id="or-inner">
        ${userHeaderHtml()}
        <div id="or-body">
          <div id="or-content">
            <div id="or-ufeed"><div class="or-empty">waiting for activity...</div></div>
          </div>
          <div id="or-side"></div>
        </div>
      </div>`;
    document.body.appendChild(root);
    document.getElementById('or-off').onclick = showOriginal;
    installUserExpandos();

    const observer = new MutationObserver(() => {
      if (captureUserItems()) drawUser();
    });
    const feedWatch = setInterval(() => {
      const feed = document.querySelector('shreddit-feed');
      if (!feed) return;
      clearInterval(feedWatch);
      observer.observe(feed, { childList: true, subtree: true });
      if (captureUserItems()) drawUser();
      renderUserSidebar();
    }, 200);

    setInterval(renderUserSidebar, 500);

    setTimeout(() => {
      if (!userDrawn) {
        console.warn('[old-reddit-restyle] no user items found - restoring page');
        showOriginal();
      }
    }, GIVE_UP_MS);
  }

  function boot() {
    buildShell();
    scanNow();
    observer.observe(document.body, { childList: true, subtree: true });
    if (store.size) firstDraw();

    retrySidebar();
    setInterval(() => { retryIncomplete(); retrySidebar(); }, 1000);

    /* Reddit only ships a handful of posts up front and loads the rest on
       scroll. Since our page is what the user sees, scroll the real one
       ourselves until a full page's worth has arrived. */
    pullMore(PER_PAGE).then(() => { scanNow(); topUp(); });

    /* If nothing ever shows up, give Reddit back rather than a blank page. */
    setTimeout(() => {
      if (!store.size) {
        console.warn('[old-reddit-restyle] no posts found - restoring original page');
        showOriginal();
      }
    }, GIVE_UP_MS);
  }

  const start = () =>
    USER ? bootUser() : COMMENTS_PAGE ? bootComments() : boot();

  if (document.body) {
    start();
  } else {
    new MutationObserver((_, obs) => {
      if (document.body) { obs.disconnect(); start(); }
    }).observe(document.documentElement, { childList: true });
  }
})();

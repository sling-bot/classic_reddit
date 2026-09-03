# Old Reddit Restyle

**Version 1.2 - beta.** Feeds, comment pages and user pages all render,
and all three are rebuilt from Reddit's data rather than restyled.
Everything on the main paths works; the remaining gaps are listed under
"What doesn't" and "Known quirks" below, and none of them fail silently.

Renders `www.reddit.com` feed pages in the old.reddit.com layout, without
logging in.

It reads what your browser already downloaded and redraws it. It makes no
API calls and sends nothing anywhere. The only network activity it causes is
media you explicitly ask to see.

## Install (Chrome)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** -> select this folder
4. Visit `www.reddit.com`

For private windows: **Details** -> **Allow in Incognito**.

**Turn off Old Reddit Redirect while testing**, or you'll be bounced to
old.reddit.com and this never runs.

After editing any file: reload the extension on `chrome://extensions`, then
refresh the Reddit tab.

## Install (Firefox)

`about:debugging` -> This Firefox -> Load Temporary Add-on -> pick
`manifest.json`. Firefox forgets temporary add-ons on restart.

## What works

- Front page, `/hot`, `/new`, `/top`, `/rising`, and subreddit pages
- Old-reddit link rows: rank, score, thumbnail, title, domain, tagline,
  comment count
- Pagination, 25 per page, with prev/next
- Header: logo, home/popular/all, sort tabs
- Expandos:
  - **image / gif** - direct from `content-href`
  - **gallery** - loads the full set on demand, with prev/next
  - **video** - HLS via bundled hls.js, with audio
  - **self posts** - full body text, sanitised
- Subreddit sidebar: submit link, search, about box, rules
- Fluid width; sidebar drops below the feed under 1100px
- **Comment pages** - the post rendered at the top with its media open,
  a sort bar (top / new / controversial / old / Q&A), and a nested
  comment tree with dotted guide lines, collapsible threads, and
  replies that expand inline rather than navigating away
- **User pages** - overview / comments / submitted, chronological,
  paginated 25 at a time, with thumbnails, expandos and a karma sidebar

## What doesn't

- Voting is decorative
- No in-place navigation (every link is a full page load, like old reddit)
- No user pages, search results, or wiki
- No `permalink / embed / save / report` links on comments - they don't
  exist in Reddit's DOM, only behind the overflow menu
- Comment scores read "20K", not "20.2k points" - Reddit's own text
- Galleries can't complete if the post was recycled out of Reddit's DOM

## Known quirks

- **Private windows bounce through a Reddit URL first.** A cold private
  window hits Reddit's bot check (`js_challenge=1`), and Reddit leaves
  its own "where were you going" parameter empty, so you land nowhere
  useful and have to retype the address. This is Reddit's, not ours -
  confirmed by reproducing it with the extension disabled. Working
  around it risks breaking the handshake that sets the cookie.
- **User page `load more`** drives Reddit's hidden feed by scrolling.
  If the item count stops climbing, that mechanism isn't firing.
- **Title-only text posts** exhaust their retry attempts looking for a
  body that was never there. Harmless, just wasted work.
- **Sort links are unverified.** Reddit exposes no sort control to
  logged-out visitors, so `?sort=` is an educated guess on both user
  and comment pages.
- **Reply expansion drives Reddit's own control.** "load more comments"
  clicks Reddit's hidden "more replies" button and waits for the replies
  to arrive. If that control isn't found, it falls back to the
  "open thread" link beside it rather than doing nothing.

## One approach

Everything is **rebuilt**: post and comment data is read from Reddit's
custom elements and re-rendered as old-reddit markup. Reddit's own page
stays in the document, hidden, because it keeps loading more content as
we scroll it - but none of its markup is displayed.

Earlier versions borrowed Reddit's `<shreddit-comment-tree>` and styled
it in place. That was abandoned when the requirements outgrew what CSS
can do: the comment score sits in a different branch of the DOM from the
username and cannot be moved next to it, and "N more replies" is text
content that cannot be rewritten. Both are trivial once the markup is
ours.

The same thing happened on user pages one version earlier - Reddit's
card padding wouldn't flatten, the tagline read "ADMIN replied to"
instead of a username and score, and an expando button inside Reddit's
clickable card kept getting hijacked into navigating.

The pattern worth remembering: **restyling works when Reddit's structure
already matches old reddit's, and stops working the moment you need to
move something across branches or change its text.**

## Where the data comes from

The feed is **rebuilt**: post data is read from `shreddit-post` attributes
and re-rendered as old-reddit link rows. Necessary because a card and a
link row share almost no structure, and because Reddit recycles posts out
of the DOM as you scroll, so the data has to be captured on sight.

Comment pages are **restyled in place**: the extension finds Reddit's
`<shreddit-comment-tree>` and moves it into our page, then styles it.
A comment and an old-reddit comment are the same object with different
paint, and Reddit's tree already handles nesting, collapse, lazy reply
loading and sort order. Re-implementing those was the first attempt and
it went badly.

Two consequences worth knowing. The comment CSS targets slot names
(`commentMeta`, `comment`, `actionRow`, `children`) rather than Reddit's
utility classes, since slots are load-bearing for Reddit's own code and
change less often. And "show original reddit" has to hand the tree back
to its original parent before removing our container, or it would delete
Reddit's content along with ours.

User pages are **rebuilt**, like the feed. Restyling was tried first and
abandoned: Reddit renders profiles as cards whose padding wouldn't
flatten, the tagline reads "ADMIN replied to" instead of a username and
score, and an expando button placed inside Reddit's clickable card kept
getting hijacked into navigating. Rebuilding solved all three at once.

Nearly everything is an HTML attribute, which is what makes rebuilding
practical:

- `shreddit-post` - `post-title`, `score`, `author`, `permalink`,
  `domain`, `comment-count`, `created-timestamp`, `post-type`
- `shreddit-comment` - `thingid`, `parentid`, `depth`, `author`,
  `score`, `created`, `permalink`

Only comment *bodies* are read from rendered DOM, at
`[id$="-comment-rtjson-content"]`. That's the fragile seam - if bodies
ever come up empty, that selector is the first thing to check.

All the volatile names live in the `REDDIT` and `COMMENT` objects near
the top of `content.js`, so a Reddit rename should be a one-line fix
rather than a hunt.

## Files

- `manifest.json` - which pages it runs on. Feed pages only.
- `hide.css` - hides Reddit before it paints. Uses `opacity`, not
  `display:none`, deliberately: the real page must stay laid out so the
  browser keeps loading posts into it. That feed is the data source.
- `oldreddit.css` - the old reddit look. Width knobs are CSS variables at
  the top, under `#or-root`.
- `content.js` - reads posts and renders them.
- `vendor/hls.min.js` - hls.js 1.6.16, Apache-2.0. Chrome and Firefox can't
  play HLS natively and Reddit serves v.redd.it only as HLS.
- `images/reddit-logo.png` - header logo.

## How it works

Reddit **virtualises** its feed: roughly 25 posts exist at a time and older
ones are deleted as you scroll. So a MutationObserver copies each post's data
the moment it appears, into a store that never forgets. Reddit can discard
posts; we've already got them.

Posts sometimes appear *before* their media is filled in, so anything
captured incomplete goes on a retry list and is re-read while its element is
still on the page.

Galleries only load the current slide plus three ahead, and only once the
post has been near the viewport. Opening one scrolls the hidden page to it
and walks the carousel forward, which makes Reddit fetch its own images -
the same trick as scrolling to load more posts.

## Debugging

`content.js` line ~15: `const DEBUG = true`. Set it to `false` to go quiet.

With it on, every message is prefixed `[ORR]` - put that in the console's
filter box, since Reddit floods the console.

## When Reddit breaks it

Open `content.js` and look at the `REDDIT` object near the top. Every
Reddit-specific attribute name and selector lives there. That's the only
part expected to rot.

To see what changed, run this on a Reddit feed with the extension off:

```js
const p = document.querySelector('shreddit-post');
console.log([...p.attributes].map(a => a.name).join('\n'));
```

Compare against `REDDIT.attr` and fix whatever was renamed.

Two things that have caught me out and will again:

- `querySelector` does not cross shadow boundaries. Reddit uses shadow DOM
  heavily. Use the `deepQuery` helper for anything inside a component.
- `preview.redd.it` URLs are signed per size. You can't rewrite `width=640`
  to something larger - pick a wider entry from `srcset` instead.

## Escape hatch

If no posts appear within 15 seconds it restores the normal page. There's
also a "show original reddit" link in the top bar.

## Not affiliated with Reddit

Uses Reddit's logo in the header for visual fidelity only.

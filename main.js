(function () {
  var root = document.documentElement;

  /* theme */
  var mq = window.matchMedia("(prefers-color-scheme: dark)");
  function isDark() {
    var t = root.getAttribute("data-theme");
    return t ? t === "dark" : mq.matches;
  }
  function syncTheme() { root.classList.toggle("is-dark", isDark()); }
  syncTheme();
  if (mq.addEventListener) mq.addEventListener("change", syncTheme);
  var themeBtn = document.querySelector(".theme-btn");
  if (themeBtn) themeBtn.addEventListener("click", function () {
    var next = isDark() ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch (e) {}
    syncTheme();
  });

  /* language: one language on screen, default Thai, ?lang= wins, then localStorage */
  var I18N = window.I18N || {};
  function setMeta(sel, value) {
    var m = document.querySelector(sel);
    if (m && value) m.setAttribute("content", value);
  }
  function applyLang(lang) {
    if (lang !== "th" && lang !== "en") lang = "th";
    root.setAttribute("lang", lang);
    var d = I18N[lang] || {};
    if (d.title) document.title = d.title;
    setMeta('meta[name="description"]', d.desc);
    setMeta('meta[property="og:title"]', d.title);
    setMeta('meta[property="og:description"]', d.og);
    setMeta('meta[property="og:locale"]', lang === "th" ? "th_TH" : "en_US");
    setMeta('meta[property="og:locale:alternate"]', lang === "th" ? "en_US" : "th_TH");
    ["aria-label", "alt"].forEach(function (name) {
      document.querySelectorAll("[data-" + lang + "-" + name + "]").forEach(function (el) {
        el.setAttribute(name, el.getAttribute("data-" + lang + "-" + name));
      });
    });
    document.querySelectorAll("[data-set-lang]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-set-lang") === lang ? "true" : "false");
    });
  }
  applyLang(root.getAttribute("lang"));
  document.querySelectorAll("[data-set-lang]").forEach(function (b) {
    b.addEventListener("click", function () {
      var lang = b.getAttribute("data-set-lang");
      applyLang(lang);
      try { localStorage.setItem("lang", lang); } catch (e) {}
      try {
        var u = new URL(location.href);
        if (u.searchParams.has("lang")) { u.searchParams.set("lang", lang); history.replaceState(null, "", u); }
      } catch (e) {}
      if (flight) flight.rebuild();
    });
  });

  /* Draw each ink stroke when its reveal container enters the viewport. */
  document.querySelectorAll(".line-doodle path").forEach(function (path) {
    path.style.setProperty("--length", path.getTotalLength());
  });
  root.classList.add("draw-ready");

  /* reveal on scroll */
  var items = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -8% 0px" });
    items.forEach(function (el) { io.observe(el); });
  } else {
    items.forEach(function (el) { el.classList.add("in"); });
  }

  /* paper plane: follows a curved path in the page margins as the page scrolls */
  var flight = (function () {
    var box = document.querySelector(".flight");
    if (!box) return null;
    var svg = box.querySelector("svg.trail");
    var path = box.querySelector(".trail-path");
    var win = box.querySelector(".trail-window");
    var plane = box.querySelector(".plane");
    var rot = box.querySelector(".plane-rot");
    var ASPECT = 228 / 329;     // sprite canvas, see assets/img/plane-*.webp
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

    var lut = null;            // samples from getPointAtLength: x, y, angle, turn rate
    var STEP = 4;              // px of path length between samples
    var size = 104, vh = 0, docH = 0, trailLen = 0, scrollNow = 0;
    // shown: the sample index the plane is drawn at. It only ever grows, so the plane never flies backwards.
    // goal: where the scroll position wants it. vel: smoothed speed in samples per frame.
    var shown = -1, goal = 0, vel = 0, raf = 0, settled = true;
    var face = 1, flip = 1, pose = "level";   // face: +1 nose right, -1 nose left; flip eases between them
    var heading = 0, headingSet = false;      // eased tangent angle in degrees
    var wind = box.querySelector(".wind");

    function contentEdges() {
      var w = document.querySelector("main .wrap");
      var W = document.documentElement.clientWidth;
      if (!w) return { W: W, x0: 0, x1: W };
      var r = w.getBoundingClientRect(), cs = getComputedStyle(w);
      return { W: W, x0: r.left + parseFloat(cs.paddingLeft), x1: r.right - parseFloat(cs.paddingRight) };
    }

    function sectionGaps(minGap, inset) {
      // vertical bands with no text: bottom padding of one section + top padding of the next
      var secs = Array.prototype.slice.call(document.querySelectorAll("main > section"));
      var gaps = [];
      for (var i = 0; i < secs.length - 1; i++) {
        var a = secs[i], b = secs[i + 1];
        var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        var pa = parseFloat(getComputedStyle(a).paddingBottom), pb = parseFloat(getComputedStyle(b).paddingTop);
        var top = ra.bottom + scrollY - pa, bottom = rb.top + scrollY + pb;
        if (bottom - top >= minGap) gaps.push({ a: top + inset, b: bottom - inset });
      }
      return gaps;
    }

    function smooth(t) { return t * t * (3 - 2 * t); }

    function build() {
      box.style.height = "0px";
      vh = window.innerHeight;
      docH = document.documentElement.scrollHeight;
      var e = contentEdges();
      var bandL = e.x0, bandR = e.W - e.x1;
      var band = Math.min(bandL, bandR);
      var weave = band >= 110;                       // wide screens: swap sides in the gaps between sections
      size = e.W <= 720 ? 56 : 104;
      var cL = bandL / 2, cR = e.W - bandR / 2;
      var amp = Math.max(0, ((weave ? band : bandR) - size * 1.25) / 2 - 6);
      var y0 = Math.min(vh * 0.55, 150), y1 = Math.max(y0 + 200, docH - vh * 0.45);
      // Keep the whole sprite clear of text, including its rotation and idle bob.
      var gaps = sectionGaps(size * 2 + 64, size + 16).filter(function (g) { return g.a > y0 + 120 && g.b < y1 - 120; });
      var dip = e.W * 0.42;  // narrow screens: swoop into the empty gap and back to the right edge
      // start on the right, in the margin beside the hero type
      // a shorter wave so the plane visibly banks left and right inside the margin
      function sideX(side, y) { return (side ? cR : cL) + amp * Math.sin(y / 150); }
      // wide screens: open with a glide across the empty right half of the type-led hero, landing in the right margin
      var hero = document.querySelector(".hero"), heroRight = 0, heroEnd = 0, xStart = 0;
      if (weave && hero) {
        hero.querySelectorAll(".wrap > *").forEach(function (el) {
          var rg = document.createRange(); rg.selectNodeContents(el);
          Array.prototype.forEach.call(rg.getClientRects(), function (r) { if (r.width > 0) heroRight = Math.max(heroRight, r.right); });
        });
        heroEnd = hero.getBoundingClientRect().bottom + scrollY - 40;
        xStart = Math.min(cR, Math.max(heroRight + size + 48, (heroRight + cR) / 2));
      }
      var pts = [], side = 1, gi = 0;
      for (var y = y0; y <= y1 + 0.1; y += 18) {
        var g = gaps[gi];
        while (g && y > g.b) { if (weave) side = 1 - side; gi++; g = gaps[gi]; }
        var x;
        if (g && y >= g.a) {
          var t = smooth((y - g.a) / (g.b - g.a));
          if (weave) x = sideX(side, g.a) * (1 - t) + sideX(1 - side, g.b) * t;
          else x = sideX(1, y) - (sideX(1, y) - dip) * Math.sin(Math.PI * t);
        } else if (xStart && y < heroEnd) {
          var th = smooth((y - y0) / (heroEnd - y0));
          x = xStart + (sideX(side, y) - xStart) * th;
        } else {
          x = sideX(side, y);
        }
        pts.push([x, y]);
      }
      // Catmull-Rom through the samples, written as cubic Beziers
      var d = "M" + pts[0][0].toFixed(1) + " " + pts[0][1].toFixed(1);
      for (var i = 0; i < pts.length - 1; i++) {
        var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
        d += " C" + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1) + " " + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(1) +
             " " + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1) + " " + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(1) +
             " " + p2[0].toFixed(1) + " " + p2[1].toFixed(1);
      }
      // Three small arc flourishes stay within the empty gap bands.
      // Their endpoints preserve monotonic y for the original binary search.
      var curls = 0;
      d = d.replace(/ C([^C]+)/g, function (segment, coordinates) {
        var values = coordinates.trim().split(/\s+/).map(Number);
        var endX = values[4], endY = values[5];
        var gap = gaps[curls];
        if (curls < 3 && gap && gap.b - gap.a >= 36 &&
            endY >= (gap.a + gap.b) / 2 && endY < (gap.a + gap.b) / 2 + 18) {
          curls++;
          // a sideways hook: both control points sit below the previous point, so y stays monotonic
          var hook = (curls % 2 ? 1 : -1) * Math.min(90, size * 0.9);
          return " C" + (endX + hook).toFixed(1) + " " + (endY - 16).toFixed(1) +
            " " + (endX + hook).toFixed(1) + " " + (endY - 1).toFixed(1) + " " + endX + " " + endY;
        }
        return segment;
      });
      svg.setAttribute("width", e.W);
      svg.setAttribute("height", docH);
      svg.setAttribute("viewBox", "0 0 " + e.W + " " + docH);
      path.setAttribute("d", d);
      var L = path.getTotalLength(), n = Math.ceil(L / STEP) + 1;
      lut = { n: n, L: L, x: new Float32Array(n), y: new Float32Array(n), a: new Float32Array(n), k: new Float32Array(n) };
      for (var k = 0; k < n; k++) {
        var p = path.getPointAtLength(Math.min(L, k * STEP));
        lut.x[k] = p.x; lut.y[k] = p.y;
      }
      for (k = 0; k < n; k++) {
        var k0 = Math.max(0, k - 2), k1 = Math.min(n - 1, k + 2);
        lut.a[k] = Math.atan2(lut.y[k1] - lut.y[k0], lut.x[k1] - lut.x[k0]);
      }
      for (k = 0; k < n; k++) {
        // turn rate in degrees per px of path, positive = turning clockwise on screen
        var j0 = Math.max(0, k - 3), j1 = Math.min(n - 1, k + 3);
        var dA = Math.atan2(Math.sin(lut.a[j1] - lut.a[j0]), Math.cos(lut.a[j1] - lut.a[j0]));
        lut.k[k] = j1 > j0 ? dA * 180 / Math.PI / ((j1 - j0) * STEP) : 0;
      }
      trailLen = Math.round(vh * 1.1);
      win.setAttribute("height", trailLen);
      box.style.height = docH + "px";
      plane.style.setProperty("--plane", size + "px");
    }

    function lenForY(y) {
      // path is monotonic in y, so binary search the samples
      var lo = 0, hi = lut.n - 1;
      if (y <= lut.y[0]) return 0;
      if (y >= lut.y[hi]) return hi;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (lut.y[mid] < y) lo = mid; else hi = mid; }
      var span = lut.y[hi] - lut.y[lo];
      return lo + (span > 0 ? (y - lut.y[lo]) / span : 0);
    }

    function poseFor(pitch, turn) {
      // pitch: degrees below the heading's horizon (+ = nose down); turn: + = nose dropping
      if (turn < -0.12 || pitch < -25) return "up";
      if (turn > 0.12 || pitch > 40) return "down";
      return "level";
    }

    function shortest(deg) { return ((deg + 540) % 360) - 180; }

    // Draw the plane at sample index f. speed is samples per frame (sets the wind streaks).
    // Returns true while the heading or the mirror flip is still easing, so the loop keeps running.
    function place(f, speed, instant) {
      var i = Math.max(0, Math.min(lut.n - 1, f)), k = Math.floor(i), t = i - k, k2 = Math.min(lut.n - 1, k + 1);
      var x = lut.x[k] + (lut.x[k2] - lut.x[k]) * t, y = lut.y[k] + (lut.y[k2] - lut.y[k]) * t;
      var a1 = lut.a[k], a2 = lut.a[k2], da = Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1));
      var a = a1 + da * t, ang = a * 180 / Math.PI;
      // face the way the path heads, with hysteresis so a near-vertical stretch does not flicker
      var c = Math.cos(a);
      if (c > 0.3) face = 1; else if (c < -0.3) face = -1;
      if (instant) flip = face;
      else if (flip !== face) flip = face > flip ? Math.min(face, flip + 0.16) : Math.max(face, flip - 0.16);
      // the tangent angle is eased along the shortest arc; the mirror flip handles the 180deg turn
      var dh = shortest(ang - heading);
      if (instant || !headingSet) { heading = ang; headingSet = true; dh = 0; }
      else { heading += dh * 0.18; }
      heading = shortest(heading);
      // a mirrored sprite has its nose at 180deg, so it turns 180deg less; at flip ~ 0 it is edge-on, a banked turn
      var r = flip >= 0 ? heading : heading - 180;
      var pitch = face > 0 ? ang : 180 - ang;
      pitch = shortest(pitch);
      var p = poseFor(pitch, face * (lut.k[k] + (lut.k[k2] - lut.k[k]) * t));
      if (p !== pose) { pose = p; plane.setAttribute("data-pose", p); }
      var h = size * ASPECT;
      var sx = Math.max(0.02, Math.abs(flip)) * (flip >= 0 ? 1 : -1);
      plane.style.transform = "translate3d(" + (x - size / 2).toFixed(1) + "px," + (y - h / 2).toFixed(1) + "px,0) rotate(" + r.toFixed(2) + "deg) scaleX(" + sx.toFixed(3) + ")";
      if (wind) {
        // streaks trail the tail and stretch with speed: gone at rest, full at about 14 px per frame
        var s = Math.max(0, Math.min(1, speed * STEP / 14));
        wind.style.opacity = (s * 0.85).toFixed(3);
        wind.style.transform = "scaleX(" + (0.3 + 0.7 * s).toFixed(3) + ")";
      }
      win.setAttribute("transform", "translate(0 " + (y - trailLen).toFixed(1) + ")");
      return Math.abs(dh) > 0.4 || flip !== face;
    }

    var lastTs = 0;
    function tick(ts) {
      raf = 0;
      // frame-rate independent: integrate one 60 Hz step per 16.7 ms elapsed (capped), so 120 Hz screens and throttled tabs glide alike
      var steps = lastTs ? Math.max(1, Math.min(8, Math.round((ts - lastTs) / 16.7))) : 1;
      lastTs = ts;
      for (var i = 0; i < steps; i++) {
        var diff = goal - shown;
        // critically damped glide: the velocity carries the plane to a soft stop, never past the goal and never backwards
        vel = vel * 0.5 + diff * 0.1;
        if (vel < 0) vel = 0;
        shown += vel;
        if (shown > goal) { shown = goal; vel = 0; }
      }
      var easing = place(shown, vel);
      if (goal - shown < 0.5 && vel < 0.1 && !easing) {
        shown = goal; vel = 0; place(shown, 0);
        lastTs = 0;
        if (!settled) { settled = true; plane.classList.add("idle"); }
        return;
      }
      raf = requestAnimationFrame(tick);
    }

    // Jump to the path point just above the viewport, so the plane re-enters from the top edge and glides forward.
    function reenter(g) {
      shown = Math.max(0, Math.min(g, lenForY(scrollNow - size)));
      vel = 0;
      place(shown, 0, true);
    }

    function onScroll() {
      if (!lut || reduce.matches) return;
      scrollNow = window.scrollY;
      var g = lenForY(scrollNow + vh * 0.55);
      var py = lut.y[Math.max(0, Math.min(lut.n - 1, Math.round(shown)))] - scrollNow;   // plane y inside the viewport
      if (g >= shown) {
        if (py < -vh * 0.6) reenter(g);            // the reader jumped far down: come in from the top edge
        goal = g;
      } else if (py > vh - size * 0.3) {
        reenter(g); goal = g;                      // scrolled up until the plane reached the bottom edge: it comes back in from the top, still flying forward
      } else {
        goal = shown;                              // scrolling up: hold position, nose forward, and bob
      }
      if (goal > shown + 0.05 && settled) { settled = false; plane.classList.remove("idle"); }
      if (!raf) raf = requestAnimationFrame(tick);
    }

    function rebuild() {
      build();
      if (reduce.matches) {
        // still plane near the hero, no trail, no animation
        cancelAnimationFrame(raf); raf = 0;
        shown = goal = lenForY(Math.min(vh * 0.4, 260));
        vel = 0;
        place(shown, 0, true);
        plane.classList.remove("idle");
      } else {
        scrollNow = window.scrollY;
        goal = lenForY(scrollNow + vh * 0.55);
        if (shown < 0) { shown = goal; vel = 0; place(shown, 0, true); }
        else { shown = Math.min(shown, lut.n - 1); if (goal < shown) goal = shown; place(shown, 0); }
        settled = true;
        plane.classList.add("idle");
        onScroll();
      }
      box.classList.add("ready");
    }

    var resizeTimer = 0;
    function scheduleRebuild() { clearTimeout(resizeTimer); resizeTimer = setTimeout(rebuild, 150); }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", scheduleRebuild);
    if (reduce.addEventListener) reduce.addEventListener("change", rebuild);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleRebuild);
    window.addEventListener("load", scheduleRebuild);
    if ("ResizeObserver" in window) {
      var lastH = 0;
      new ResizeObserver(function () {
        var h = document.querySelector("main").offsetHeight;
        if (Math.abs(h - lastH) > 2) { lastH = h; scheduleRebuild(); }
      }).observe(document.querySelector("main"));
    }
    rebuild();
    return { rebuild: rebuild };
  })();
})();

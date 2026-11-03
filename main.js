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
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

    var lut = null;            // samples from getPointAtLength: x, y, angle
    var STEP = 4;              // px of path length between samples
    var size = 56, vh = 0, docH = 0, trailLen = 0;
    var cur = -1, target = 0, raf = 0, idleTimer = 0;

    function contentEdges() {
      var w = document.querySelector("main .wrap");
      var W = document.documentElement.clientWidth;
      if (!w) return { W: W, x0: 0, x1: W };
      var r = w.getBoundingClientRect(), cs = getComputedStyle(w);
      return { W: W, x0: r.left + parseFloat(cs.paddingLeft), x1: r.right - parseFloat(cs.paddingRight) };
    }

    function sectionGaps(minGap) {
      // vertical bands with no text: bottom padding of one section + top padding of the next
      var secs = Array.prototype.slice.call(document.querySelectorAll("main > section"));
      var gaps = [];
      for (var i = 0; i < secs.length - 1; i++) {
        var a = secs[i], b = secs[i + 1];
        var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        var pa = parseFloat(getComputedStyle(a).paddingBottom), pb = parseFloat(getComputedStyle(b).paddingTop);
        var top = ra.bottom + scrollY - pa, bottom = rb.top + scrollY + pb;
        if (bottom - top >= minGap) gaps.push({ a: top + 24, b: bottom - 24 });
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
      size = Math.round(weave ? Math.max(40, Math.min(60, band * 0.5)) : Math.max(20, Math.min(40, bandR * 0.6)));
      var cL = bandL / 2, cR = e.W - bandR / 2;
      var amp = weave ? band * 0.2 : Math.max(0, (bandR - size) * 0.25);
      var y0 = Math.min(vh * 0.55, 150), y1 = Math.max(y0 + 200, docH - vh * 0.45);
      var gaps = sectionGaps(weave ? 200 : 150).filter(function (g) { return g.a > y0 + 120 && g.b < y1 - 120; });
      var dip = e.W * 0.42;  // narrow screens: swoop into the empty gap and back to the right edge
      // start on the right (over the hero image, away from the hero text)
      function sideX(side, y) { return (side ? cR : cL) + amp * Math.sin(y / 260); }
      var pts = [], side = 1, gi = 0;
      for (var y = y0; y <= y1 + 0.1; y += 18) {
        var g = gaps[gi];
        while (g && y > g.b) { if (weave) side = 1 - side; gi++; g = gaps[gi]; }
        var x;
        if (g && y >= g.a) {
          var t = smooth((y - g.a) / (g.b - g.a));
          if (weave) x = sideX(side, g.a) * (1 - t) + sideX(1 - side, g.b) * t;
          else x = sideX(1, y) - (sideX(1, y) - dip) * Math.sin(Math.PI * t);
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
      svg.setAttribute("width", e.W);
      svg.setAttribute("height", docH);
      svg.setAttribute("viewBox", "0 0 " + e.W + " " + docH);
      path.setAttribute("d", d);
      var L = path.getTotalLength(), n = Math.ceil(L / STEP) + 1;
      lut = { n: n, L: L, x: new Float32Array(n), y: new Float32Array(n), a: new Float32Array(n) };
      for (var k = 0; k < n; k++) {
        var p = path.getPointAtLength(Math.min(L, k * STEP));
        lut.x[k] = p.x; lut.y[k] = p.y;
      }
      for (k = 0; k < n; k++) {
        var k0 = Math.max(0, k - 2), k1 = Math.min(n - 1, k + 2);
        lut.a[k] = Math.atan2(lut.y[k1] - lut.y[k0], lut.x[k1] - lut.x[k0]);
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

    function place(f) {
      var i = Math.max(0, Math.min(lut.n - 1, f)), k = Math.floor(i), t = i - k, k2 = Math.min(lut.n - 1, k + 1);
      var x = lut.x[k] + (lut.x[k2] - lut.x[k]) * t, y = lut.y[k] + (lut.y[k2] - lut.y[k]) * t;
      var a1 = lut.a[k], a2 = lut.a[k2], da = Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1));
      var ang = (a1 + da * t) * 180 / Math.PI;
      plane.style.transform = "translate3d(" + (x - size / 2).toFixed(1) + "px," + (y - size * 0.375).toFixed(1) + "px,0) rotate(" + ang.toFixed(1) + "deg)";
      win.setAttribute("transform", "translate(0 " + (y - trailLen).toFixed(1) + ")");
    }

    function targetFor() { return lenForY(window.scrollY + vh * 0.55); }

    function tick() {
      raf = 0;
      var diff = target - cur;
      if (Math.abs(diff) < 0.05) { cur = target; place(cur); return; }
      cur += diff * 0.14;
      place(cur);
      raf = requestAnimationFrame(tick);
    }

    function onScroll() {
      if (!lut || reduce.matches) return;
      target = targetFor();
      plane.classList.remove("idle");
      clearTimeout(idleTimer);
      idleTimer = setTimeout(function () { plane.classList.add("idle"); }, 220);
      if (!raf) raf = requestAnimationFrame(tick);
    }

    function rebuild() {
      build();
      if (reduce.matches) {
        // still plane near the hero, no trail, no animation
        cancelAnimationFrame(raf); raf = 0;
        cur = target = lenForY(Math.min(vh * 0.4, 260));
        place(cur);
        plane.classList.remove("idle");
      } else {
        target = targetFor();
        if (cur < 0) cur = target; else cur = Math.min(cur, lut.n - 1);
        place(cur);
        plane.classList.add("idle");
        if (!raf) raf = requestAnimationFrame(tick);
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

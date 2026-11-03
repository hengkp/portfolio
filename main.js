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
    var size = 104, vh = 0, docH = 0, trailLen = 0;
    // shown: the sample index the plane is drawn at. It follows goal (from the scroll position) in both directions
    // through a damped spring, so the flight is one continuous glide. dir: which way it is travelling along the path.
    var shown = -1, goal = 0, vel = 0, dir = 1, raf = 0, settled = true, lastTs = 0;
    var face = 1, flip = 1, pose = "level";   // face: +1 nose right, -1 nose left; flip eases between them (a banked turn)
    var heading = 0, headingSet = false;      // eased nose angle in degrees

    function build() {
      box.style.height = "0px";
      vh = window.innerHeight;
      docH = document.documentElement.scrollHeight;
      var W = document.documentElement.clientWidth;
      size = W <= 720 ? 56 : 104;
      // one long, gentle S-curve down the page: it swings almost edge to edge with large-radius turns,
      // starting in the right margin beside the hero, and is allowed to pass over the text column
      var cx = W / 2, A = W / 2 - size * 0.95;
      var lambda = W <= 720 ? Math.max(1500, vh * 1.9) : Math.max(3000, vh * 3.2);   // px of page per full S
      var y0 = Math.min(vh * 0.55, 150), y1 = Math.max(y0 + 200, docH - vh * 0.45);
      var pts = [];
      for (var y = y0; y <= y1 + 0.1; y += 18) pts.push([cx + A * Math.cos(2 * Math.PI * (y - y0) / lambda), y]);
      // Catmull-Rom through the samples, written as cubic Beziers
      var d = "M" + pts[0][0].toFixed(1) + " " + pts[0][1].toFixed(1);
      for (var i = 0; i < pts.length - 1; i++) {
        var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
        d += " C" + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1) + " " + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(1) +
             " " + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1) + " " + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(1) +
             " " + p2[0].toFixed(1) + " " + p2[1].toFixed(1);
      }
      svg.setAttribute("width", W);
      svg.setAttribute("height", docH);
      svg.setAttribute("viewBox", "0 0 " + W + " " + docH);
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

    // Draw the plane at sample index f, nose along the direction of travel.
    // Returns true while the heading or the mirror flip is still easing, so the loop keeps running.
    function place(f, instant) {
      var i = Math.max(0, Math.min(lut.n - 1, f)), k = Math.floor(i), t = i - k, k2 = Math.min(lut.n - 1, k + 1);
      var x = lut.x[k] + (lut.x[k2] - lut.x[k]) * t, y = lut.y[k] + (lut.y[k2] - lut.y[k]) * t;
      var a1 = lut.a[k], a2 = lut.a[k2], da = Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1));
      var ang = (a1 + da * t) * 180 / Math.PI;
      var nose = shortest(dir > 0 ? ang : ang + 180);
      // the nose swings round along the shortest arc; a reversal is a 180deg turn that takes about 400 ms
      var dh = shortest(nose - heading);
      if (instant || !headingSet) { heading = nose; headingSet = true; dh = 0; }
      else heading += dh * 0.14;
      heading = shortest(heading);
      // keep the sprite the right way up: mirror it when the nose points left, with hysteresis near vertical
      var c = Math.cos(heading * Math.PI / 180);
      if (c > 0.3) face = 1; else if (c < -0.3) face = -1;
      if (instant) flip = face;
      else if (flip !== face) flip = face > flip ? Math.min(face, flip + 0.08) : Math.max(face, flip - 0.08);
      // a mirrored sprite has its nose at 180deg; at flip ~ 0 it is edge-on, which reads as a banked turn.
      // While the nose is still swinging round, squeeze the wings as well so the turnaround banks instead of spinning flat.
      var r = flip >= 0 ? heading : heading - 180;
      var bank = 1 - 0.6 * Math.min(1, Math.abs(dh) / 120);
      var sx = Math.max(0.02, Math.abs(flip) * bank) * (flip >= 0 ? 1 : -1);
      var pitch = shortest(face > 0 ? heading : 180 - heading);
      var p = poseFor(pitch, dir * face * (lut.k[k] + (lut.k[k2] - lut.k[k]) * t));
      if (p !== pose) { pose = p; plane.setAttribute("data-pose", p); }
      var h = size * ASPECT;
      plane.style.transform = "translate3d(" + (x - size / 2).toFixed(1) + "px," + (y - h / 2).toFixed(1) + "px,0) rotate(" + r.toFixed(2) + "deg) scaleX(" + sx.toFixed(3) + ")";
      win.setAttribute("transform", "translate(0 " + (y - trailLen).toFixed(1) + ")");
      return Math.abs(dh) > 0.4 || flip !== face;
    }

    function tick(ts) {
      raf = 0;
      // frame-rate independent: integrate one 60 Hz step per 16.7 ms elapsed (capped), so 120 Hz screens and throttled tabs glide alike
      var steps = lastTs ? Math.max(1, Math.min(8, Math.round((ts - lastTs) / 16.7))) : 1;
      lastTs = ts;
      for (var i = 0; i < steps; i++) {
        // critically damped spring: it glides to a soft stop with no overshoot, in either direction
        vel = vel * 0.5 + (goal - shown) * 0.1;
        shown += vel;
        if (shown < 0) { shown = 0; vel = 0; }
        if (shown > lut.n - 1) { shown = lut.n - 1; vel = 0; }
      }
      // direction of travel with hysteresis, so trackpad jitter does not flip the plane
      if (vel > 0.2) dir = 1; else if (vel < -0.2) dir = -1;
      var easing = place(shown);
      if (Math.abs(goal - shown) < 0.5 && Math.abs(vel) < 0.1 && !easing) {
        shown = goal; vel = 0; place(shown);
        lastTs = 0;
        if (!settled) { settled = true; plane.classList.add("idle"); }
        return;
      }
      raf = requestAnimationFrame(tick);
    }

    function onScroll() {
      if (!lut || reduce.matches) return;
      goal = lenForY(window.scrollY + vh * 0.55);
      if (Math.abs(goal - shown) > 0.05 && settled) { settled = false; plane.classList.remove("idle"); }
      if (!raf) raf = requestAnimationFrame(tick);
    }

    function rebuild() {
      build();
      if (reduce.matches) {
        // still plane near the hero, no trail, no animation
        cancelAnimationFrame(raf); raf = 0;
        shown = goal = lenForY(Math.min(vh * 0.4, 260));
        vel = 0; dir = 1;
        place(shown, true);
        plane.classList.remove("idle");
      } else {
        goal = lenForY(window.scrollY + vh * 0.55);
        if (shown < 0) { shown = goal; vel = 0; place(shown, true); }
        else { shown = Math.max(0, Math.min(shown, lut.n - 1)); place(shown); }
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

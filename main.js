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
    var shown = -1, goal = 0, vel = 0, dir = 1, raf = 0, settled = true, lastTs = 0, oppSince = 0;
    var face = 1, wantFace = 1, pose = "level";    // face: +1 nose right (plain sprite), -1 nose left (mirrored sprite)
    var flipActive = false, flipStart = 0, flipFrom = 1, flipTo = 1, sxNow = 1;   // the one banked turn: scaleX 1 -> -1 through 0
    var heading = 0, headingSet = false;           // eased in-plane rotation in degrees
    var rolls = [], tilts = [], acro = null;       // acrobatics on the inner element: barrel roll, crossing tilt
    var flight = { rolls: [], tilts: [] };
    var FLIP_MS = 350, HYST_MS = 120, ROLL_MS = 500, TILT_MS = 600;

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
      // acrobatics: a barrel roll at the middle of the three longest straight gutter stretches, a small tilt at every crossing
      var bounds = [y0].concat(gaps.map(function (g) { return [g.a, g.b]; }).reduce(function (a, b) { return a.concat(b); }, []), [y1]);
      var straights = [];
      for (var s = 0; s < bounds.length; s += 2) if (bounds[s + 1] - bounds[s] >= vh * 1.2) straights.push({ a: bounds[s], b: bounds[s + 1], len: bounds[s + 1] - bounds[s] });
      straights.sort(function (p, q) { return q.len - p.len; });
      rolls = straights.slice(0, 3).map(function (st) { var y = (st.a + st.b) / 2; return { y: Math.round(y), i: lenForY(y), armed: true }; }).sort(function (p, q) { return p.i - q.i; });
      tilts = gaps.map(function (g) { var y = (g.a + g.b) / 2; return { y: Math.round(y), i: lenForY(y), armed: true }; });
      flight.rolls = rolls.map(function (r) { return r.y; }); flight.tilts = tilts.map(function (r) { return r.y; });
      box.setAttribute("data-rolls", flight.rolls.join(",")); box.setAttribute("data-tilts", flight.tilts.join(","));
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
    function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

    // Draw the plane at sample index f. The nose follows the direction of travel. The sprite is rotated by `heading`
    // and mirrored by `sxNow`; a reversal or a left/right change is ONLY a mirror flip, never an in-plane spin.
    function place(f, ts, instant) {
      var i = Math.max(0, Math.min(lut.n - 1, f)), k = Math.floor(i), t = i - k, k2 = Math.min(lut.n - 1, k + 1);
      var x = lut.x[k] + (lut.x[k2] - lut.x[k]) * t, y = lut.y[k] + (lut.y[k2] - lut.y[k]) * t;
      var a1 = lut.a[k], a2 = lut.a[k2], da = Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1));
      var ang = (a1 + da * t) * 180 / Math.PI;
      var nose = shortest(dir > 0 ? ang : ang + 180);
      var busy = flipActive || !!acro;
      if (!busy) {
        // keep the sprite the right way up: mirror it when the nose points left, with hysteresis near vertical
        var c = Math.cos(nose * Math.PI / 180);
        if (c > 0.3) wantFace = 1; else if (c < -0.3) wantFace = -1;
        if (instant) { face = wantFace; sxNow = face; }
        else if (wantFace !== face) { flipActive = true; flipStart = ts; flipFrom = face; flipTo = wantFace; face = wantFace; }
      }
      if (flipActive) {
        var ft = Math.min(1, (ts - flipStart) / FLIP_MS);
        sxNow = flipFrom + (flipTo - flipFrom) * easeInOut(ft);
        if (ft >= 1) { flipActive = false; sxNow = face; }
      }
      // in-plane rotation target: with a mirrored sprite the nose sits at 180deg, so the target is unchanged by a reversal
      var target = face > 0 ? nose : nose - 180;
      var dh = shortest(target - heading);
      if (instant || !headingSet) { heading = target; headingSet = true; dh = 0; }
      else heading += dh * 0.14;
      heading = shortest(heading);
      var pitch = shortest(face > 0 ? nose : 180 - nose);
      var p = poseFor(pitch, dir * face * (lut.k[k] + (lut.k[k2] - lut.k[k]) * t));
      if (p !== pose) { pose = p; plane.setAttribute("data-pose", p); }
      var h = size * ASPECT;
      var sx = Math.abs(sxNow) < 0.02 ? 0.02 * (sxNow < 0 ? -1 : 1) : sxNow;
      plane.style.transform = "translate3d(" + (x - size / 2).toFixed(1) + "px," + (y - h / 2).toFixed(1) + "px,0) rotate(" + heading.toFixed(2) + "deg) scaleX(" + sx.toFixed(3) + ")";
      // acrobatics on the inner element, so the heading stays on the path
      if (acro) {
        var at = Math.min(1, (ts - acro.start) / acro.dur);
        var deg = acro.kind === "roll" ? 360 * easeInOut(at) : 18 * Math.sin(Math.PI * at);
        rot.style.transform = "rotateX(" + deg.toFixed(1) + "deg)";
        if (at >= 1) { acro = null; rot.style.transform = ""; }
      }
      win.setAttribute("transform", "translate(0 " + (y - trailLen).toFixed(1) + ")");
      return Math.abs(dh) > 0.4 || flipActive || !!acro;
    }

    function tick(ts) {
      raf = 0;
      // frame-rate independent: integrate one 60 Hz step per 16.7 ms elapsed (capped), so 120 Hz screens and throttled tabs glide alike
      var steps = lastTs ? Math.max(1, Math.min(8, Math.round((ts - lastTs) / 16.7))) : 1;
      lastTs = ts;
      var prev = shown;
      for (var i = 0; i < steps; i++) {
        // critically damped spring: it glides to a soft stop with no overshoot, in either direction
        vel = vel * 0.5 + (goal - shown) * 0.1;
        shown += vel;
        if (shown < 0) { shown = 0; vel = 0; }
        if (shown > lut.n - 1) { shown = lut.n - 1; vel = 0; }
      }
      // ONE direction state. It changes only after the smoothed velocity has pointed the other way, above a small
      // threshold, for HYST_MS, and never while a turn or a roll is in progress (a second reversal waits its turn).
      if (!flipActive && !acro) {
        if (Math.abs(vel) > 0.2 && (vel > 0) !== (dir > 0)) {
          if (!oppSince) oppSince = ts;
          else if (ts - oppSince >= HYST_MS) { dir = -dir; oppSince = 0; wantFace = -face; }
        } else oppSince = 0;
      }
      // acrobatics: a barrel roll on a straight stretch when passing forward at speed; a small tilt at each crossing
      if (!reduce.matches && !flipActive && !acro) {
        for (var r = 0; r < rolls.length; r++) {
          if (rolls[r].armed && prev < rolls[r].i && shown >= rolls[r].i && dir > 0 && vel > 1.2) { acro = { kind: "roll", start: ts, dur: ROLL_MS }; rolls[r].armed = false; }
          else if (!rolls[r].armed && shown < rolls[r].i - 150) rolls[r].armed = true;
        }
        for (var q = 0; q < tilts.length && !acro; q++) {
          if (tilts[q].armed && ((prev < tilts[q].i && shown >= tilts[q].i) || (prev > tilts[q].i && shown <= tilts[q].i))) { acro = { kind: "tilt", start: ts, dur: TILT_MS }; tilts[q].armed = false; }
          else if (!tilts[q].armed && Math.abs(shown - tilts[q].i) > 60) tilts[q].armed = true;
        }
      }
      var easing = place(shown, ts);
      if (Math.abs(goal - shown) < 0.5 && Math.abs(vel) < 0.1 && !easing) {
        shown = goal; vel = 0; place(shown, ts);
        lastTs = 0; oppSince = 0;
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
      acro = null; rot.style.transform = ""; flipActive = false; oppSince = 0;
      if (reduce.matches) {
        // still plane near the hero, no trail, no animation
        cancelAnimationFrame(raf); raf = 0;
        shown = goal = lenForY(Math.min(vh * 0.4, 260));
        vel = 0; dir = 1;
        place(shown, 0, true);
        plane.classList.remove("idle");
      } else {
        goal = lenForY(window.scrollY + vh * 0.55);
        if (shown < 0) { shown = goal; vel = 0; place(shown, 0, true); }
        else { shown = Math.max(0, Math.min(shown, lut.n - 1)); place(shown, 0); }
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
    flight.rebuild = rebuild;
    return flight;
  })();
})();

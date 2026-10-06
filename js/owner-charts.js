// Small SVG charts for the owner dashboard. Colour-blind friendly: a high-contrast palette (Okabe-Ito)
// AND a second cue on everything (bar patterns, dashed vs solid lines, different marker shapes,
// numbers printed on the chart), so nothing depends on colour alone.
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  var INK = "#2B2340", GRID = "#d9d3df";
  var PALETTE = { blue: "#0072B2", vermillion: "#D55E00", orange: "#E69F00", green: "#009E73" };

  function svgEl(name, attrs, kids) {
    var n = document.createElementNS(NS, name);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function text(x, y, str, attrs) {
    var n = svgEl("text", Object.assign({ x: x, y: y, fill: INK, "font-size": "12", "font-family": "Quicksand, Arial, sans-serif" }, attrs || {}));
    n.textContent = str; return n;
  }
  function shortDate(iso) { var p = iso.split("-"); return Number(p[2]) + "/" + Number(p[1]); }

  var W = 640, H = 280, M = { l: 40, r: 16, t: 34, b: 38 };

  function frame(max, labels, label, desc) {
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": label + ". " + desc, class: "chart", style: "direction:ltr" });
    svg.appendChild(svgEl("title", {}, [])).textContent = label;
    var pw = W - M.l - M.r, ph = H - M.t - M.b;
    var steps = 4;
    for (var i = 0; i <= steps; i++) {
      var y = M.t + ph - (ph * i) / steps, v = Math.round((max * i) / steps * 10) / 10;
      svg.appendChild(svgEl("line", { x1: M.l, x2: W - M.r, y1: y, y2: y, stroke: GRID, "stroke-width": i === 0 ? "2" : "1" }));
      svg.appendChild(text(M.l - 6, y + 4, String(v), { "text-anchor": "end", "font-size": "11" }));
    }
    var slot = pw / labels.length;
    labels.forEach(function (lb, i) { svg.appendChild(text(M.l + slot * i + slot / 2, H - 14, shortDate(lb), { "text-anchor": "middle", "font-size": "11" })); });
    return { svg: svg, pw: pw, ph: ph, slot: slot, y: function (v) { return M.t + ph - (ph * v) / max; } };
  }

  // Bars with a diagonal-stripe pattern, a dark outline and the number above each bar.
  function barChart(o) {
    var max = o.max, f = frame(max, o.labels, o.label, o.desc), id = "stripes" + Math.random().toString(36).slice(2, 7);
    var defs = svgEl("defs", {}, [svgEl("pattern", { id: id, width: "8", height: "8", patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, [
      svgEl("rect", { width: "8", height: "8", fill: "#ffffff" }), svgEl("rect", { width: "4", height: "8", fill: o.color || PALETTE.vermillion })])]);
    f.svg.insertBefore(defs, f.svg.firstChild.nextSibling);
    var bw = Math.min(46, f.slot * 0.6);
    o.values.forEach(function (v, i) {
      var x = M.l + f.slot * i + (f.slot - bw) / 2, y = f.y(v), h = Math.max(0, f.y(0) - y);
      f.svg.appendChild(svgEl("rect", { x: x, y: y, width: bw, height: h, fill: "url(#" + id + ")", stroke: INK, "stroke-width": "2" }));
      f.svg.appendChild(text(x + bw / 2, (h ? y : f.y(0)) - 6, String(v), { "text-anchor": "middle", "font-weight": "700" }));
    });
    return f.svg;
  }

  function marker(shape, x, y, color) {
    var common = { fill: color, stroke: "#ffffff", "stroke-width": "1.5" };
    if (shape === "square") return svgEl("rect", Object.assign({ x: x - 5, y: y - 5, width: 10, height: 10 }, common));
    if (shape === "triangle") return svgEl("polygon", Object.assign({ points: [x, y - 7, x - 7, y + 5, x + 7, y + 5].join(",") }, common));
    return svgEl("circle", Object.assign({ cx: x, cy: y, r: 5.5 }, common));
  }

  // Lines: each series has its own colour, dash pattern and marker shape; values are printed at the points.
  // o.series = [{ name, values, color, dash, shape }]
  function lineChart(o) {
    var f = frame(o.max, o.labels, o.label, o.desc);
    o.series.forEach(function (s, si) {
      var pts = s.values.map(function (v, i) { return [M.l + f.slot * i + f.slot / 2, f.y(v)]; });
      f.svg.appendChild(svgEl("polyline", { points: pts.map(function (p) { return p.join(","); }).join(" "), fill: "none", stroke: s.color, "stroke-width": "3", "stroke-dasharray": s.dash || "", "stroke-linejoin": "round" }));
      pts.forEach(function (p, i) {
        f.svg.appendChild(marker(s.shape, p[0], p[1], s.color));
        f.svg.appendChild(text(p[0], p[1] + (si === 0 ? -11 : 20), String(s.values[i]), { "text-anchor": "middle", "font-size": "11", "font-weight": "700" }));
      });
    });
    // legend: swatch with the same line style and marker as the series
    o.series.forEach(function (s, si) {
      var x = M.l + si * 190;
      f.svg.appendChild(svgEl("line", { x1: x, x2: x + 28, y1: 14, y2: 14, stroke: s.color, "stroke-width": "3", "stroke-dasharray": s.dash || "" }));
      f.svg.appendChild(marker(s.shape, x + 14, 14, s.color));
      f.svg.appendChild(text(x + 34, 18, s.name, { "font-weight": "700" }));
    });
    return f.svg;
  }

  window.CKACharts = { barChart: barChart, lineChart: lineChart, PALETTE: PALETTE };
})();

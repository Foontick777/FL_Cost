// Измерение вида тёмной темы прямо в браузере.
//
// Зачем: тёмную тему нельзя оценить «на глаз» в этом окружении (распознавание
// изображений недоступно), а ошибки в ней бывают двух видов, и оба невидимы в
// коде — только в отрендеренной странице:
//
//   1. СВЕТЛЫЙ ФОН — элемент, который в тёмной теме остался белым (например поле
//      ввода без явного фона: оно выглядело тёмным лишь из-за color-scheme).
//   2. ТЁМНЫЙ ТЕКСТ на тёмном фоне — элемент, у которого цвет текста не задан
//      вовсе и берётся браузерный (чёрный). В светлой теме это незаметно, в
//      тёмной такой текст сливается с фоном и «исчезает».
//
// Отчёт кладётся в DOM (<pre id="fc-audit">), поэтому читается через
// `chrome --headless --dump-dom` без картинок.
window.addEventListener("load", function () {

  function parse(c) {
    var m = /rgba?\((\d+), ?(\d+), ?(\d+)(?:, ?([\d.]+))?/.exec(c || "");
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  }
  function lum(c) {
    var v = [c.r, c.g, c.b].map(function (x) {
      x /= 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }
  function ratio(a, b) {
    var x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function describe(el) {
    var t = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 34);
    return "<" + el.tagName.toLowerCase() + ">" + (t ? ' "' + t + '"' : "");
  }

  /** Первый непрозрачный фон вверх по дереву — то, на чём реально виден текст. */
  function effectiveBg(el) {
    var node = el;
    while (node && node.nodeType === 1) {
      var c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.5) return c;
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  // Проверяем всю страницу: она целиком в ОДНОЙ теме, и переменные стоят на
  // :root — так же, как в приложении. Раньше темы рисовались колонками, и
  // переменные оказывались на колонке: базовое правило html,body не находило
  // их и измерение показывало несуществующий дефект.
  var theme = document.documentElement.getAttribute("data-theme") || "light";
  var dark = document.body;
  var report = { lightBackgrounds: [], darkText: [], fields: [], checkedTexts: 0 };

  // 1. Светлые фоны.
  dark.querySelectorAll("*").forEach(function (el) {
    var bg = parse(getComputedStyle(el).backgroundColor);
    if (bg && bg.a > 0.5 && bg.r > 200 && bg.g > 200 && bg.b > 200) {
      report.lightBackgrounds.push(describe(el) + " фон=" + getComputedStyle(el).backgroundColor);
    }
  });

  // 2. Невидимый текст: считаем контраст у элементов, у которых есть собственный текст.
  dark.querySelectorAll("*").forEach(function (el) {
    var own = "";
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) own += el.childNodes[i].nodeValue;
    }
    if (!own.trim()) return;
    var st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none") return;
    var fg = parse(st.color);
    if (!fg) return;
    var bg = effectiveBg(el);
    // Полупрозрачный текст смешиваем с фоном, иначе контраст завышается.
    if (fg.a < 1) {
      fg = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a),
             b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
    }
    report.checkedTexts++;
    var size = parseFloat(st.fontSize) || 14;
    var bold = (parseInt(st.fontWeight, 10) || 400) >= 700;
    // Порог WCAG: 3.0 для крупного текста (>=18.66px жирный или >=24px), иначе 4.5.
    var min = (size >= 24 || (bold && size >= 18.66)) ? 3 : 4.5;
    var r = ratio(fg, bg);
    if (r < min) {
      report.darkText.push(describe(el) + " контраст=" + r.toFixed(2) + " (норма " + min +
        "), цвет=" + st.color + " на фоне=rgb(" + bg.r + ", " + bg.g + ", " + bg.b + ")");
    }
  });

  // 3. Поля ввода: фон и цвет обязаны быть из темы, а не браузерные.
  dark.querySelectorAll("input,select,textarea").forEach(function (el) {
    report.fields.push("поле <" + el.tagName.toLowerCase() + "> фон=" +
      getComputedStyle(el).backgroundColor + " цвет=" + getComputedStyle(el).color);
  });

  var lines = [];
  lines.push("проверено текстовых элементов: " + report.checkedTexts);
  lines.push("");
  lines.push("1) светлых фонов: " + report.lightBackgrounds.length);
  report.lightBackgrounds.slice(0, 20).forEach(function (x) { lines.push("   " + x); });
  lines.push("2) нечитаемый текст: " + report.darkText.length);
  report.darkText.slice(0, 30).forEach(function (x) { lines.push("   " + x); });
  lines.push("3) поля ввода:");
  report.fields.slice(0, 10).forEach(function (x) { lines.push("   " + x); });

  var out = document.createElement("pre");
  out.id = "fc-audit";
  out.textContent = "АУДИТ ТЕМЫ (" + theme + ")\n" + lines.join("\n");
  document.body.appendChild(out);
});

// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Replaces the language drop-down on the sign-in pages with one button: it shows the current
// language (flag and code) and a single click switches to the other one. The original
// <select> stays in the page (hidden) as the source of the links, so without this script
// the standard drop-down still works.
(function () {
  "use strict";
  function init() {
    var select = document.querySelector(".pf-v5-c-login__main-header-utilities select");
    if (!select || select.options.length < 2) return;
    var current = select.options[select.selectedIndex];
    var other = null;
    for (var i = 0; i < select.options.length; i++) {
      if (select.options[i] !== current) { other = select.options[i]; break; }
    }
    if (!other || !other.value) return;
    var code = function (option) {
      var match = /[?&]kc_locale=([A-Za-z-]+)/.exec(option.value);
      return match ? match[1].toLowerCase() : "";
    };
    var button = document.createElement("button");
    button.type = "button";
    button.className = "jh-lang";
    button.setAttribute("data-lang", code(current));
    button.setAttribute("aria-label", other.textContent.trim() + " (" + code(other).toUpperCase() + ")");
    button.title = button.getAttribute("aria-label");
    var label = document.createElement("span");
    label.textContent = current.textContent.trim();
    button.appendChild(label);
    button.addEventListener("click", function () { window.location.href = other.value; });
    select.style.display = "none";
    select.parentNode.insertBefore(button, select);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

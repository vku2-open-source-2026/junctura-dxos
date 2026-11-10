// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
(function () {
  var size = "md";
  try {
    var stored = localStorage.getItem("junctura_text_size");
    if (stored === "sm" || stored === "md" || stored === "lg") size = stored;
  } catch (error) {
    size = "md";
  }
  document.documentElement.setAttribute("data-text-size", size);
})();

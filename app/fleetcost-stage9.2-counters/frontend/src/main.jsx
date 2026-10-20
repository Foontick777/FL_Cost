// Шрифты отдаём со своего домена (было — fonts.googleapis.com). Это убирает
// внешнюю зависимость: IP каждого сотрудника больше не уходит в Google, а
// страница не ждёт ответа чужого CDN. Variable-версии покрывают все веса
// (100–900) одним файлом на подмножество; браузер скачивает только нужные
// подмножества (cyrillic + latin) благодаря unicode-range.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);

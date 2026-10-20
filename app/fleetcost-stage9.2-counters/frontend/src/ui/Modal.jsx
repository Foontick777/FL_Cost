import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * Modal — единственный способ показать диалог в приложении.
 *
 * ЗАЧЕМ ОБЩИЙ КОМПОНЕНТ
 * ---------------------
 * До него девять диалогов были написаны копипастой: одинаковая разметка фона и
 * панели, у каждого свой обработчик Escape (или его отсутствие), `role="dialog"`
 * проставлен, а вот доступность не доведена — не было ни фокус-ловушки, ни
 * возврата фокуса, ни блокировки прокрутки фона. Таб из открытого диалога уводил
 * фокус на страницу под ним, а после закрытия фокус терялся в начале документа:
 * для клавиатуры и скринридера диалог был ловушкой без выхода.
 *
 * ЧТО ДЕЛАЕТ
 * ----------
 *  • `role="dialog"` + `aria-modal="true"` + имя (`labelledBy` или `label`);
 *  • Escape закрывает (обработчик на фазе перехвата, поэтому работает и когда
 *    фокус внутри поля ввода, и когда внутри вложенного элемента);
 *  • фокус-ловушка: Tab и Shift+Tab ходят по кругу внутри панели;
 *  • начальный фокус — на первом доступном элементе (иначе на самой панели);
 *  • при закрытии фокус возвращается туда, откуда диалог открыли;
 *  • прокрутка страницы под диалогом заблокирована (со счётчиком: если открыть
 *    второй диалог поверх первого, фон не «разблокируется» преждевременно);
 *  • клик по фону закрывает (можно отключить: `closeOnBackdrop={false}`).
 *
 * ВИДЫ
 * ----
 * `align="top"` (по умолчанию) — высокая форма: панель прижата к верху с отступом,
 *   длинное содержимое прокручивается, не «уезжая» за экран.
 * `align="center"` — короткое подтверждение по центру.
 * `variant="drawer"` — выдвижная панель справа (журнал действий).
 *
 * Пример:
 *   {showAddForm && (
 *     <Modal onClose={()=>setShowAddForm(false)} labelledBy="fc-income-add-title" maxWidth={560}>
 *       <h3 id="fc-income-add-title">…</h3>
 *       …
 *     </Modal>
 *   )}
 */

/** Элементы, которые могут получать фокус внутри панели. */
const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled])",
  "select:not([disabled])", "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Куда перейдёт фокус по Tab внутри ловушки.
 * Вынесено отдельной чистой функцией — её проверяет `npm run check:logic`:
 * логику обхода клавиатурой нельзя проверить ни сборкой, ни рендером.
 * Возвращает индекс в `count` элементов или -1, если элементов нет.
 */
export function focusCycleIndex(count, currentIndex, shiftKey) {
  if (!count || count <= 0) return -1;
  if (currentIndex < 0) return shiftKey ? count - 1 : 0;
  const next = shiftKey ? currentIndex - 1 : currentIndex + 1;
  return (next + count) % count;      // по кругу: после последнего — первый
}

/**
 * Стек открытых диалогов (порядок открытия).
 * Нужен для двух вещей: (1) прокрутку фона разблокируем только когда закрылся
 * ПОСЛЕДНИЙ диалог; (2) Escape и Tab обрабатывает только ВЕРХНИЙ диалог — иначе
 * Escape закрыл бы оба сразу, а Tab-ловушки начали бы спорить друг с другом.
 */
const _openStack = [];

/**
 * Стили фона и панели. Отдельная ЧИСТАЯ функция — не ради красоты: девять
 * диалогов теперь зависят от этих значений, а проверить их в браузере нельзя
 * (рендер в Node не поддерживает порталы). Здесь они зафиксированы значениями
 * в `npm run check:logic`: если кто-то поменяет отступы или выравнивание,
 * проверка это покажет.
 */
export function modalLayout({ align = "top", variant = "dialog", zIndex = 1000, maxWidth = 520, style, backdropStyle } = {}) {
  if (variant === "drawer") {
    return {
      backdrop: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.35)", zIndex, ...backdropStyle },
      panel: {
        position: "fixed", top: 0, right: 0, bottom: 0,
        width: "100%", maxWidth, background: "var(--c-surface)",
        boxShadow: "-4px 0 24px rgba(0,0,0,0.1)", zIndex: zIndex + 1,
        display: "flex", flexDirection: "column", overflow: "hidden",
        ...style,
      },
    };
  }
  const top = align === "top";
  return {
    backdrop: {
      position: "fixed", inset: 0,
      background: "rgba(15,23,42,0.45)",
      zIndex,
      display: "flex",
      alignItems: top ? "flex-start" : "center",
      justifyContent: "center",
      padding: top ? "60px 16px 16px" : "16px",
      // При align="top" прокручивается фон (как было в исходных модалках),
      // поэтому у панели нет maxHeight; при align="center" — страховка.
      overflowY: top ? "auto" : undefined,
      ...backdropStyle,
    },
    panel: {
      background: "var(--c-surface)",
      borderRadius: 14,
      padding: top ? 22 : 24,
      width: "100%",
      maxWidth,
      boxShadow: "0 20px 50px rgba(0,0,0,0.20)",
      ...(top ? {} : { maxHeight: "calc(100vh - 32px)", overflowY: "auto" }),
      ...style,
    },
  };
}

export function Modal({
  onClose,
  children,
  label,                       // aria-label: короткий текст, если нет заголовка с id
  labelledBy,                  // id заголовка внутри диалога — предпочтительнее
  maxWidth = 520,
  align = "top",               // "top" | "center"
  variant = "dialog",          // "dialog" | "drawer"
  zIndex = 1000,
  className = "fc-modal-pop",  // анимация появления (см. useGlobalStyles)
  backdropStyle,               // точечные исключения по фону
  style,                       // точечные исключения по панели
  closeOnBackdrop = true,
}) {
  const panelRef = useRef(null);
  const restoreRef = useRef(null);
  // ВАЖНО: onClose у вызывающих — инлайн-стрелка, то есть НОВАЯ функция на каждом
  // рендере. Если бы эффект зависел от неё, он перезапускался бы при каждом
  // нажатии клавиши (любой setState в форме = рендер), заново ставил начальный
  // фокус и уводил бы курсор из поля в первое поле формы. Держим её в ref,
  // а зависимостей у эффекта нет вовсе — срабатывает один раз на открытие.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const panel = panelRef.current;
    const self = {};                     // идентификатор этого диалога в стеке
    restoreRef.current = typeof document !== "undefined" ? document.activeElement : null;
    const isTopmost = () => _openStack[_openStack.length - 1] === self;

    const onKeyDown = (ev) => {
      if (!isTopmost()) return;          // клавиатуру обрабатывает только верхний диалог
      if (ev.key === "Escape") {
        ev.stopPropagation();
        if (closeRef.current) closeRef.current();
        return;
      }
      if (ev.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll(FOCUSABLE))
        .filter((el) => el.offsetParent !== null || el === panel);
      const idx = items.indexOf(document.activeElement);
      const next = focusCycleIndex(items.length, idx, ev.shiftKey);
      if (next < 0) {                    // внутри нет фокусируемых — держим на панели
        ev.preventDefault();
        panel.focus();
        return;
      }
      // Не даём браузеру выйти за пределы панели: на краях круга перехватываем Tab.
      const atEdge = ev.shiftKey ? (idx <= 0) : (idx === items.length - 1 || idx < 0);
      if (atEdge) {
        ev.preventDefault();
        items[next].focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    const first = panel && panel.querySelector(FOCUSABLE);
    if (first && first.focus) first.focus();
    else if (panel && panel.focus) panel.focus();

    _openStack.push(self);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const at = _openStack.indexOf(self);
      if (at >= 0) _openStack.splice(at, 1);
      if (_openStack.length === 0) document.body.style.overflow = prevOverflow;   // фон разблокируем последним
      const back = restoreRef.current;
      if (back && back.focus) back.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- см. комментарий про closeRef
  }, []);

  const isDrawer = variant === "drawer";

  const closeByBackdrop = () => { if (closeOnBackdrop && onClose) onClose(); };
  const aria = labelledBy ? { "aria-labelledby": labelledBy } : (label ? { "aria-label": label } : {});

  const panelProps = {
    ref: panelRef,
    className: className || undefined,
    role: "dialog",
    "aria-modal": "true",
    ...aria,
    tabIndex: -1,
  };

  const { backdrop, panel } = modalLayout({ align, variant, zIndex, maxWidth, style, backdropStyle });

  // ── Выдвижная панель справа (журнал действий): фон и панель — соседи ──
  if (isDrawer) {
    return createPortal(
      <>
        <div onClick={closeByBackdrop} style={backdrop} />
        <div {...panelProps} style={panel}>{children}</div>
      </>
    , document.body);
  }

  // ── Обычный диалог: панель ВНУТРИ фона — фон центрирует её флексом ──
  return createPortal(
    <div onClick={closeByBackdrop} style={backdrop}>
      <div {...panelProps} onClick={(e) => e.stopPropagation()} style={panel}>
        {children}
      </div>
    </div>,
    document.body
  );
}

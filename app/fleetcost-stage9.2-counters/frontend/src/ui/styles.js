import { MONO } from "../lib/format.js";
import { useEffect } from "react";

/** Единый объект инлайн-стилей (s.page, s.cardTitle, s.btn, …) и глобальные
 *  стили приложения (useGlobalStyles, useFonts).
 *  Вынесено из App.jsx — это самая востребованная точка правок. */
/**
 * Отступ, который освобождают под значки в правом нижнем углу плашки.
 * 34 = ширина значка исходных сумм (~22px) + зазор 12px, то же расстояние,
 * что и у бейджа сравнения в правом верхнем углу. Одно число на все вкладки:
 * иначе подпись под суммой заходила бы под значок на узких плашках.
 */
export const KPI_CORNER_PAD=34;

export const s={
  sidebar:{width:256,background:"var(--c-surface)",borderRight:"1px solid var(--c-border-3)",display:"flex",flexDirection:"column",flexShrink:0,transition:"width 0.2s ease",overflow:"hidden"},
  sidebarLogo:{padding:"16px 14px",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid var(--c-border-3)",minHeight:56},
  logoIcon:{width:34,height:34,background:"var(--c-brand-solid)",borderRadius:"var(--r-lg)",display:"flex",alignItems:"center",justifyContent:"center",color:"var(--c-on-brand)",fontWeight:800,fontSize:16,flexShrink:0,boxShadow:"0 4px 10px rgba(79,70,229,0.25)"},
  navItem:{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",cursor:"pointer",fontSize:12,fontWeight:500,color:"var(--c-muted-2)",borderRadius:"var(--r-lg)",margin:"2px 8px",transition:"background 0.15s, color 0.15s",overflow:"hidden",whiteSpace:"nowrap"},
  navActive:{background:"var(--c-brand-bg)",color:"var(--c-brand)",fontWeight:600},
  langBtn:{flex:1,padding:"4px",border:"1px solid var(--c-border)",borderRadius:"var(--r-xs)",cursor:"pointer",fontSize:12,fontWeight:600,background:"var(--c-surface)",color:"var(--c-muted-2)",transition:"background 0.15s, color 0.15s"},
  langActive:{background:"var(--c-brand-solid)",color:"var(--c-on-brand)",border:"none"},
  page:{padding:"24px 28px",maxWidth:1440,margin:"0 auto",width:"100%",boxSizing:"border-box"},
  pageHeader:{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20,flexWrap:"wrap",gap:10},
  pageTitle:{fontSize:21,fontWeight:800,margin:0,color:"var(--c-text)",letterSpacing:-0.3},
  cardTitle:{fontSize:13,fontWeight:700,margin:"0 0 14px",color:"var(--c-text)",textTransform:"uppercase",letterSpacing:0.6},
  // Подпись под заголовком карточки: что внутри и зачем (как в редизайне).
  cardSub:{fontSize:12,color:"var(--c-muted-2)",margin:"-8px 0 12px",lineHeight:1.45},
  // Полоса заголовка таблицы: у всех таблиц одинаковый фон и граница.
  theadBand:{background:"var(--c-hover)",borderBottom:"1px solid var(--c-border-3)"},
  // Янтарная подсказка «что делать дальше»: не ошибка и не успех, поэтому
  // своего цвета. Не исчезает сама — по ней оператор выполняет действие.
  warnNote:{background:"var(--c-warn-bg-2)",border:"1px solid var(--c-warn-border)",color:"var(--c-warn-strong)",
            borderRadius:10,padding:"10px 12px",fontSize:12.5,lineHeight:1.5,
            marginBottom:14,display:"flex",gap:10,alignItems:"flex-start"},
  kpiLabel:{fontSize:11,fontWeight:700,color:"var(--c-muted-2)",textTransform:"uppercase",letterSpacing:0.6,marginBottom:5},
  kpiValue:{fontSize:19,fontWeight:800,color:"var(--c-text)",fontFamily:MONO,letterSpacing:-0.3},
  row:{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:"1px solid var(--c-hover)"},
  empty:{textAlign:"center",color:"var(--c-muted-2)",padding:"18px 0",fontStyle:"italic"},
  th:{padding:"9px 12px",fontSize:11,fontWeight:700,color:"var(--c-muted-2)",textTransform:"uppercase",letterSpacing:0.6,textAlign:"left"},
  td:{padding:"9px 12px",fontSize:13,color:"var(--c-text-5)"},
  btn:{padding:"7px 12px",border:"1px solid var(--c-border)",borderRadius:"var(--r-md)",background:"var(--c-surface)",cursor:"pointer",fontSize:13,fontWeight:500,color:"var(--c-text-5)"},
  btnPrimary:{padding:"7px 14px",border:"none",borderRadius:"var(--r-md)",background:"var(--c-brand-solid)",color:"var(--c-on-brand)",cursor:"pointer",fontSize:13,fontWeight:600,boxShadow:"0 2px 6px rgba(79,70,229,0.25)"},
  btnDanger:{padding:"3px 9px",border:"none",borderRadius:"var(--r-xs)",background:"var(--c-danger-bg)",color:"var(--c-danger)",cursor:"pointer",fontSize:13,fontWeight:600},
  // Фон и цвет заданы ЯВНО. Раньше их не было, и поле оставалось браузерным
  // (белым): в тёмной теме оно выглядело тёмным только потому, что мы ставим
  // `color-scheme:dark` на <html>. Это работало не во всех браузерах и не в
  // превью — проверка темы нашла белый прямоугольник ровно на этом поле.
  input:{width:"100%",padding:"8px 11px",border:"1px solid var(--c-border)",borderRadius:"var(--r-md)",
         fontSize:14,outline:"none",boxSizing:"border-box",
         background:"var(--c-surface)",color:"var(--c-text)"},
  select:{width:"100%",padding:"8px 11px",border:"1px solid var(--c-border)",borderRadius:"var(--r-md)",
          fontSize:14,outline:"none",boxSizing:"border-box",
          background:"var(--c-surface)",color:"var(--c-text)"},
  textarea:{width:"100%",padding:"8px 11px",border:"1px solid var(--c-border)",borderRadius:"var(--r-md)",
            fontSize:14,outline:"none",boxSizing:"border-box",fontFamily:"inherit",
            background:"var(--c-surface)",color:"var(--c-text)"},
  label:{display:"block",fontSize:13,fontWeight:600,color:"var(--c-muted-2)",marginBottom:4},
  flash:{background:"var(--c-success-bg-2)",color:"var(--c-success-dark)",padding:"10px 14px",borderRadius:"var(--r-md)",marginBottom:14,fontSize:14,whiteSpace:"pre-wrap",maxHeight:300,overflowY:"auto"},
  dropdown:{position:"absolute",top:"calc(100% + 6px)",right:0,background:"var(--c-surface)",border:"1px solid var(--c-border-3)",borderRadius:"var(--r-lg)",boxShadow:"0 8px 24px rgba(0,0,0,0.08)",zIndex:100,minWidth:180,overflow:"hidden"},
  dropItem:{padding:"9px 14px",fontSize:13,cursor:"pointer",color:"var(--c-text-5)"},
  dateIn:{width:"100%",padding:"6px 10px",border:"1px solid var(--c-border)",borderRadius:"var(--r-sm)",fontSize:13},
  // Правый нижний угол плашки: значки «исходные суммы» и «есть валюта без курса».
  // Отступы 12px — те же, что у бейджа сравнения в правом верхнем углу, поэтому
  // оба значка стоят в одной вертикальной колонке. Одинаково на всех вкладках.
  kpiCorner:{position:"absolute",bottom:12,right:12,display:"flex",alignItems:"center",gap:6,zIndex:2},
  filterSelect:{padding:"6px 10px",border:"1px solid var(--c-border)",borderRadius:"var(--r-md)",fontSize:12,background:"var(--c-surface)",cursor:"pointer",color:"var(--c-text-5)",outline:"none"},
  filterBar:{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",padding:"10px 16px",background:"var(--c-surface)",borderRadius:"var(--r-lg)",border:"1px solid var(--c-border-3)",marginBottom:14,boxShadow:"0 4px 20px rgba(0,0,0,0.015)"},
  kpiCardCompact:{background:"var(--c-surface)",borderRadius:"var(--r-xl)",border:"1px solid var(--c-border-3)",padding:"14px 16px",boxShadow:"0 4px 20px rgba(0,0,0,0.015)"},
  kpiCardProfit:{borderRadius:"var(--r-xl)",padding:"14px 16px"},
  groupTitle:{padding:"8px 16px",fontSize:11,fontWeight:700,color:"var(--c-muted-2)",textTransform:"uppercase",letterSpacing:1},
};

/**
 * Пилюля-бейдж: фон, текст и рамка одним набором цветов.
 * Нужна, чтобы бейджи в разных разделах не разъезжались по форме — раньше
 * каждый рисовался инлайн и отличался радиусом, отступами и толщиной шрифта.
 * Цвета выбирает вызывающий: смысловые группы (спокойный / предупреждение /
 * разрушительное) — его решение, форма — общая.
 */
export function pill(bg, fg, bd) {
  return {
    display: "inline-block", padding: "4px 10px", borderRadius: 999,
    fontSize: 12, fontWeight: 600, background: bg, color: fg,
    border: `1px solid ${bd}`, whiteSpace: "nowrap", lineHeight: 1.4,
  };
}

export function useFonts(){
  // Раньше здесь динамически подключался CSS с fonts.googleapis.com (и он же
  // дублировался ссылкой в index.html — то есть внешний запрос уходил дважды).
  // Теперь Inter и JetBrains Mono приходят из сборки (см. main.jsx), поэтому
  // хук ничего не делает и оставлен только для совместимости вызовов.
}
export function useGlobalStyles(){
  useEffect(()=>{
    if(document.getElementById("fc-global")) return;
    const style=document.createElement("style");
    style.id="fc-global";
    style.textContent=`
      :root{
        /* Палитра CSS-классов. Раньше здесь были собственные хексы — вторая
           палитра рядом с инлайн-стилями, и тёмная тема не покрыла бы её.
           Теперь это ССЫЛКИ на общие переменные темы (--c-*, см. lib/theme.js):
           источник правды один, и классы перекрашиваются вместе со всем
           интерфейсом. */
        --bg-body:var(--c-app);--border-color:var(--c-border-2);--text-main:var(--c-text-2);
        --text-muted:var(--c-muted-3);--text-light:var(--c-muted-2);
        --primary:var(--c-brand-solid);--primary-light:var(--c-brand-bg);
        --success:var(--c-emerald-500);--success-bg:var(--c-success-bg-3);
        --danger:var(--c-danger-400);--danger-bg:var(--c-danger-bg);
        --warning:var(--c-warn-500);--info:var(--c-blue-500);
        --purple:var(--c-violet-500);--teal:var(--c-teal-400);
        /* Шкала радиусов и отступов: раньше в разметке жили 7 разных радиусов
         (6/8/10/12/14/16/20) и паддинги 8/10/12/14/16/20 без системы. */
      --r-xs:6px; --r-sm:8px; --r-md:10px; --r-lg:12px; --r-xl:16px; --r-2xl:20px;
      --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:20px; --sp-6:24px;
      --mono:'JetBrains Mono Variable','JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
      }
      /* Табличные цифры: одинаковая ширина у всех цифр, иначе разряды в
         колонках «Сумма/Объём/Цена» не совпадают по вертикали. */
      /* БАЗОВЫЙ цвет текста и фона. Без этого правила любой элемент без
         собственного цвета берёт браузерный чёрный: в светлой теме это
         незаметно, а в тёмной такой текст сливается с фоном (найдено измерением
         превью: контраст 1.21 у подписей и числовых данных). Наследования от
         <html> недостаточно — правило на body надёжнее и не зависит от порядка
         загрузки скриптов. */
      html,body{background:var(--c-app);color:var(--c-text);}
      body{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;}
      /* Скелетон загрузки: вместо «нули → данные» показываем структуру.
         Так макет не прыгает, и понятно, что идёт загрузка. */
      .fc-skel{background:linear-gradient(90deg,var(--c-surface-3) 25%,var(--c-surface-3) 37%,var(--c-surface-3) 63%);
        background-size:400% 100%;animation:fcSkel 1.2s ease-in-out infinite;border-radius:6px;}
      @keyframes fcSkel{0%{background-position:100% 50%}100%{background-position:0 50%}}
      /* Появление модальных окон и панелей: раньше они «выскакивали» мгновенно,
         хотя выпадающий календарь анимировался. */
      .fc-modal-pop{animation:fcPopIn .16s cubic-bezier(.16,1,.3,1);}

      /* Вкладки администрирования и строки журнала: подсветка при наведении.
         Раньше строки журнала были «мёртвыми» — курсор над строкой ничего не
         менял, хотя клик по строке открывал детали. */
      .fc-admintab:hover{background:var(--c-hover);color:var(--c-text);}
      /* Подсветка строки при наведении — общая для всех таблиц (журнал,
         пользователи, история импортов, курсы). Раньше строки были «мёртвыми»:
         курсор ничего не менял, хотя клик по строке открывал детали. */
      .fc-row-hover:hover{background:var(--c-hover);}
      .fc-audit-open{opacity:.6;transition:opacity .15s;}
      .fc-row-hover:hover .fc-audit-open{opacity:1;}

      /* Кнопки действий на страницах: состояния наведения, фокуса и блокировки.
         Раньше кнопки различались только цветом фона и на наведение не
         реагировали — по ним не читалось, что они нажимаемые, а заблокированная
         кнопка выглядела рабочей. Три роли: primary (основное действие),
         secondary (равнозначное, но не главное), danger (необратимое). */
      .fc-btn{transition:background .15s,border-color .15s,filter .15s,box-shadow .15s;}
      .fc-btn-primary:hover:not(:disabled){filter:brightness(.93);}
      .fc-btn-secondary:hover:not(:disabled){background:var(--c-hover);border-color:var(--c-border-3);}
      .fc-btn-danger:hover:not(:disabled){filter:brightness(.96);}
      .fc-btn:disabled{opacity:.55;cursor:not-allowed;}
      .fc-btn:focus-visible{outline:2px solid var(--c-brand-solid);outline-offset:2px;}

      /* Спиннер для кнопок в состоянии работы. Кольцо рисуется рамкой с
         прозрачным верхом и наследует currentColor, поэтому подходит и на
         синей, и на жёлтой кнопке. Размер фиксирован — именно потому он не
         растягивает кнопку при смене «стрелки» на «вертушку». */
      .fc-spin{display:inline-block;width:14px;height:14px;border-radius:50%;
               border:2px solid currentColor;border-top-color:transparent;
               flex:0 0 auto;animation:fcSpin .8s linear infinite;}
      @keyframes fcSpin{to{transform:rotate(360deg);}}

      /* Кнопка синхронизации: размер строго фиксирован, иначе при смене подписи
         на «Загрузка…» кнопка меняла ширину и соседние элементы уезжали —
         интерфейс «дёргался» ровно в момент, когда пользователь ждёт ответа.
         Подпись обрезается, а не переносится: перенос увеличил бы высоту. */
      .fc-sync-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;
                   white-space:nowrap;overflow:hidden;flex:0 0 auto;
                   transition:background .3s ease,border-color .3s ease,color .3s ease;}
      .fc-sync-btn.fc-busy{background:var(--c-warn-bg)!important;border:1px solid var(--c-warn-border)!important;
                           color:var(--c-warn-strong)!important;cursor:progress;}
      .fc-sync-btn:focus-visible{outline:2px solid var(--c-brand-solid);outline-offset:2px;}

      /* Фильтр источника. Внутри — настоящий <select> (прозрачный, растянут по
         кнопке): так сохраняется системный список и работа с клавиатуры, а
         нарисованный вид задаём сами, как у фильтра даты. */
      .fc-src{position:relative;display:inline-flex;align-items:center;gap:7px;
              padding:7px 12px;border:1px solid var(--c-border);border-radius:var(--r-md);
              background:var(--c-surface);font-size:13px;font-weight:500;color:var(--c-text-5);
              cursor:pointer;max-width:220px;
              transition:background .15s ease,border-color .15s ease,box-shadow .15s ease;}
      .fc-src:hover{background:var(--c-hover);border-color:var(--c-border-3);}
      .fc-src:focus-within{border-color:var(--c-brand);box-shadow:0 0 0 3px var(--c-brand-bg);}
      .fc-src-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .fc-src-chev{font-size:11px;color:var(--c-muted-2);transition:transform .2s ease;display:inline-block;}
      .fc-src:focus-within .fc-src-chev{transform:rotate(180deg);}
      .fc-src-native{position:absolute;inset:0;width:100%;height:100%;opacity:0;
                     cursor:pointer;border:none;background:none;font-size:16px;}

      /* Подсказка к элементу шапки. Живёт отдельным слоем (портал), потому что
         шапка дашборда прокручивается по горизонтали: обычная подсказка внутри
         неё была бы обрезана по краю или добавила бы полосу прокрутки. */
      .fc-hint{position:fixed;z-index:9999;pointer-events:none;
               background:var(--c-text);color:var(--c-surface);
               border-radius:10px;padding:9px 11px;font-size:12px;line-height:1.45;
               box-shadow:0 10px 24px rgba(15,23,42,.22);
               animation:fcPopIn .14s ease-out;}
      .fc-hint-title{font-weight:700;margin-bottom:6px;padding-bottom:5px;
                     border-bottom:1px solid rgba(148,163,184,.35);}
      .fc-hint-row{display:flex;justify-content:space-between;gap:14px;white-space:nowrap;}
      .fc-hint-row b{font-variant-numeric:tabular-nums;}

      /* Чип «транзакции / авто» в шапке: вместо двух крупных плашек — одна
         компактная. Наведение подсказывает, что внутри. */
      .fc-stat-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;
                    border:1px solid var(--c-border-2);border-radius:10px;
                    background:var(--c-surface-2);color:var(--c-muted);
                    font-size:12px;font-weight:700;cursor:help;line-height:1;
                    font-variant-numeric:tabular-nums;
                    transition:background .15s ease,border-color .15s ease;}
      .fc-stat-chip:hover{background:var(--c-hover);border-color:var(--c-border-3);}

      /* Квадратная кнопка со значком (экспорт): подпись убрана, смысл — в
         подсказке. Размер 32×32 совпадает с высотой соседних элементов. */
      .fc-icon-btn{display:inline-flex;align-items:center;justify-content:center;
                   flex:0 0 auto;cursor:pointer;border:1px solid var(--c-border);
                   border-radius:var(--r-md);background:var(--c-surface);color:var(--c-text-5);
                   transition:background .15s ease,border-color .15s ease;}
      .fc-icon-btn:hover:not(:disabled){background:var(--c-hover);border-color:var(--c-border-3);}
      .fc-icon-btn:disabled{opacity:.55;cursor:not-allowed;}
      .fc-icon-btn:focus-visible{outline:2px solid var(--c-brand-solid);outline-offset:2px;}

      /* Кружок «i» с пояснением (InfoDot): серая заливка, светлая буква внутри.
         Почему заливка, а не светлый кружок с серой обводкой: светлый кружок на
         белой шапке давал контраст 1.1:1 — форма просто не читалась, значок
         приходилось искать глазами (проверено измерением, а не на глаз).
         Сейчас: заливка --c-muted-3 к фону шапки 4.8:1 (светлая тема) и 5.4:1
         (тёмная) — при норме 3:1 для элементов управления (WCAG 1.4.11), буква
         внутри 4.8:1 / 5.4:1 при норме 4.5:1 для мелкого текста.
         Оттенки только из переменных темы: в тёмной теме тот же приём даёт
         светлый кружок с тёмной буквой, и знак не «пропадает».
         position:relative нужен для ::after из .fc-tap-24: зона нажатия 24px при
         визуальных 14px, иначе в кружок трудно попасть мышью (WCAG 2.5.8). */
      .fc-info-dot{position:relative;display:inline-flex;align-items:center;justify-content:center;
                   box-sizing:border-box;width:14px;height:14px;padding:0;flex:0 0 auto;
                   border:none;border-radius:50%;cursor:help;
                   background:var(--c-muted-3);color:var(--c-surface);
                   font-size:10px;font-weight:700;font-style:italic;line-height:1;
                   font-family:Georgia,"Times New Roman",serif;text-align:center;
                   transition:background .15s ease;}
      .fc-info-dot:hover,.fc-info-dot:focus-visible{background:var(--c-muted);}
      .fc-info-dot:focus-visible{outline:2px solid var(--c-brand-solid);outline-offset:2px;}

      /* ─── Блок «Регулярные платежи» ────────────────────────────────────
         Единая таблица для всех вкладок: (i) · договор · платёж · срок ·
         прогресс · статус · меню «…». Колонки фиксированные, а у списка есть
         минимальная ширина и горизонтальная прокрутка: на узком экране
         колонки не налезают друг на друга (раньше сетка схлопывалась в две
         колонки и всё слипалось). Меню действий рисуется поверх страницы
         (портал, position:fixed) — вертикальной прокрутки в блоке оно не даёт. */
      .fc-rec-scroll{overflow-x:auto;}
      .fc-rec-table{min-width:880px;}
      .fc-rec-row,.fc-rec-head{display:grid;align-items:center;column-gap:14px;padding:0 16px;
                  grid-template-columns:30px minmax(170px,1.5fr) 120px 168px minmax(170px,1.1fr) 96px 34px;}
      .fc-rec-row{padding-top:11px;padding-bottom:11px;border-top:1px solid var(--c-surface-2);}
      .fc-rec-row:hover{background:var(--c-surface-2);}
      .fc-rec-head{padding-top:8px;padding-bottom:8px;
                   font-size:10.5px;font-weight:700;text-transform:uppercase;
                   letter-spacing:0.5px;color:var(--c-text-4);}
      .fc-rec-progress{height:5px;border-radius:3px;background:var(--c-surface-3);
                       overflow:hidden;margin-top:5px;}
      .fc-rec-progress>i{display:block;height:100%;background:var(--c-brand-solid);border-radius:3px;}
      .fc-rec-info{width:26px;height:26px;border-radius:50%;display:inline-flex;align-items:center;
                   justify-content:center;border:1px solid var(--c-info-border);cursor:pointer;
                   background:var(--c-info-bg);color:var(--c-info-2);font-size:13px;font-weight:700;
                   font-family:Georgia,serif;font-style:italic;line-height:1;padding:0;}
      .fc-rec-info:hover{background:var(--c-brand-solid);color:var(--c-on-brand);}
      .fc-rec-more{width:28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;
                   justify-content:center;border:none;background:transparent;cursor:pointer;
                   color:var(--c-muted-2);font-size:18px;line-height:1;padding:0;font-family:inherit;}
      .fc-rec-more:hover,.fc-rec-more[aria-expanded="true"]{background:var(--c-surface-3);color:var(--c-text);}
      .fc-rec-menu{position:fixed;z-index:1000;min-width:184px;background:var(--c-surface);
                   border:1px solid var(--c-border);border-radius:12px;padding:4px;
                   box-shadow:0 10px 30px rgba(15,23,42,0.18);}
      .fc-rec-menu button{width:100%;display:flex;align-items:center;gap:9px;padding:8px 10px;
                   border:none;background:transparent;border-radius:8px;cursor:pointer;
                   font-family:inherit;font-size:12.5px;color:var(--c-text);text-align:left;}
      .fc-rec-menu button:hover{background:var(--c-surface-2);}
      .fc-rec-menu button.danger{color:var(--c-danger-strong);}
      .fc-rec-menu hr{border:none;border-top:1px solid var(--c-surface-2);margin:4px 2px;}

      /* ─── Карточки «Структура расходов» ────────────────────────────────
         Все карточки одного размера, длинный список прокручивается по
         горизонтали. Это и требовалось: при переключении между авто ничего не
         должно «прыгать» — у одного авто пять категорий, у другого одна. */
      .fc-struct-scroll{display:flex;gap:12px;overflow-x:auto;padding:2px 2px 10px;}
      .fc-struct-card{flex:0 0 272px;max-width:272px;display:flex;flex-direction:column;
                      background:var(--c-surface);border:1px solid var(--c-border-3);
                      border-radius:14px;padding:13px 14px;}
      @media (max-width:640px){.fc-struct-card{flex:0 0 232px;max-width:232px;}}
      .fc-struct-cat{display:flex;align-items:center;justify-content:space-between;gap:8px;
                     padding:5px 0;border-top:1px solid var(--c-surface-2);font-size:12px;}
      .fc-struct-cat:first-child{border-top:none;}

      /* Внутренний скролл в карточках: полоса не «прыгает» между темами и не
         отъедает ширину у таблицы. */
      .fc-scroll{scrollbar-width:thin;scrollbar-color:var(--c-border-3) transparent;}
      .fc-scroll::-webkit-scrollbar{width:8px;height:8px;}
      .fc-scroll::-webkit-scrollbar-thumb{background:var(--c-border-3);border-radius:8px;}
      .fc-scroll::-webkit-scrollbar-track{background:transparent;}
      @keyframes fcPopIn{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}

      /* Уважаем системную настройку «уменьшить движение». */
      @media (prefers-reduced-motion:reduce){
        *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important;}
      }
      .fc-num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;}

      .fc-sidebar{transition:width .3s cubic-bezier(.4,0,.2,1),padding .3s ease;}
      .fc-collapse-btn{transition:transform .3s ease,background-color .2s;}
      .fc-collapse-btn.rot{transform:rotate(180deg);}
      .fc-nav-item{transition:background .15s,color .15s;}
      /* Поля ввода вне токенов (их рисуют и без s.input): без этого правила
         они остаются браузерными, то есть белыми в тёмной теме. Инлайн-стиль
         сильнее, поэтому намеренно прозрачные поля не затрагиваются. */
      input,select,textarea{background:var(--c-surface);color:var(--c-text);}
      input::placeholder,textarea::placeholder{color:var(--c-muted-4);}
      input[type="checkbox"],input[type="radio"]{accent-color:var(--c-brand-solid);}
      .fc-nav-item:hover{background:var(--primary-light);color:var(--primary);}
      .fc-nav-item:hover .fc-nav-icon{color:var(--primary);}
      .fc-nav-group-head{transition:background .15s,color .15s;}
      .fc-nav-group-head:hover{background:var(--c-hover);color:var(--text-main);}
      .fc-nav-item:focus-visible,.fc-nav-group-head:focus-visible,.fc-nav-chevron:focus-visible{outline:2px solid var(--primary);outline-offset:1px;}
      .fc-nav-chevron{transition:transform .2s ease;display:inline-flex;align-items:center;}
      .fc-nav-chevron.fc-closed{transform:rotate(-90deg);}

      .fc-select{
        padding:6px 12px;border-radius:8px;font-size:12px;font-weight:600;
        border:1px solid var(--border-color);background:var(--c-surface);color:var(--text-main);
        cursor:pointer;outline:none;
      }
      .fc-btn-primary{background:var(--primary);color:var(--c-on-brand);border:none;}

      .fc-kpi-scroll,.fc-cards-scroll,.fc-card-body-scroll{scroll-behavior:smooth;-webkit-overflow-scrolling:touch;}
      .fc-kpi-scroll::-webkit-scrollbar,.fc-cards-scroll::-webkit-scrollbar{height:6px;}
      .fc-kpi-scroll::-webkit-scrollbar-thumb,.fc-cards-scroll::-webkit-scrollbar-thumb{background:var(--c-border-strong);border-radius:4px;}
      .fc-card-body-scroll::-webkit-scrollbar{width:4px;}
      .fc-card-body-scroll::-webkit-scrollbar-thumb{background:var(--c-border-2);border-radius:4px;}

      .fc-overlay{display:none;position:fixed;inset:0;background:rgba(15,23,42,.4);z-index:150;}
      .fc-overlay.fc-open{display:block;}
      .fc-mobile-topbar{display:none;}

      .fc-dp-trigger{transition:all .15s ease;}
      .fc-dp-trigger:hover,.fc-dp-trigger.fc-open{border-color:var(--primary) !important;color:var(--primary) !important;box-shadow:0 0 0 3px rgba(79,70,229,.12);}
      .fc-dp-chevron{transition:transform .2s ease;display:inline-block;}
      .fc-dp-trigger.fc-open .fc-dp-chevron{transform:rotate(180deg);}
      @keyframes fcDpPopIn{from{opacity:0;transform:translateY(-8px) scale(.98);}to{opacity:1;transform:translateY(0) scale(1);}}
      .fc-dp-popup{animation:fcDpPopIn .2s cubic-bezier(.16,1,.3,1);}
      .fc-dp-preset{transition:all .15s ease;}
      .fc-dp-preset:hover{background:var(--primary-light);color:var(--primary);}
      .fc-dp-preset.fc-active{background:var(--primary-light);color:var(--primary);font-weight:700;}
      .fc-dp-day{transition:background-color .15s ease,color .15s ease;}
      .fc-dp-day:not(.fc-muted):hover{background:var(--c-surface-3);}
      .fc-dp-nav{transition:all .15s ease;}
      .fc-dp-nav:hover{background:var(--bg-body);color:var(--text-main);}
      @media (max-width:768px){
        .fc-dp-popup{position:fixed !important;top:auto !important;bottom:0 !important;left:0 !important;right:0 !important;width:100% !important;max-width:100% !important;border-radius:20px 20px 0 0 !important;max-height:85vh;overflow-y:auto;}
        .fc-dp-body{flex-direction:column;}
        .fc-dp-presets{width:100% !important;border-right:none !important;border-bottom:1px solid var(--border-color);flex-direction:row !important;overflow-x:auto;}
        .fc-dp-calendars{flex-direction:column !important;}
      }

      .fc-main-financial-grid{display:grid;grid-template-columns:repeat(4,minmax(180px,1fr));gap:16px;}
      .fc-main-financial-grid > div{min-width:0;overflow:hidden;}
      .fc-kpi-equal-grid{display:grid;grid-auto-flow:column;grid-auto-columns:160px;gap:12px;}
      .fc-equal-card-grid{display:grid;grid-auto-flow:column;grid-auto-columns:280px;gap:16px;}

      /* ── Раскладка переработанного дашборда ──────────────────────────────
         Две пары карточек вместо прежних прокручиваемых вправо рядов: слева
         широкий блок с деталями, справа компактный. minmax(0,…) обязателен:
         без него колонка с длинными числами распирает сетку и появляется
         горизонтальная прокрутка всей страницы (та же ошибка, что была у
         ряда KPI-карточек до правки). */
      .fc-dash-split{display:grid;grid-template-columns:minmax(0,1.9fr) minmax(0,1fr);gap:16px;align-items:start;}
      .fc-dash-split-2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start;}
      @media (max-width:1180px){.fc-dash-split{grid-template-columns:1fr;}}
      @media (max-width:1000px){.fc-dash-split-2{grid-template-columns:1fr;}}

      /* Строка «Финансы по авто». Одна раскладка колонок на заголовок и строки,
         иначе столбцы не совпадают по вертикали. На узком экране остаются
         только авто и прибыль — остальное видно после раскрытия строки. */
      .fc-vrow{display:grid;grid-template-columns:minmax(0,1.25fr) .8fr .95fr .95fr .95fr .72fr .55fr 26px;gap:10px;align-items:center;width:100%;}
      .fc-vhide{display:block;}
      .fc-vshow-sm{display:none;}
      @media (max-width:900px){
        .fc-vrow{grid-template-columns:minmax(0,1fr) auto;}
        .fc-vhide{display:none !important;}
        .fc-vshow-sm{display:block !important;}
      }

      /* Кольцевая диаграмма структуры расходов. Заливка приходит из данных
         (conic-gradient по реальным долям), здесь — только отверстие. */
      .fc-donut{position:relative;border-radius:50%;flex-shrink:0;margin:0 auto;}
      .fc-donut-hole{position:absolute;inset:25px;border-radius:50%;background:var(--c-surface);
        display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:4px;}

      /* Подсказка при наведении («Перераспределения»). Показывается и по
         :focus-within — иначе её содержимое недостижимо с клавиатуры.
         Фон — ПОВЕРХНОСТЬ, а не инверсия (--c-text): инверсия дала бы в тёмной
         теме светлый прямоугольник, то есть ровно то «светлое пятно», которого
         мы избегаем. Здесь подсказка темнеет вместе с остальным интерфейсом. */
      .fc-tip-wrap{position:relative;display:inline-flex;}
      /* Компактная кнопка в подсказке: визуально 20px, но зона нажатия не
         меньше 24px — по мелкой кнопке тяжело попасть мышью (WCAG 2.5.8).
         Размер на экране при этом не меняется. */
      .fc-tap-24{position:relative;}
      .fc-tap-24::after{content:"";position:absolute;left:0;right:0;top:50%;
        height:24px;transform:translateY(-50%);}
      .fc-tip{position:absolute;top:calc(100% + 8px);right:0;z-index:80;width:272px;
        padding:10px 12px;border-radius:10px;text-align:left;
        background:var(--c-surface-3);color:var(--c-text);
        border:1px solid var(--c-border-2);
        box-shadow:0 10px 26px rgba(15,23,42,0.24);
        font-size:11.5px;line-height:1.5;
        opacity:0;visibility:hidden;transform:translateY(-4px);
        transition:opacity .15s ease,transform .15s ease;pointer-events:none;}
      .fc-tip-wrap:hover .fc-tip,.fc-tip-wrap:focus-within .fc-tip{opacity:1;visibility:visible;transform:none;}

      /* Строка списка (страны / типы / последние транзакции / авто). */
      .fc-list-row{transition:background .15s ease;}
      .fc-list-row:hover{background:var(--c-hover);}
      .fc-list-row:focus-visible{outline:2px solid var(--c-brand-solid);outline-offset:-2px;}

      /* Столбик диаграммы динамики: заливка задаётся инлайном по высоте. */

      /* Currency badge "$" + popover in dashboard opex cards */
      .fc-currency-trigger{
        display:inline-flex;align-items:center;gap:2px;
        font-size:11px;font-weight:700;color:var(--c-blue);
        background:var(--c-info-bg);border:1px solid var(--c-info-border);
        padding:2px 7px;border-radius:6px;cursor:pointer;
        user-select:none;transition:background 0.15s,color 0.15s;
      }
      .fc-currency-trigger:hover,.fc-currency-trigger.fc-open{background:var(--c-info-bg-3);color:var(--c-info-2);}
      .fc-currency-popover{
        width:200px;
        background:var(--c-surface);border:1px solid var(--c-border-2);border-radius:12px;
        box-shadow:0 8px 24px rgba(16,24,40,0.18),0 2px 8px rgba(16,24,40,0.08);
        padding:10px 14px;z-index:9999;
        animation:fcFadeIn 0.15s ease-out;
      }
      @keyframes fcFadeIn{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:translateY(0);}}
      .fc-popover-header{font-size:10px;font-weight:700;text-transform:uppercase;color:var(--c-muted-3);margin-bottom:8px;border-bottom:1px solid var(--c-surface-2);padding-bottom:4px;}
      .fc-popover-row{display:flex;justify-content:space-between;align-items:center;font-size:12px;margin-bottom:6px;gap:8px;}
      .fc-popover-row:last-child{margin-bottom:0;}
      .fc-popover-amount{font-weight:600;color:var(--c-text-3);font-family:var(--mono);}
      .fc-popover-code{font-weight:700;color:var(--c-muted-3);}
      /* Валюта без курса: строка янтарная, потому что сумма не попала в итог */
      .fc-popover-row-unrated .fc-popover-amount,
      .fc-popover-row-unrated .fc-popover-code{color:var(--c-warn);}
      .fc-popover-flag{font-weight:700;font-size:10px;color:var(--c-warn);}
      .fc-popover-note{
        margin-top:9px;padding-top:8px;border-top:1px solid var(--c-warn-border);
        font-size:10.5px;line-height:1.45;color:var(--c-warn-strong);font-weight:600;
      }
      /* Значок разбивки в состоянии «часть валют не пересчитана» */
      /* Значок «валюта без курса» (см. UnratedIcon): те же размеры и цвета, что
         у значка исходных сумм, поэтому в паре они стоят вровень. Единственное
         отличие — он не нажимается, отсюда cursor:default. */
      .fc-unrated-icon{cursor:default;}
      .fc-currency-trigger.fc-currency-warn{color:var(--c-warn);background:var(--c-warn-bg-2);border-color:var(--c-warn-border);}
      .fc-currency-trigger.fc-currency-warn:hover,
      .fc-currency-trigger.fc-currency-warn.fc-open{background:var(--c-warn-bg);color:var(--c-warn-strong);}
      /* Пометка под итоговой суммой (главные KPI дашборда) */
      .fc-unrated-note{
        display:flex;align-items:flex-start;gap:5px;
        margin-top:7px;padding:5px 8px;border-radius:8px;
        background:var(--c-warn-bg-2);border:1px solid var(--c-warn-border);color:var(--c-warn-strong);
        font-size:10.5px;line-height:1.4;font-weight:600;text-align:left;
      }

      @media (max-width:900px){
        .fc-main-financial-grid{grid-template-columns:1fr;}
      }
      @media (max-width:768px){
        body,html{overflow-x:hidden;}
        .fc-collapse-btn{display:none;}
        .fc-mobile-topbar{display:flex !important;}
        .fc-sidebar{
          position:fixed !important;top:0;left:0;height:100vh;
          width:230px !important;padding:16px 12px !important;
          transform:translateX(-100%);transition:transform .3s ease;z-index:200;
          box-shadow:4px 0 20px rgba(0,0,0,.15);
        }
        .fc-sidebar.fc-open{transform:translateX(0);}
        .fc-header{flex-direction:column;align-items:flex-start !important;padding:12px 16px !important;}
        .fc-header-left{width:100%;justify-content:space-between;}
        .fc-header-controls{width:100%;overflow-x:auto;padding-bottom:4px;}
        .fc-content{padding:12px !important;gap:14px !important;}
        .fc-kpi-equal-grid{grid-auto-columns:145px;}
        .fc-equal-card-grid{grid-auto-columns:82vw;}
        .fc-table-header{flex-direction:column;align-items:flex-start !important;gap:10px;}
        .fc-table-filters{width:100%;flex-wrap:wrap;}
        .fc-table-filters select{flex:1;min-width:120px;}
      }
    `;
    document.head.appendChild(style);
  },[]);
}

import { useState, useEffect, useRef, useCallback } from "react";
import AuthPage from "./AuthPage.jsx";
import {
  API, CLIENT_ID, apiFetch, apiGet, apiMutate, isBackendDown, reportUiError,
  setBackendStateHandler, setUnauthorizedHandler, setMutationErrorHandler,
} from "./lib/api.js";
import { MONO, fmtDate, fmtDateTime, fmtDuration, fmtDurationShort, fmtInstant, fmtInt, fmtMoney, fmtQty, greeting, normalizeCompanyName, setAppLang } from "./lib/format.js";
import { useLocalState } from "./lib/hooks.js";
import { s, useFonts, useGlobalStyles } from "./ui/styles.js";
import { ENTITY_RU, FIELD_RU, FLAGS, PAGE_SIZE, SEG_PAGE_SIZE, SRC, defaultContractDescription, entityRu, fieldRu } from "./ui/constants.js";
import { Card, CurrencyBadge, DeltaBadge, DiffValue, DiffView, IncomeKpi, PaginatedSegmentsTable, ShrunkSelect, SkeletonRows, SrcFilter, TxFilterBar } from "./ui/components.jsx";
import { fmtDMY, getPeriodDates, getPrevMonthDates, isoFmt, parseISODate } from "./lib/date.js";
import { extractTrailerPlates, isAdBlue, isCarWash, isFuel, isGeneral, isIncome, isInsurance, isLeasing, isManual, isOther, isParking, isSalary, isSvcFee, isToll, isTrailer } from "./lib/tx.js";
import { Badge, PeriodSel, TxTable, sortTxns, PaginatedTxTable } from "./ui/components.jsx";
import { EUR_RATES, fmtByCur, sumToEur, toEur } from "./lib/money.js";
import { DashboardPage } from "./pages/DashboardPage.jsx";
import { FuelPage } from "./pages/FuelPage.jsx";
import { FuelLikePage } from "./pages/FuelLikePage.jsx";
import { TollsPage } from "./pages/TollsPage.jsx";
import { SalaryPage } from "./pages/SalaryPage.jsx";
import { GeneralPage } from "./pages/GeneralPage.jsx";
import { LeasingPage } from "./pages/LeasingPage.jsx";
import { TrailerPage } from "./pages/TrailerPage.jsx";
import { InsurancePage } from "./pages/InsurancePage.jsx";
import { OtherPage } from "./pages/OtherPage.jsx";
import { ManualPage } from "./pages/ManualPage.jsx";
import { MileagePage } from "./pages/MileagePage.jsx";
import { VehiclesPage } from "./pages/VehiclesPage.jsx";
import { SettingsPage } from "./pages/SettingsPage.jsx";
import { UsersPage } from "./pages/UsersPage.jsx";
import { AuditLogPage } from "./pages/AuditLogPage.jsx";
import { AdminPage } from "./pages/AdminPage.jsx";
import { ImportCenterPage } from "./pages/ImportCenterPage.jsx";
import { FxRatesPage } from "./pages/FxRatesPage.jsx";
import { IncomePage } from "./pages/IncomePage.jsx";
import { Sidebar } from "./ui/Sidebar.jsx";
import { applyTheme, readStoredTheme, resolveTheme, storeTheme, systemPrefersDark, initTheme } from "./lib/theme.js";


const T={
  RU:{
    _lang:"ru",
    dashboard:"Дашборд",vehicles:"Автомобили",fuel:"Топливо",adblue:"AdBlue",
    mileage:"Пробег",totalMileage:"Пробег флота",costPerKm:"Себестоимость км",revPerKm:"Выручка за км",costShort:"Себестоимость",revShort:"Выручка",profitShort:"Прибыль",vehColPlate:"Госномер",vehColKm:"Пробег",vehColExpense:"Расходы",vehColPlusMinus:"+/-",vehColAdbDt:"AdB / ДТ",distributedGeneralIncome:"распределённые общие доходы",
    profitPerKm:"Прибыль на 1 км",marginPct:"Маржа",avgPerVehicle:"Среднее на авто",
     uploadMileageXlsx:"Загрузить XLSX (nav.by)",mileageCol:"Пробег, км",eurPerKmCol:"€/км",
     fuelRatioCol:"AdBlue/Дизель",mergedByVehicle:"Финансы по авто",unassignedNote:"из них перераспределено",
     // ── Пояснения к сокращениям в «Финансах по авто» (кружок «i») ──
     infoDotAria:"Пояснение",
     vehColAdbDtInfo:"Соотношение AdBlue к дизелю — сколько литров AdBlue израсходовано на 100 литров топлива (то есть AdBlue как доля от объёма топлива). Нормальным считается 4–6 %. Меньше 4 % — скорее всего AdBlue не заправляли или заправляли не под этой машиной; больше 6 % — возможен перерасход, ошибка в данных или заправка AdBlue не тем водителем. Чтобы показатель был достоверным, каждый водитель должен заправляться СВОЕЙ топливной картой: если карты общие, литры AdBlue одного водителя попадут на карту другого, и соотношение по машине поедет — покажет проблему там, где её нет.",
     eurPerKmColInfo:"Себестоимость километра по этому автомобилю: все расходы по нему за период (включая его долю общих расходов и налогов, которые не привязаны к машине) делённые на пробег за тот же период. Чем ниже — тем эффективнее машина: то же расстояние обошлось дешевле. Сравнивать стоит машины между собой и один период с другим.",
     perKmRowTitle:"На 1 км пробега",
     perKmIncome:"Доход / км",
     perKmExpense:"Расход / км",
     perKmProfit:"Прибыль / км",
     perKmNoMileage:"нет пробега за период — показатель не считается",
    // ── Переработанный дашборд: подписи компактной раскладки ──
    expenseStructure:"Структура расходов",structureSub:"Разбивка по типам затрат за период",
    geoTitle:"География затрат",geoCountries:"Всего охвачено стран",geoCategories:"Всего категорий",
    geoTop:"Топ",lastTxTitle:"Последние транзакции",lastTxSub:"Оперативный поток операций автопарка",
    allTxBtn:"Перейти ко всем транзакциям",redistributions:"Перераспределения",
    expenseByCategory:"Расходы по категориям",expenseTrend:"Динамика расходов",
    directByCategoryNote:"прямые расходы по категориям, EUR",
    distributedGeneralNote:"распределённые общие расходы",
    peakBucket:"Максимум за",rowClickHint:"Нажмите строку — детализация по авто",
    noMileageData:"Нет данных о пробеге за период",vsPrevPeriod:"к пред. периоду",
    timeMoving:"Время в пути",timeStopped:"Время стоянок",utilization:"КТУ (полезное движение)",
    avgSpeed:"Средняя скорость",fuelConsumed:"Расход топлива",fuelPer100:"Расход на 100 км",
    mileageFuelTotal:"Расход топлива",
    sessionsCount:"Кол-во рейсов",stopsCount:"Кол-во стоянок",fleetOverview:"Общие показатели флота",
    vehicleCards:"По автомобилям",mileageTable:"Детализация по дням",noSegmentData:"нет данных о движении",
    trailer:"Аренда прицепа",
    mileageForPeriod:"Пробег за период",fuelAvgLabel:"Ср. расход топлива",totalStoppedDesc:"Время на стояночных базах",
    intervalLog:"Детальный журнал интервалов",driveLabel:"Движение",stopLabel:"Простой",intervalCol:"Интервал (С — По)",
    statusCol:"Статус",vehiclesSummary:"Сводка по автомобилям",activeVehiclesShort:"активных авто",
    addFuelManual:"Добавить заправку",fuelManualHint:"Для заправок в Беларуси и других местах, не фиксируемых E100/Q8. Сумма в BYN автоматически конвертируется в EUR.",
    consumptionByVehicle:"Расход по авто (расчётный, из факт. заправок)",
    // ── Tolls page ──
    tollTotalExpenses:"Итого расходы",
    tollCostPerKm:"Стоимость 1 км",
    tollMaxExpenses:"Макс. расходы",
    tollTotalTx:"Всего транзакций",
    tollCostPerKmSub:"При общем пробеге",
    tollVehiclesTitle:"Затраты на дорожные сборы по автомобилям",
    tollSumMetric:"Сумма дорог",
    tollPerKmMetric:"Затраты на 1 км",
    tollTopCountryMetric:"Топ страна",
    tollCountryCount:(n)=>{
      const mod10=n%10, mod100=n%100;
      const word=mod10===1&&mod100!==11?"транзакция":mod10>=2&&mod10<=4&&!(mod100>=12&&mod100<=14)?"транзакции":"транзакций";
      return `${n} ${word}`;
    },
    tollShareOf:(p)=>`${p}% от всех дорог`,
    tollDynamicsByDay:"Динамика расходов по дням",
    tollDynamicsByMonth:"Динамика расходов по месяцам",
    tollExpensesByVehicle:"Расходы по автомобилям",
    tollExpensesByVehicleSub:"Все авто с платными дорогами",
    tollTransShort:(n)=>`${n} транз.`,
    tollPrevPeriod:(v)=>`Было: ${v} км`,
    // ── Salary page ──
    salaryTotalExpenses:"Общие расходы",
    salaryDrivers:"Зарплаты водителей",
    salaryZus:"Налог ZUS",
    salaryPit4:"Налог PIT-4",
    salaryPerKm:"Ср. зарплата на 1 км",
    salaryPerKmSub:"При пробеге",
    salaryZusSub:"Не привязан к конкретному авто",
    salaryPit4Sub:"Авансовый налог с доходов",
    salaryDriversSub:(n)=>`${n} ${n===1?"водитель":n>=2&&n<=4?"водителя":"водителей"}`,
    salaryAllocationBanner:(zusEur,pitEur,n,perEur)=>`Общие налоги компании: ZUS (${zusEur}) и PIT-4 (${pitEur}) равномерно распределены между ${n} активными авто (${perEur} / авто) и включены в «ЗП + налоги» каждой карточки.`,
    salaryAllocationTitle:"Автоматическое распределение налогов",
    salaryVehiclesTitle:"Зарплата и Пробег по автомобилям",
    salaryPaidMetric:"Выплачено ЗП",
    salaryPaidWithTaxes:"ЗП + налоги",
    salaryRatePerKm:"Ставка / Стоимость км",
    salaryMileagePeriod:"Пробег за период",
    salaryAllTransactions:"Все транзакции по зарплате и налогам",
    salaryUnassignedExpensesNote:(eur,n,per)=>`-${eur} EUR из них перераспределено (${n}×${per})`,
    tolls:"Платные дороги",other:"Иные расходы",salary:"Зарплата",insurance:"Страховка",leasing:"Лизинг",general:"Общие расходы",income:"Доходы",settings:"Настройки",
    users:"Пользователи",audit:"Журнал действий",fxrates:"Курсы валют",admin:"Администрирование",importCenter:"Импорт данных",syncE100Hist:"Загрузить историю ЕЦБ",backfillTxns:"Заполнить EUR для старых транз.",fxLatest:"Последний курс",fxCount:"Кол-во курсов",fxEarliest:"Самая старая дата",fxLatestDate:"Самая новая дата",fxAddManual:"Добавить курс вручную",fxManualCurrency:"Валюта",fxManualRate:"Курс к EUR",fxManualDate:"Дата курса",fxConvert:"EUR-конвертер",fxConvertAmount:"Сумма",fxConvertCur:"Валюта",fxConvertDate:"Дата операции",fxConvertResult:"Результат",fxNoRates:"Нет курсов. Запустите синхронизацию.",fxHistLoading:"Загрузка исторических курсов ЕЦБ (10-30 секунд)...",fxHistDone:"История загружена",fxHistBtn:"🔄 Скачать историю курсов (с 1999)",fxTodayBtn:"🔄 Сегодняшний курс",fxBackfillBtn:"➕ Заполнить amount_eur на старых транзакциях",fxForceBackfillBtn:"↻ Пересчитать всё заново",fxCurrencies:"Известные валюты",fxRecentRates:"Последние курсы",
    statsPeriod:"Статистика периода",
    statTx:"Транзакций",
    statVehiclesActive:"Активных авто",
    vehiclesShort:"авто",
    exportHint:"Экспортировать отчёт в Excel",
    fxRateMustBePositive:"Укажите курс больше нуля для",
    fxBulkApplied:"курс применён к",
    fxBulkDatesWord:"датам",
    fxRateSaved:"Курс сохранён",
    fxBlockedOwnerOnly:"есть в архиве ЕЦБ: вручную может переопределить только владелец.",
    importError:"Ошибка импорта",
    fxConfirmHistory:"Скачать ВЕСЬ архив ЕЦБ: ~15000 строк (3000 рабочих дней × 31 валюта), 10-30 секунд.\n\nОбычно это не нужно: недостающие даты догружаются автоматически при синхронизации и импорте. Полный архив стоит качать один раз — при первом запуске, чтобы закрыть прошлые годы.",
    fxConfirmForce:"Пересчитать EUR-эквивалент ВСЕХ транзакций заново?\n\nИсторические суммы в евро изменятся — это делается один раз после исправления курса.",
    fxConfirmBackfill:"Пройтись по всем транзакциям с NULL amount_eur и заполнить EUR-эквивалент?",
    fxAutoTitle:"⚡ Автоматическая загрузка курсов",
    fxAutoSub:"Валюты ЕЦБ (EUR-кросс-курсы) берутся из ЕЦБ, остальные (BYN, UAH, RSD, MDL, GEL и др.) — из Frankfurter. Курсы обновляются сами раз в день, а при импорте и добавлении платежей недостающие даты догружаются вместе с пересчётом строк. Кнопки ниже работают сразу для обоих источников; для ваших валют вне ЕЦБ загрузка идёт по вашим данным. Ручной курс компании всегда приоритетнее.",
    fxSourceEcb:"Источники: ЕЦБ + Frankfurter",
    fxBusyLoading:"Загрузка…",
    fxBusyRecalc:"Пересчёт…",
    fxManualSubOwner:"Для валют, отсутствующих в ЕЦБ (например BYN, UAH), или переопределения официального курса на конкретную дату.",
    fxManualSubManager:"Для валют, отсутствующих в ЕЦБ (например BYN, UAH). Переопределять курс валюты из архива ЕЦБ может только владелец.",
    fxAdd:"＋ Добавить",
    fxCurInEcbAuto:"Валюта есть в архиве ЕЦБ: курс приходит автоматически, а введённое значение станет переопределением.",
    fxCurEcbOwnerOnly:"Валюта есть в архиве ЕЦБ: курс подгружается автоматически, переопределить его может только владелец.",
    fxCurManualOnly:"Валюты нет в архиве ЕЦБ: курс задаётся только вручную и действует на свою дату и 14 дней вперёд.",
    fxManualDateHint:"Курс действует на свою дату и 14 дней вперёд — для старых операций нужна ИХ дата, а не сегодняшняя.",
    fxColCurrency:"Валюта",
    fxColRate:"Курс к EUR",
    fxColDate:"Дата",
    fxColSource:"Источник",
    fxSearchPlaceholder:"Поиск…",
    fxSearchAria:"Поиск по коду валюты",
    fxSearchEmpty:"Ничего не найдено по запросу",
    fxConvertSub:"Пересчёт по курсу на выбранную дату. Считается сразу, как только заполнены поля — кнопка не нужна.",
    fxResultLabel:"Результат",
    fxConvertIdle:"Укажите сумму и дату — результат появится здесь.",
    fxCalculating:"Считаем…",
    fxBulkRateForAll:"Курс для всех дат:",
    fxApplyAllDates:"Применить ко всем датам",
    fxEnterManually:"Ввести вручную",
    fxOneValuePrefix:"Одно значение будет записано на",
    fxOneValueSuffix:"дат:",
    fxRowsFor:"строк на",
    fxSyncStarted:"⏳ Загружаю сегодняшний курс…",
    fxForceStarted:"⏳ Пересчитываю все транзакции заново…",
    fxBackfillStarted:"⏳ Пересчитываю транзакции без EUR-эквивалента…",
    fxFillAllFields:"Заполните все поля",
    fxRateNotFound:"Курс не найден",
    fxServerUnreachable:"Сервер недоступен",
    fxHideHint:"Скрыть подсказку",
    fxPageSub:"Курсы валют к EUR. Источник: ЕЦБ (Европейский Центральный Банк). Загружаются автоматически раз в день и при импорте — кнопки ниже, если нужно сделать это прямо сейчас.",
    fxViewerNote:"Вы viewer — доступен только просмотр. Ввод курса и операции доступны владельцу и менеджеру.",
    logout:"Выйти",syncE100:"Синхр. e100",exportExcel:"Экспорт",
    totalTx:"Транзакции",activeVehicles:"Авто",
    totalFuel:"Топливо",totalTolls:"Дороги",totalOther:"Иные расходы",
    totalAdBlue:"AdBlue",totalSalary:"Зарплата",totalInsurance:"Страховка",totalLeasing:"Лизинг",totalGeneral:"Общие",totalIncome:"Доходы",totalAll:"Все расходы",profit:"Прибыль/Убыток",
    byVehicle:"По транспорту (расходы)",byVehicleProfit:"По транспорту (прибыль)",byCountry:"По странам",byType:"По типам",
    noVehicle:"Без авто",
    avgPrice:"Средняя цена по странам",pricePerL:"за литр",
    recentTx:"Все транзакции",noData:"Нет данных за период",
    addVehicle:"Добавить",plate:"Госномер",driver:"Водитель",description:"Описание",
    actions:"Действия",edit:"Ред.",save:"Сохранить",cancel:"Отмена",
    addExpense:"Добавить",addSalary:"Добавить зарплату",addInsurance:"Добавить страховку",addLeasing:"Добавить лизинг",addGeneral:"Добавить расход",addIncome:"Добавить доход",expenseDate:"Дата",amount:"Сумма",currency:"Валюта",
    category:"Категория",fine:"Штраф",parking:"Парковка",repair:"Ремонт",otherCat:"Прочее",
    date:"Дата",type:"Тип",country:"Страна",station:"Станция",status:"Ст.",source:"Источник",
    volume:"Объём (л)",price:"Цена/л",liters:"л",
    e100Login:"Логин e100",e100Password:"Пароль e100",addCred:"Добавить",
    editCred:"Изменить",editCredTitle:"Правка доступа e100",newPassword:"Новый пароль (не обязательно)",
    newPasswordHint:"Оставьте пароль пустым, чтобы его не менять. Логин и пароль применяются со следующей синхронизации — доступ, его история и уже загруженные операции остаются прежними.",
    passwordChangedAt:"Пароль изменён",credSaved:"Логин сохранён",credSavedWithPassword:"Данные доступа сохранены, следующая синхронизация зайдёт с новым паролем",
    syncInterval:"Интервал (мин)",lookbackDays:"Период (дней)",
    telegramChatId:"Telegram Chat ID",notifyTx:"Уведомлять о транзакциях",
    notifyDaily:"Ежедневная сводка",enableTg:"Включить уведомления",
    saveSettings:"Сохранить",lastSync:"Последняя синхр.",
    syncing:"Синхронизация...",noVehicles:"Нет автомобилей",addVehicleTitle:"Новый автомобиль",
    total:"Итого",transactions:"транз.",allSources:"Все источники",
    importQ8:"Импорт Q8 CSV",importQ8Hint:"Скачай CSV из Q8 iAccount → Transaction overview → Download csv",
    importSuccess:"Импортировано",importSkipped:"пропущено",skipReasons:"Причины пропуска:",creditNotes:"кредит-ноты",cancelledPos:"аннулировано (ошибочные +)",
    importIncomeCSV:"Импорт доходов CSV",importIncomeHint:"CSV из Fakturownia (столбцы: Nabywca, Data wystawienia, Wartość brutto, Produkt/usługa, Waluta)",
    byCompany:"По компаниям",byVehicleIncome:"Доходы по авто",companyCol:"Компания",
    page:"Стр.",of:"из",
    greetingMorning:"Доброе утро",greetingDay:"Добрый день",greetingEvening:"Добрый вечер",
    periods:{today:"Сегодня",yesterday:"Вчера",last7:"Последние 7 дней",last30:"Последние 30 дней",this_month:"Текущий месяц",last_month:"Прошлый месяц",this_year:"Год",custom:"Период"},
    dpSelected:"Выбрано",dpDay:"день",dpDays2:"дня",dpDays5:"дней",dpApply:"Применить",
    dpWeekdays:["Пн","Вт","Ср","Чт","Пт","Сб","Вс"],
    dpMonths:["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"],
    allVehicles:"Все авто",allCountries:"Все страны",search:"Поиск по таблице...",
    sortLabel:"Сортировка:",sortDateNew:"По дате (Сначала новые)",sortDateOld:"По дате (Сначала старые)",
    sortAmountHigh:"По сумме (От большего)",sortAmountLow:"По сумме (От меньшего)",sortAlpha:"По алфавиту (Госномер)",
    groupMain:"ОСНОВНОЕ",groupOps:"ОПЕРАЦИОННЫЕ РАСХОДЫ",groupCapital:"КАПИТАЛ И КАДРЫ",groupConfig:"КОНФИГУРАЦИЯ",
    // ── Income page (new) ──
    incomeTitle:"Доходы и Выручка",
    totalIncomeFull:"Общий доход",
    txCountFull:"Всего транзакций",
    directIncome:"Прямые доходы (с авто)",
    unassignedIncome:"Нераспределённый доход",
    avgIncomePerVehicle:"Ср. выручка на 1 авто",
    directIncomeSub:(pct, n)=>`${pct}% от общей суммы (${n} фрахтов)`,
    unassignedIncomeSub:(n)=>`${n} транзакций без номера авто`,
    avgIncomeSub:(n, periodLbl)=>`На ${n} работавших машин · ${periodLbl}`,
    txCountSub:(avgEur)=>`Ср. фрахт: ${avgEur}`,
    incomeByCustomers:"Доходы по заказчикам",
    incomeByCustomersSub:"Доля от общего",
    topCustomersRest:(n)=>`Прочие заказчики (${n} ${n===1?"компания":n<5?"компании":"компаний"})`,
    customerTxCount:(n)=>`${n} ${n===1?"транзакция":n<5?"транзакции":"транзакций"}`,
    revenueByVehicle:"Выручка по авто (Прямая + Сплит)",
    revenueByVehicleSub:(n)=>`Сплит = нераспр. / ${n} авто`,
    colPlate:"Госномер",
    colDirectIncome:"Прямой доход",
    colSplit:"Сплит «Без авто»",
    colTotal:"Итого выручка",
    rowUnassigned:"Без авто",
    allIncomeTx:"Все транзакции доходов",
    filterAllVehicles:"🚛 Все авто",
    filterAssigned:"Только привязанные",
    filterUnassigned:"Только нераспределённые",
    filterAllCustomers:"🏢 Все заказчики",
    sortDateDesc:"📅 По дате (Сначала новые)",
    sortDateAsc:"📅 По дате (Сначала старые)",
    sortAmountDesc:"💰 По сумме (От большего)",
    sortAmountAsc:"💰 По сумме (От меньшего)",
    colStatus:"Статус привязки",
    badgeUnassigned:"⚠️ Авто не указано",
    badgeAssigned:"✓ Привязано",
    actionLink:"Привязать авто",
    actionDelete:"✕ Удалить",
    autoAllocBanner:(eur, n, perEur, periodLbl)=>`Нераспределённый доход (${eur}) равномерно распределён между ${n} авто, работавшими в ${periodLbl} (${perEur} / авто).`,
    autoAllocTitle:"Автоматическое распределение",
    // ── General expenses page ──
    generalTotalExpenses:"Итого",
    generalTotalSub:"Все общие расходы · EUR-эквивалент",
    generalOffice:"Аренда офиса",
    generalOfficeSub:"Аренда помещения + коммунальные",
    generalAccounting:"Бухгалтерия",
    generalAccountingSub:"Аутсорсинг учёта",
    generalParking:"Стоянка",
    generalParkingSub:"Аренда парковочного места",
    generalTxCount:"Кол-во транзакций",
    generalTxCountSub:"Без привязки к автотранспорту",
    generalAutoAllocTitle:"Автоматическое распределение расходов",
    generalAutoAllocBanner:(eur, n, perEur, periodLbl)=>`Нераспределённые общие расходы (${eur}) равномерно распределены между ${n} активными авто за ${periodLbl} (${perEur} / авто) и включены в «Финансы по авто» на дашборде.`,
    generalByCategory:"Распределение по категориям",
    generalCategoryOffice:"Аренда офиса",
    generalCategoryAccounting:"Бухгалтерия",
    generalCategoryParking:"Стоянка",
    generalCategoryOther:"Иные расходы",
    generalOfficeTag:"Офис",
    generalAccountingTag:"Учёт",
    generalParkingTag:"Парковка",
    generalOtherTag:"Прочее",
    generalCategoryOfficeSub:"Аренда + коммунальные услуги",
    generalCategoryAccountingSub:"Сопровождение учёта",
    generalCategoryParkingSub:"Парковочное место у офиса",
    generalCategoryOtherSub:"Канцелярия, связь, комиссии банков",
    generalAllTransactions:"Все транзакции по общим расходам",
    generalContractsTitle:"Договоры и регулярные платежи",
    generalContractsSub:"Аренда офиса, бухгалтерия, стоянка — автоматическое ежемесячное списание",
    generalAddContract:"＋ Добавить договор",
    generalAddOneOff:"＋ Добавить разовый расход",
    generalContractCategory:"Категория договора",
    generalContractDescription:"Описание / получатель",
    generalStartDate:"Действует с",
    generalEndDate:"Действует по",
    generalAnnualAmount:"Стоимость за год",
    generalMonthlyAmount:"Списание в месяц",
    generalDayOfMonth:"Число списания (1–28)",
    generalDayOfMonthHint:"Выбирайте 1–28 — самый короткий месяц 28 дней",
    generalSaveContract:"Создать договор",
    generalCancelContract:"Отменить",
    generalDeleteContract:"Удалить договор",
    generalCancelConfirm:"Отменить договор? Будущие списания прекратятся, прошлые транзакции останутся.",
    generalDeleteConfirm:"Удалить договор? Будут удалены все созданные им транзакции.",
    generalContractActive:"Активен",
    generalContractCancelled:"Отменён",
    generalContractExpired:"Истёк",
    generalContractFutureStart:"Начнётся",
    generalContractMonthlyShare:(monthly, cur)=>`${monthly.toFixed(2)} ${cur} / мес`,
    generalContractPeriodLbl:(from, to)=>`${from} — ${to}`,
    generalContractDayLbl:(day)=>`каждое ${day}-е число`,
    generalContractNoContracts:"Договоров пока нет — добавьте первый, и списания будут создаваться автоматически",
    generalSourceRecurring:"Авто",
    generalSourceManual:"Разовый",
    generalFormModeRecurring:"Договор / регулярный платёж",
    generalFormModeOneOff:"Разовый расход (Иные расходы)",
    generalCategoryOfficeDesc:"Аренда офиса",
    generalCategoryAccountingDesc:"Бухгалтерское обслуживание",
    generalCategoryParkingDesc:"Аренда стоянки возле офиса",
    generalFormAutoHint:"Программа автоматически создаст расход на выбранное число каждого месяца в течение периода действия договора. Сумма = годовая стоимость / 12.",
    // ── Leasing page ──
    leasingTotalForPeriod:"Оплата за период",
    leasingTotalSub:"Сумма всех лизинговых платежей",
    leasingVehiclesInLease:"Авто в лизинге",
    leasingVehiclesInLeaseSub:(active,total)=>`${active} из ${total} активных авто`,
    leasingRemainingObligation:"Остаток обязательств",
    leasingRemainingObligationSub:"Сумма оставшихся платежей на сегодня",
    leasingCostPerKm:"Затраты лизинга / км",
    leasingCostPerKmSub:"На основании общего пробега флота",
    leasingContractsTitle:"Договоры лизинга",
    leasingContractsSub:"Автоматическое ежемесячное списание по каждому авто",
    leasingAddContract:"＋ Добавить договор",
    leasingAddOneOff:"＋ Добавить разовый платёж",
    leasingNoContracts:"Договоров лизинга пока нет — добавьте первый",
    leasingVehicle:"Авто в лизинге",
    leasingLessor:"Лизингодатель / № договора",
    leasingStartDate:"Дата первого платежа",
    leasingTermMonths:"Срок (мес.)",
    leasingTotalAmount:"Сумма договора",
    leasingMonthlyAmount:"Ежемес. платёж",
    leasingDayOfMonth:"Число списания (1–28)",
    leasingProgressPaid:"Выплачено",
    leasingProgressRemaining:"Осталось",
    leasingMonths:"мес.",
    leasingStatusActive:"Активен",
    leasingStatusCancelled:"Отменён",
    leasingStatusExpired:"Завершён",
    leasingStatusFuture:"Начнётся",
    leasingSaveContract:"Создать договор",
    leasingCancelContract:"Отменить",
    leasingDeleteContract:"Удалить договор",
    leasingCancelConfirm:"Отменить договор? Будущие платежи прекратятся, прошлые транзакции останутся.",
    leasingDeleteConfirm:"Удалить договор? Будут удалены все созданные им транзакции.",
    leasingFormAutoHint:"Программа автоматически создаст платёж на выбранное число каждого месяца в течение срока договора. Сумма = сумма договора / срок (мес.).",
    leasingAllTransactions:"Все транзакции по лизингу",
    leasingAutoAllocBanner:(eur, n, perEur, periodLbl)=>`Лизинговые платежи (${eur}) за авто, не работавшие в ${periodLbl}, равномерно распределены между ${n} активными авто (${perEur} / авто) и включены в «Финансы по авто» на дашборде.`,
    leasingOneOffCategory:"Категория платежа",
    leasingCatPayment:"Платёж",
    leasingCatDeposit:"Залог",
    leasingFormModeRecurring:"Договор лизинга / регулярный платёж",
    leasingFormModeOneOff:"Разовый платёж (платёж или залог)",
    leasingAutoAllocTitle:"Автоматическое распределение лизинга",
    leasingVehiclesCardsTitle:"График и статус лизинга по автомобилям",
    leasingPaidTx:"платежей внесено",
    leasingRemainingMonths:(n)=>`осталось ${n} мес.`,
    leasingFirstPayment:"Первый платёж",
    leasingStartDateShort:"С",
    leasingEndDateActive:"Завершение оплаты",
    leasingEndDatePaid:"Выплачен",
    // Карточки авто «Разовые / Регулярные» (единый вид со страховкой/прицепами)
    leasingCardsTitle:"Расходы и обязательства по автомобилям",
    leasingCardsSubtitle:"Разовые платежи и действующие договоры — отдельно; внизу итог по авто за выбранный период",
    leasingNoVehicleCards:"Нет расходов по автомобилям за выбранный период",
    // ── Trailers page ──
    trailers:"Прицепы",
    trailersTotalForPeriod:"Общие расходы",
    trailersTotalSub:"Все расходы на прицепы",
    trailersRental:"Аренда прицепов",
    trailersRentalSub:"Аренда прицепов за период",
    trailersInsurance:"Страховка прицепов",
    trailersInsuranceSub:"Страховка прицепов за период",
    trailersOther:"Иные расходы",
    trailersOtherSub:"Прочие затраты по прицепам",
    trailersAutoAllocTitle:"Автоматическое распределение прицепов",
    trailersAutoAllocBanner:(eur, n, perEur, periodLbl)=>`Расходы на прицепы (${eur}) равномерно распределены между ${n} активными авто за ${periodLbl} (${perEur} / авто) и включены в «Финансы по авто» на дашборде.`,
    trailersCardsTitle:"Прицепы и затраты",
    trailersNoContracts:"Прицепов пока нет — добавьте первый",
    trailersAddContract:"＋ Добавить договор",
    trailersAddOneOff:"＋ Добавить разовый расход",
    trailersFormModeRecurring:"Договор аренды / страховки прицепа",
    trailersFormModeOneOff:"Разовый расход по прицепу",
    trailersOneOffCategory:"Категория расхода",
    trailersPlate:"Номер прицепа",
    trailersPlateHint:"Необязательно. Для общего расхода (без привязки к прицепу) — оставить пустым, сумма распределится между активными авто за период.",
    trailersContractCategory:"Тип договора",
    trailersCatRental:"Аренда",
    trailersCatInsurance:"Страховка",
    trailersCatOther:"Прочее",
    trailersCatCmr:"Страховка CMR",
    trailersCmrBtn:"+ Внести CMR",
    trailersCmrModal:"Внести страховку CMR",
    trailersCmrModalHint:"Разовый платёж за страховку груза по данному прицепу",
    trailersCmrDate:"Дата",
    trailersCmrAmount:"Сумма",
    trailersCmrDesc:"Описание",
    trailersCmrSave:"Добавить CMR",
    trailersStandingContracts:"Постоянные договоры (Автосписание)",
    trailersChargeDate:"Списание",
    trailersStartDateLbl:"Дата начала",
    trailersEndDateLbl:"Дата окончания",
    trailersRemainingLbl:"Осталось",
    trailersTotalPeriod:"Итого за период",
    trailersNoActiveContract:"Нет активного договора",
    trailersPerMonth:"/мес",
    trailersSaveContract:"Создать договор",
    trailersDeleteConfirm:"Удалить договор? Все созданные им транзакции будут удалены.",
    trailersFormAutoHint:"Программа автоматически создаст платёж на выбранное число каждого месяца в течение срока договора. Сумма = сумма договора / срок (мес.).",
    trailersAllTransactions:"Все транзакции по прицепам",
    trailersContractsTitle:"Договоры по прицепам",
    trailersContractMonths:"мес.",
    trailersTotalAmountLbl:"Общая сумма",
    trailersTabRental:"Аренда",
    trailersTabInsurance:"Страховка",
    trailersNoContractsTab:"Договоров в этой категории пока нет",
    trailersEndDate:"Окончание",
    trailersStatusActive:"Активен",
    trailersStatusCancelled:"Отменён",
    trailersStatusExpired:"Завершён",
    trailersStatusFuture:"Начнётся",
    trailersCancelContract:"Отменить",
    trailersDeleteContract:"Удалить",
    trailersCancelConfirm:"Отменить договор? Будущие платежи прекратятся.",
    trailersPaidTx:"платежей внесено",
    trailersRemainingMonths:(n)=>`осталось ${n} мес.`,
    trailersStartDateShort:"С",
    trailersEndDateActive:"Завершение оплаты",
    trailersEndDatePaid:"Выплачен",
    trailersMonths:"мес.",
    trailersMonthlyAmount:"Ежемес. платёж",
    trailersTermMonths:"Срок (мес.)",
    trailersTotalAmount:"Сумма договора",
    trailersDayOfMonth:"Число списания (1–28)",
    trailersRentalMetric:"Аренда",
    trailersInsuranceMetric:"Страховка",
    trailersOtherMetric:"Иные",
    trailersTotalMetric:"Всего",
    // ── Insurance page (refactor: polish / casco / belarus) ──
    insuranceTotalForPeriod:"Все расходы",
    insuranceTotalSub:"Все страховые выплаты",
    insurancePolish:"Польская (ОС)",
    insurancePolishSub:"Обязательная польская OC",
    insuranceCasco:"КАСКО",
    insuranceCascoSub:"Добровольное КАСКО",
    insuranceBelarus:"Белорусская",
    insuranceBelarusSub:"Страховка для поездок в РБ",
    insuranceAutoAllocTitle:"Автоматическое распределение страховки",
    insuranceAutoAllocBanner:(eur, n, perEur, periodLbl)=>`Страховые платежи (${eur}) за авто, не работавшие в ${periodLbl}, равномерно распределены между ${n} активными авто (${perEur} / авто) и включены в «Финансы по авто» на дашборде.`,
    insuranceCardsTitle:"Страховки по автомобилям",
    insuranceNoContracts:"Договоров страхования пока нет — добавьте первый",
    insuranceAddContract:"＋ Добавить договор",
    insuranceAddOneOff:"＋ Добавить разовый платёж",
    insuranceFormModeRecurring:"Договор страхования / регулярный платёж",
    insuranceFormModeOneOff:"Разовый платёж по страховке",
    insuranceVehicle:"Авто",
    insuranceContractCategory:"Тип страховки",
    insuranceSaveContract:"Создать договор",
    insuranceCancelContract:"Отменить",
    insuranceDeleteContract:"Удалить договор",
    insuranceCancelConfirm:"Отменить договор? Будущие платежи прекратятся.",
    insuranceDeleteConfirm:"Удалить договор? Все созданные им транзакции будут удалены.",
    insuranceFormAutoHint:"Программа автоматически создаст платёж на выбранное число каждого месяца в течение срока договора. Сумма = сумма договора / срок (мес.).",
    insuranceAllTransactions:"Все транзакции по страховкам",
    insuranceContractsTitle:"Договоры страхования",
    insuranceContractMonths:"мес.",
    insuranceTotalAmountLbl:"Общая сумма",
    insuranceTabPolish:"Польская",
    insuranceTabCasco:"КАСКО",
    insuranceTabBelarus:"Белорусская",
    insuranceNoContractsTab:"Договоров в этой категории пока нет",
    insuranceEndDate:"Окончание",
    insurancePaidTx:"платежей внесено",
    insuranceRemainingMonths:(n)=>`осталось ${n} мес.`,
    insuranceStartDateShort:"С",
    insuranceEndDateActive:"Завершение оплаты",
    insuranceEndDatePaid:"Выплачен",
    insuranceStatusActive:"Активен",
    insuranceStatusCancelled:"Отменён",
    insuranceStatusExpired:"Завершён",
    insuranceStatusFuture:"Начнётся",
    insuranceMonths:"мес.",
    insuranceMonthlyAmount:"Ежемес. платёж",
    insuranceTermMonths:"Срок (мес.)",
    insuranceTotalAmount:"Сумма договора",
    insuranceDayOfMonth:"Число списания (1–28)",
    insurancePolishMetric:"Польская",
    insuranceCascoMetric:"КАСКО",
    insuranceBelarusMetric:"Белорусская",
    insuranceTotalMetric:"Всего",
    insuranceActivePolicies:"Действующие полисы",
    insuranceNoActiveContract:"Нет активного договора",
    insuranceRemainingLbl:"Осталось",
    insurancePerMonth:"/мес",
    insuranceTotalPeriod:"Списано за период",
    insurancePaidThisPeriod:"Списано за период",
    // ── Other expenses page (refactor: no trailer) ──
    otherTotalForPeriod:"Итого за период",
    otherTotalSub:"Все иные расходы · EUR-эквивалент",
    otherTxCount:"Кол-во транзакций",
    otherTxCountSub:"Без привязки к авто (сервисные сборы)",
    otherFine:"Штрафы",
    otherFineSub:"Штрафы ГИБДД, платные парковки-штрафы",
    otherParking:"Парковки",
    otherParkingSub:"Платные стоянки",
    otherRepair:"Ремонты",
    otherRepairSub:"Тех. обслуживание и ремонт",
    otherOther:"Прочее",
    otherOtherSub:"Канцелярия, связь, прочее",
    otherSvcFee:"Сервисные сборы",
    otherSvcFeeSub:"Сборы e100 и подписки",
    otherByCategory:"Распределение по категориям",
    otherAutoAllocTitle:"Автоматическое распределение",
    otherAutoAllocBanner:(eur, n, perEur, periodLbl)=>`Нераспределённые расходы (${eur}) равномерно распределены между ${n} активными авто за ${periodLbl} (${perEur} / авто) и включены в «Финансы по авто» на дашборде.`,
    otherVehiclesTitle:"Аналитика по автомобилям",
    otherAllTransactions:"Все транзакции по иным расходам",
    // Карточки авто «Разовые / Регулярные» (единый вид со страховкой/прицепами)
    otherCardsTitle:"Расходы по автомобилям",
    otherCardsSubtitle:"Разовые операции и действующие регулярные платежи — отдельно; внизу общий итог за период",
    otherNoVehicleCards:"Нет расходов по автомобилям за выбранный период",
    importIncomeCsv:"📥 Импорт доходов CSV",
    addIncomeBtn:"＋ Добавить доход",
    bindVehicle:"Привязать авто",
    bindVehicleHint:"Выберите работавшее в период авто",
    unbindVehicle:"Отвязать",
    actionDeleteShort:"✕",
    deleteConfirm:"Хотите удалить?",
    deleteConfirmYes:"✓",
    deleteConfirmNo:"⊘",
    bulkDeleteTitle:"Удаление транзакций",
    bulkDeleteConfirm:(n)=>`Хотите удалить ${n} выбранных транзакций?`,
    bulkDeleteYes:"Да",
    bulkDeleteNo:"Нет",
    bulkDeleteBtn:"✕ Удалить выбранные",
    bulkSelectedCount:(n)=>`Выбрано: ${n}`,
  },
  EN:{
    _lang:"en",
    dashboard:"Dashboard",vehicles:"Vehicles",fuel:"Fuel",adblue:"AdBlue",
    mileage:"Mileage",totalMileage:"Fleet mileage",costPerKm:"Cost / km",revPerKm:"Revenue / km",costShort:"Cost",revShort:"Revenue",profitShort:"Profit",vehColPlate:"Plate",vehColKm:"Mileage",vehColExpense:"Expenses",vehColPlusMinus:"+/-",vehColAdbDt:"AdB / D",distributedGeneralIncome:"redistributed general income",
    profitPerKm:"Profit / km",marginPct:"Margin",avgPerVehicle:"Avg per vehicle",
     uploadMileageXlsx:"Upload XLSX (nav.by)",mileageCol:"Mileage, km",eurPerKmCol:"€/km",
     fuelRatioCol:"AdBlue/Diesel",mergedByVehicle:"Vehicle finances",unassignedNote:"of which redistributed",
     // ── Explanations for the abbreviations in «Vehicle finances» (the “i” dot) ──
     infoDotAria:"Explanation",
     vehColAdbDtInfo:"AdBlue-to-diesel ratio — how many litres of AdBlue are used per 100 litres of fuel (AdBlue as a share of the fuel volume). The normal range is 4–6%. Below 4% most likely means AdBlue was not refuelled, or not on this vehicle; above 6% may point to overconsumption, a data error, or AdBlue refuelled under another driver. For the figure to be trustworthy, every driver must refuel with their OWN fuel card: if cards are shared, one driver's AdBlue litres land on another driver's card and the vehicle's ratio drifts — showing a problem where there is none.",
     eurPerKmColInfo:"Cost per kilometre for this vehicle: all of its expenses for the period (including its share of shared expenses and taxes that are not tied to a vehicle) divided by the distance driven in the same period. The lower the better — the same distance cost less. Compare vehicles with each other, and one period with another.",
     perKmRowTitle:"Per 1 km driven",
     perKmIncome:"Income / km",
     perKmExpense:"Expense / km",
     perKmProfit:"Profit / km",
     perKmNoMileage:"no mileage in the period — the figure is not calculated",
    expenseStructure:"Expense structure",structureSub:"Breakdown by expense type for the period",
    geoTitle:"Expense geography",geoCountries:"Countries covered",geoCategories:"Categories",
    geoTop:"Top",lastTxTitle:"Recent transactions",lastTxSub:"Live flow of fleet operations",
    allTxBtn:"Go to all transactions",redistributions:"Redistributions",
    expenseByCategory:"Expenses by category",expenseTrend:"Expense trend",
    directByCategoryNote:"direct expenses by category, EUR",
    distributedGeneralNote:"redistributed general expenses",
    peakBucket:"Peak in",rowClickHint:"Click a row for per-vehicle detail",
    noMileageData:"No mileage data for this period",vsPrevPeriod:"vs prev. period",
    timeMoving:"Time moving",timeStopped:"Time stopped",utilization:"Utilization rate",
    avgSpeed:"Avg speed",fuelConsumed:"Fuel consumed",fuelPer100:"Fuel / 100 km",
    mileageFuelTotal:"Fuel consumption",
    sessionsCount:"Trip count",stopsCount:"Stop count",fleetOverview:"Fleet overview",
    vehicleCards:"By vehicle",mileageTable:"Daily breakdown",noSegmentData:"no movement data",
    trailer:"Trailer rental",
    mileageForPeriod:"Mileage for period",fuelAvgLabel:"Avg fuel consumption",totalStoppedDesc:"Time at parking bases",
    intervalLog:"Detailed interval log",driveLabel:"Moving",stopLabel:"Stopped",intervalCol:"Interval (from — to)",
    statusCol:"Status",vehiclesSummary:"Vehicle summary",activeVehiclesShort:"active vehicles",
    addFuelManual:"Add fill-up",fuelManualHint:"For fill-ups in Belarus or elsewhere not tracked by E100/Q8. BYN amounts are converted to EUR automatically.",
    consumptionByVehicle:"Consumption by vehicle (calculated from actual fuel bought)",
    // ── Tolls page ──
    tollTotalExpenses:"Total expenses",
    tollCostPerKm:"Cost per 1 km",
    tollMaxExpenses:"Max. expenses",
    tollTotalTx:"Total transactions",
    tollCostPerKmSub:"Total fleet mileage",
    tollVehiclesTitle:"Toll expenses by vehicle",
    tollSumMetric:"Toll sum",
    tollPerKmMetric:"Cost per 1 km",
    tollTopCountryMetric:"Top country",
    tollCountryCount:(n)=>`${n} ${n===1?"transaction":"transactions"}`,
    tollShareOf:(p)=>`${p}% of all tolls`,
    tollDynamicsByDay:"Daily expense dynamics",
    tollDynamicsByMonth:"Monthly expense dynamics",
    tollExpensesByVehicle:"Expenses by vehicle",
    tollExpensesByVehicleSub:"All vehicles with tolls",
    tollTransShort:(n)=>`${n} tx`,
    tollPrevPeriod:(v)=>`Was: ${v} km`,
    // ── Salary page ──
    salaryTotalExpenses:"Total expenses",
    salaryDrivers:"Driver salaries",
    salaryZus:"ZUS tax",
    salaryPit4:"PIT-4 tax",
    salaryPerKm:"Avg salary per 1 km",
    salaryPerKmSub:"Per mileage",
    salaryZusSub:"Not tied to a specific vehicle",
    salaryPit4Sub:"Advance income tax",
    salaryDriversSub:(n)=>`${n} ${n===1?"driver":"drivers"}`,
    salaryAllocationBanner:(zusEur,pitEur,n,perEur)=>`Company taxes: ZUS (${zusEur}) and PIT-4 (${pitEur}) are evenly distributed across ${n} active vehicles (${perEur} / vehicle) and included in "Salary + taxes" of each card.`,
    salaryAllocationTitle:"Auto tax allocation",
    salaryVehiclesTitle:"Salary and mileage by vehicle",
    salaryPaidMetric:"Salary paid",
    salaryPaidWithTaxes:"Salary + taxes",
    salaryRatePerKm:"Rate / Cost per km",
    salaryMileagePeriod:"Mileage for period",
    salaryAllTransactions:"All salary and tax transactions",
    salaryUnassignedExpensesNote:(eur,n,per)=>`-${eur} EUR of which redistributed (${n}×${per})`,
    tolls:"Tolls",other:"Other Expenses",salary:"Salary",insurance:"Insurance",leasing:"Leasing",general:"General Expenses",income:"Income",settings:"Settings",
    users:"Users",audit:"Audit Log",fxrates:"FX Rates",admin:"Administration",importCenter:"Import Center",syncE100Hist:"Load ECB history",backfillTxns:"Backfill EUR on old txns",fxLatest:"Latest rate",fxCount:"Rates count",fxEarliest:"Earliest date",fxLatestDate:"Latest date",fxAddManual:"Add rate manually",fxManualCurrency:"Currency",fxManualRate:"Rate to EUR",fxManualDate:"Rate date",fxConvert:"EUR converter",fxConvertAmount:"Amount",fxConvertCur:"Currency",fxConvertDate:"Operation date",fxConvertResult:"Result",fxNoRates:"No rates. Run sync first.",fxHistLoading:"Loading ECB historical rates (10-30 seconds)...",fxHistDone:"History loaded",fxHistBtn:"🔄 Download full history (since 1999)",fxTodayBtn:"🔄 Today's rate",fxBackfillBtn:"➕ Backfill amount_eur on old transactions",fxForceBackfillBtn:"↻ Recalculate everything",fxCurrencies:"Known currencies",fxRecentRates:"Recent rates",
    statsPeriod:"Period statistics",
    statTx:"Transactions",
    statVehiclesActive:"Active vehicles",
    vehiclesShort:"vehicles",
    exportHint:"Export report to Excel",
    fxRateMustBePositive:"Enter a rate greater than zero for",
    fxBulkApplied:"rate applied to",
    fxBulkDatesWord:"dates",
    fxRateSaved:"Rate saved",
    fxBlockedOwnerOnly:"is in the ECB archive: only the owner can override it manually.",
    importError:"Import error",
    fxConfirmHistory:"Download the ENTIRE ECB archive: ~15,000 rows (3,000 business days × 31 currencies), 10-30 seconds.\n\nUsually not needed: missing dates are fetched automatically on sync and import. Download the full archive once — on first launch, to cover earlier years.",
    fxConfirmForce:"Recalculate the EUR equivalent of ALL transactions?\n\nHistorical EUR amounts will change — do this once, after fixing a rate.",
    fxConfirmBackfill:"Go through all transactions with NULL amount_eur and fill in the EUR equivalent?",
    fxAutoTitle:"⚡ Automatic rate download",
    fxAutoSub:"ECB currencies come from the ECB; others (BYN, UAH, RSD, MDL, GEL, etc.) come from Frankfurter. Rates update automatically once a day, and on import or when payments are added any missing dates are fetched together with a recalculation. The buttons below cover both sources; non-ECB currencies are loaded for the currencies your company uses. A company manual rate always takes priority.",
    fxSourceEcb:"Sources: ECB + Frankfurter",
    fxBusyLoading:"Loading…",
    fxBusyRecalc:"Recalculating…",
    fxManualSubOwner:"For currencies missing from the ECB (e.g. BYN, UAH), or to override the official rate for a specific date.",
    fxManualSubManager:"For currencies missing from the ECB (e.g. BYN, UAH). Only the owner may override the rate of an ECB-archive currency.",
    fxAdd:"＋ Add",
    fxCurInEcbAuto:"This currency is in the ECB archive: the rate arrives automatically, and the value you enter will override it.",
    fxCurEcbOwnerOnly:"This currency is in the ECB archive: the rate is fetched automatically and only the owner can override it.",
    fxCurManualOnly:"This currency is not in the ECB archive: the rate is entered manually and applies to its own date plus 14 days forward.",
    fxManualDateHint:"A rate applies to its own date plus 14 days forward — for old transactions use THEIR date, not today's.",
    fxColCurrency:"Currency",
    fxColRate:"Rate to EUR",
    fxColDate:"Date",
    fxColSource:"Source",
    fxSearchPlaceholder:"Search…",
    fxSearchAria:"Search by currency code",
    fxSearchEmpty:"Nothing found for query",
    fxConvertSub:"Converts at the rate for the chosen date. Calculated as soon as the fields are filled — no button needed.",
    fxResultLabel:"Result",
    fxConvertIdle:"Enter an amount and a date — the result will appear here.",
    fxCalculating:"Calculating…",
    fxBulkRateForAll:"Rate for all dates:",
    fxApplyAllDates:"Apply to all dates",
    fxEnterManually:"Enter manually",
    fxOneValuePrefix:"One value will be saved for",
    fxOneValueSuffix:"dates:",
    fxRowsFor:"rows for",
    fxSyncStarted:"⏳ Loading today's rate…",
    fxForceStarted:"⏳ Recalculating all transactions…",
    fxBackfillStarted:"⏳ Recalculating transactions without an EUR equivalent…",
    fxFillAllFields:"Fill in all fields",
    fxRateNotFound:"Rate not found",
    fxServerUnreachable:"Server unavailable",
    fxHideHint:"Hide hint",
    fxPageSub:"FX rates to EUR. Source: ECB (European Central Bank). Fetched automatically once a day and on import — the buttons below are for doing it right now.",
    fxViewerNote:"You are a viewer — read-only access. Rate entry and operations are available to the owner and managers.",
    logout:"Logout",syncE100:"Sync e100",exportExcel:"Export",
    totalTx:"Transactions",activeVehicles:"Vehicles",
    totalFuel:"Fuel",totalTolls:"Tolls",totalOther:"Other Costs",
    totalAdBlue:"AdBlue",totalSalary:"Salary",totalInsurance:"Insurance",totalLeasing:"Leasing",totalGeneral:"General",totalIncome:"Income",totalAll:"Total Expenses",profit:"Profit/Loss",
    byVehicle:"By Vehicle (Expenses)",byVehicleProfit:"By Vehicle (Profit)",byCountry:"By Country",byType:"By Type",
    noVehicle:"No vehicle",
    avgPrice:"Avg Price by Country",pricePerL:"per liter",
    recentTx:"All Transactions",noData:"No data for period",
    addVehicle:"Add",plate:"Plate",driver:"Driver",description:"Description",
    actions:"Actions",edit:"Edit",save:"Save",cancel:"Cancel",
    addExpense:"Add",addSalary:"Add Salary",addInsurance:"Add Insurance",addLeasing:"Add Leasing",addGeneral:"Add Expense",addIncome:"Add Income",expenseDate:"Date",amount:"Amount",currency:"Currency",
    category:"Category",fine:"Fine",parking:"Parking",repair:"Repair",otherCat:"Other",
    date:"Date",type:"Type",country:"Country",station:"Station",status:"St.",source:"Source",
    volume:"Volume (L)",price:"Price/L",liters:"L",
    e100Login:"e100 Login",e100Password:"e100 Password",addCred:"Add",
    editCred:"Edit",editCredTitle:"Edit e100 credential",newPassword:"New password (optional)",
    newPasswordHint:"Leave the password empty to keep it unchanged. The login and password take effect from the next sync — the credential, its history and already imported transactions stay as they are.",
    passwordChangedAt:"Password changed",credSaved:"Login saved",credSavedWithPassword:"Credential saved — the next sync will log in with the new password",
    syncInterval:"Interval (min)",lookbackDays:"Lookback (days)",
    telegramChatId:"Telegram Chat ID",notifyTx:"Notify on transaction",
    notifyDaily:"Daily summary",enableTg:"Enable notifications",
    saveSettings:"Save",lastSync:"Last sync",
    syncing:"Syncing...",noVehicles:"No vehicles",addVehicleTitle:"New Vehicle",
    total:"Total",transactions:"txn",allSources:"All sources",
    importQ8:"Import Q8 CSV",importQ8Hint:"Download CSV from Q8 iAccount → Transaction overview → Download csv",
    importSuccess:"Imported",importSkipped:"skipped",skipReasons:"Skip reasons:",
    creditNotes:"credit notes",cancelledPos:"cancelled (erroneous +)",
    importIncomeCSV:"Import Income CSV",importIncomeHint:"CSV from Fakturownia (Nabywca, Data wystawienia, Wartość brutto, Produkt/usługa, Waluta)",
    byCompany:"By Company",byVehicleIncome:"Income by Vehicle",companyCol:"Company",
    page:"Page",of:"of",
    greetingMorning:"Good morning",greetingDay:"Good afternoon",greetingEvening:"Good evening",
    periods:{today:"Today",yesterday:"Yesterday",last7:"Last 7 days",last30:"Last 30 days",this_month:"This Month",last_month:"Last Month",this_year:"Year",custom:"Custom"},
    dpSelected:"Selected",dpDay:"day",dpDays2:"days",dpDays5:"days",dpApply:"Apply",
    dpWeekdays:["Mo","Tu","We","Th","Fr","Sa","Su"],
    dpMonths:["January","February","March","April","May","June","July","August","September","October","November","December"],
    allVehicles:"All Vehicles",allCountries:"All Countries",search:"Search table...",
    sortLabel:"Sort:",sortDateNew:"Date (newest first)",sortDateOld:"Date (oldest first)",
    sortAmountHigh:"Amount (high to low)",sortAmountLow:"Amount (low to high)",sortAlpha:"Alphabetical (Plate)",
    groupMain:"MAIN",groupOps:"OPERATIONAL COSTS",groupCapital:"CAPITAL & STAFF",groupConfig:"CONFIGURATION",
    // ── Income page (new) ──
    incomeTitle:"Income & Revenue",
    totalIncomeFull:"Total income",
    txCountFull:"Total transactions",
    directIncome:"Direct income (with vehicle)",
    unassignedIncome:"Unassigned income",
    avgIncomePerVehicle:"Avg revenue / vehicle",
    directIncomeSub:(pct, n)=>`${pct}% of total (${n} freights)`,
    unassignedIncomeSub:(n)=>`${n} transactions without vehicle`,
    avgIncomeSub:(n, periodLbl)=>`Across ${n} working vehicles · ${periodLbl}`,
    txCountSub:(avgEur)=>`Avg freight: ${avgEur}`,
    incomeByCustomers:"Income by customer",
    incomeByCustomersSub:"Share of total",
    topCustomersRest:(n)=>`Other customers (${n} ${n===1?"company":"companies"})`,
    customerTxCount:(n)=>`${n} ${n===1?"transaction":"transactions"}`,
    revenueByVehicle:"Revenue by vehicle (Direct + Split)",
    revenueByVehicleSub:(n)=>`Split = unassigned / ${n} vehicles`,
    colPlate:"Plate",
    colDirectIncome:"Direct income",
    colSplit:"Split «Unassigned»",
    colTotal:"Total revenue",
    rowUnassigned:"Unassigned",
    allIncomeTx:"All income transactions",
    filterAllVehicles:"🚛 All vehicles",
    filterAssigned:"Assigned only",
    filterUnassigned:"Unassigned only",
    filterAllCustomers:"🏢 All customers",
    sortDateDesc:"📅 By date (Newest first)",
    sortDateAsc:"📅 By date (Oldest first)",
    sortAmountDesc:"💰 By amount (High to low)",
    sortAmountAsc:"💰 By amount (Low to high)",
    colStatus:"Assignment",
    badgeUnassigned:"⚠️ No vehicle",
    badgeAssigned:"✓ Assigned",
    actionLink:"Link vehicle",
    actionDelete:"✕ Delete",
    autoAllocBanner:(eur, n, perEur, periodLbl)=>`Unassigned income (${eur}) was distributed evenly across ${n} vehicles active in ${periodLbl} (${perEur} / vehicle).`,
    autoAllocTitle:"Auto allocation",
    // ── General expenses page ──
    generalTotalExpenses:"Total",
    generalTotalSub:"All general expenses · EUR equivalent",
    generalOffice:"Office rent",
    generalOfficeSub:"Premises + utilities",
    generalAccounting:"Accounting",
    generalAccountingSub:"Outsourced accounting",
    generalParking:"Parking",
    generalParkingSub:"Parking spot rental",
    generalTxCount:"Transactions count",
    generalTxCountSub:"Not tied to vehicles",
    generalAutoAllocTitle:"Auto expense allocation",
    generalAutoAllocBanner:(eur, n, perEur, periodLbl)=>`Unassigned general expenses (${eur}) were evenly distributed across ${n} active vehicles for ${periodLbl} (${perEur} / vehicle) and added to the "Vehicle finances" widget on the dashboard.`,
    generalByCategory:"Breakdown by category",
    generalCategoryOffice:"Office rent",
    generalCategoryAccounting:"Accounting",
    generalCategoryParking:"Parking",
    generalCategoryOther:"Other expenses",
    generalOfficeTag:"Office",
    generalAccountingTag:"Acct.",
    generalParkingTag:"Parking",
    generalOtherTag:"Other",
    generalCategoryOfficeSub:"Rent + utilities",
    generalCategoryAccountingSub:"Bookkeeping services",
    generalCategoryParkingSub:"Parking spot at the office",
    generalCategoryOtherSub:"Stationery, telecom, bank fees",
    generalAllTransactions:"All general-expense transactions",
    generalContractsTitle:"Contracts & recurring charges",
    generalContractsSub:"Office rent, accounting, parking — auto-monthly charges",
    generalAddContract:"＋ Add contract",
    generalAddOneOff:"＋ Add one-off expense",
    generalContractCategory:"Contract category",
    generalContractDescription:"Description / payee",
    generalStartDate:"Valid from",
    generalEndDate:"Valid until",
    generalAnnualAmount:"Annual cost",
    generalMonthlyAmount:"Monthly charge",
    generalDayOfMonth:"Charge day (1–28)",
    generalDayOfMonthHint:"Pick 1–28 — shortest month has 28 days",
    generalSaveContract:"Create contract",
    generalCancelContract:"Cancel",
    generalDeleteContract:"Delete contract",
    generalCancelConfirm:"Cancel contract? Future charges will stop, past transactions stay.",
    generalDeleteConfirm:"Delete contract? All transactions it generated will be removed.",
    generalContractActive:"Active",
    generalContractCancelled:"Cancelled",
    generalContractExpired:"Expired",
    generalContractFutureStart:"Starts",
    generalContractMonthlyShare:(monthly, cur)=>`${monthly.toFixed(2)} ${cur} / mo`,
    generalContractPeriodLbl:(from, to)=>`${from} — ${to}`,
    generalContractDayLbl:(day)=>`on day ${day} of each month`,
    generalContractNoContracts:"No contracts yet — add one and monthly charges will be generated automatically",
    generalSourceRecurring:"Auto",
    generalSourceManual:"One-off",
    generalFormModeRecurring:"Contract / recurring charge",
    generalFormModeOneOff:"One-off expense (Other)",
    generalCategoryOfficeDesc:"Office rent",
    generalCategoryAccountingDesc:"Accounting services",
    generalCategoryParkingDesc:"Office parking spot rental",
    generalFormAutoHint:"The system will automatically create an expense on the chosen day of each month for the contract's validity period. Amount = annual cost / 12.",
    // ── Leasing page ──
    leasingTotalForPeriod:"Payment for period",
    leasingTotalSub:"Sum of all leasing payments",
    leasingVehiclesInLease:"Vehicles in lease",
    leasingVehiclesInLeaseSub:(active,total)=>`${active} of ${total} active vehicles`,
    leasingRemainingObligation:"Remaining obligation",
    leasingRemainingObligationSub:"Remaining payments as of today",
    leasingCostPerKm:"Leasing cost / km",
    leasingCostPerKmSub:"Based on total fleet mileage",
    leasingContractsTitle:"Leasing contracts",
    leasingContractsSub:"Auto-monthly charges per vehicle",
    leasingAddContract:"＋ Add contract",
    leasingAddOneOff:"＋ Add one-off payment",
    leasingNoContracts:"No leasing contracts yet — add the first one",
    leasingVehicle:"Vehicle in lease",
    leasingLessor:"Lessor / contract #",
    leasingStartDate:"First payment date",
    leasingTermMonths:"Term (months)",
    leasingTotalAmount:"Contract total",
    leasingMonthlyAmount:"Monthly payment",
    leasingDayOfMonth:"Charge day (1–28)",
    leasingProgressPaid:"Paid",
    leasingProgressRemaining:"Remaining",
    leasingMonths:"mo.",
    leasingStatusActive:"Active",
    leasingStatusCancelled:"Cancelled",
    leasingStatusExpired:"Completed",
    leasingStatusFuture:"Starts",
    leasingSaveContract:"Create contract",
    leasingCancelContract:"Cancel",
    leasingDeleteContract:"Delete contract",
    leasingCancelConfirm:"Cancel contract? Future charges will stop, past transactions stay.",
    leasingDeleteConfirm:"Delete contract? All transactions it generated will be removed.",
    leasingFormAutoHint:"The system will automatically create a payment on the chosen day of each month for the contract term. Amount = contract total / term (months).",
    leasingAllTransactions:"All leasing transactions",
    leasingAutoAllocBanner:(eur, n, perEur, periodLbl)=>`Leasing payments (${eur}) for vehicles that didn't work in ${periodLbl} were evenly distributed across ${n} active vehicles (${perEur} / vehicle) and added to the "Vehicle finances" widget on the dashboard.`,
    leasingOneOffCategory:"Payment category",
    leasingCatPayment:"Payment",
    leasingCatDeposit:"Deposit",
    leasingFormModeRecurring:"Leasing contract / recurring charge",
    leasingFormModeOneOff:"One-off payment (payment or deposit)",
    leasingAutoAllocTitle:"Auto leasing allocation",
    leasingVehiclesCardsTitle:"Leasing schedule & status by vehicle",
    leasingPaidTx:"payments made",
    leasingRemainingMonths:(n)=>`${n} mo. remaining`,
    leasingFirstPayment:"First payment",
    leasingStartDateShort:"From",
    leasingEndDateActive:"Ends",
    leasingEndDatePaid:"Paid off",
    // Vehicle cards: one-off / recurring switcher (same view as insurance/trailers)
    leasingCardsTitle:"Expenses & obligations by vehicle",
    leasingCardsSubtitle:"One-off payments and active contracts, separately; the period total is at the bottom",
    leasingNoVehicleCards:"No vehicle expenses in the selected period",
    // ── Trailers page ──
    trailers:"Trailers",
    trailersTotalForPeriod:"Total expenses",
    trailersTotalSub:"All trailer expenses",
    trailersRental:"Trailer rental",
    trailersRentalSub:"Trailer rental for period",
    trailersInsurance:"Trailer insurance",
    trailersInsuranceSub:"Trailer insurance for period",
    trailersOther:"Other expenses",
    trailersOtherSub:"Other trailer costs",
    trailersAutoAllocTitle:"Auto trailer allocation",
    trailersAutoAllocBanner:(eur, n, perEur, periodLbl)=>`Trailer expenses (${eur}) were evenly distributed across ${n} active vehicles for ${periodLbl} (${perEur} / vehicle) and added to the "Vehicle finances" widget on the dashboard.`,
    trailersCardsTitle:"Trailers and costs",
    trailersNoContracts:"No trailers yet — add the first one",
    trailersAddContract:"＋ Add contract",
    trailersAddOneOff:"＋ Add one-off expense",
    trailersFormModeRecurring:"Trailer rental / insurance contract",
    trailersFormModeOneOff:"One-off trailer expense",
    trailersOneOffCategory:"Expense category",
    trailersPlate:"Trailer plate",
    trailersPlateHint:"Optional. Leave empty for a fleet-wide expense — the amount will be distributed across active vehicles for the period.",
    trailersContractCategory:"Contract type",
    trailersCatRental:"Rental",
    trailersCatInsurance:"Insurance",
    trailersCatOther:"Other",
    trailersCatCmr:"CMR Insurance",
    trailersCmrBtn:"+ Add CMR",
    trailersCmrModal:"Add CMR Insurance",
    trailersCmrModalHint:"One-off payment for cargo insurance for this trailer",
    trailersCmrDate:"Date",
    trailersCmrAmount:"Amount",
    trailersCmrDesc:"Description",
    trailersCmrSave:"Add CMR",
    trailersStandingContracts:"Standing contracts (Auto-charge)",
    trailersChargeDate:"Charge",
    trailersStartDateLbl:"Start date",
    trailersEndDateLbl:"End date",
    trailersRemainingLbl:"Remaining",
    trailersTotalPeriod:"Total for period",
    trailersNoActiveContract:"No active contract",
    trailersPerMonth:"/mo",
    trailersSaveContract:"Create contract",
    trailersDeleteConfirm:"Delete contract? All transactions it generated will be removed.",
    trailersFormAutoHint:"The system will automatically create a payment on the chosen day of each month for the contract term. Amount = contract total / term (months).",
    trailersAllTransactions:"All trailer transactions",
    trailersContractsTitle:"Trailer contracts",
    trailersContractMonths:"mo.",
    trailersTotalAmountLbl:"Total amount",
    trailersTabRental:"Rental",
    trailersTabInsurance:"Insurance",
    trailersNoContractsTab:"No contracts in this category yet",
    trailersEndDate:"Ends",
    trailersStatusActive:"Active",
    trailersStatusCancelled:"Cancelled",
    trailersStatusExpired:"Completed",
    trailersStatusFuture:"Starts",
    trailersCancelContract:"Cancel",
    trailersDeleteContract:"Delete",
    trailersCancelConfirm:"Cancel contract? Future charges will stop.",
    trailersPaidTx:"payments made",
    trailersRemainingMonths:(n)=>`${n} mo. remaining`,
    trailersStartDateShort:"From",
    trailersEndDateActive:"Ends",
    trailersEndDatePaid:"Paid off",
    trailersMonths:"mo.",
    trailersMonthlyAmount:"Monthly payment",
    trailersTermMonths:"Term (months)",
    trailersTotalAmount:"Contract total",
    trailersDayOfMonth:"Charge day (1–28)",
    trailersRentalMetric:"Rental",
    trailersInsuranceMetric:"Insurance",
    trailersOtherMetric:"Other",
    trailersTotalMetric:"Total",
    // ── Insurance page (refactor: polish / casco / belarus) ──
    insuranceTotalForPeriod:"All expenses",
    insuranceTotalSub:"All insurance payments",
    insurancePolish:"Polish (OC)",
    insurancePolishSub:"Mandatory Polish OC insurance",
    insuranceCasco:"CASCO",
    insuranceCascoSub:"Voluntary hull insurance",
    insuranceBelarus:"Belarus",
    insuranceBelarusSub:"Insurance for trips to Belarus",
    insuranceAutoAllocTitle:"Auto insurance allocation",
    insuranceAutoAllocBanner:(eur, n, perEur, periodLbl)=>`Insurance payments (${eur}) for vehicles that didn't work in ${periodLbl} were evenly distributed across ${n} active vehicles (${perEur} / vehicle) and added to the "Vehicle finances" widget on the dashboard.`,
    insuranceCardsTitle:"Insurance by vehicle",
    insuranceNoContracts:"No insurance contracts yet — add the first one",
    insuranceAddContract:"＋ Add contract",
    insuranceAddOneOff:"＋ Add one-off payment",
    insuranceFormModeRecurring:"Insurance contract / recurring charge",
    insuranceFormModeOneOff:"One-off insurance payment",
    insuranceVehicle:"Vehicle",
    insuranceContractCategory:"Insurance type",
    insuranceSaveContract:"Create contract",
    insuranceCancelContract:"Cancel",
    insuranceDeleteContract:"Delete contract",
    insuranceCancelConfirm:"Cancel contract? Future charges will stop.",
    insuranceDeleteConfirm:"Delete contract? All transactions it generated will be removed.",
    insuranceFormAutoHint:"The system will automatically create a payment on the chosen day of each month for the contract term. Amount = contract total / term (months).",
    insuranceAllTransactions:"All insurance transactions",
    insuranceContractsTitle:"Insurance contracts",
    insuranceContractMonths:"mo.",
    insuranceTotalAmountLbl:"Total amount",
    insuranceTabPolish:"Polish",
    insuranceTabCasco:"CASCO",
    insuranceTabBelarus:"Belarus",
    insuranceNoContractsTab:"No contracts in this category yet",
    insuranceEndDate:"Ends",
    insurancePaidTx:"payments made",
    insuranceRemainingMonths:(n)=>`${n} mo. remaining`,
    insuranceStartDateShort:"From",
    insuranceEndDateActive:"Ends",
    insuranceEndDatePaid:"Paid off",
    insuranceStatusActive:"Active",
    insuranceStatusCancelled:"Cancelled",
    insuranceStatusExpired:"Completed",
    insuranceStatusFuture:"Starts",
    insuranceMonths:"mo.",
    insuranceMonthlyAmount:"Monthly payment",
    insuranceTermMonths:"Term (months)",
    insuranceTotalAmount:"Contract total",
    insuranceDayOfMonth:"Charge day (1–28)",
    insurancePolishMetric:"Polish",
    insuranceCascoMetric:"CASCO",
    insuranceBelarusMetric:"Belarus",
    insuranceTotalMetric:"Total",
    insuranceActivePolicies:"Active policies",
    insuranceNoActiveContract:"No active contract",
    insuranceRemainingLbl:"Remaining",
    insurancePerMonth:"/mo",
    insuranceTotalPeriod:"Written off for period",
    insurancePaidThisPeriod:"Written off for period",
    // ── Other expenses page (refactor: no trailer) ──
    otherTotalForPeriod:"Total for period",
    otherTotalSub:"All other expenses · EUR equivalent",
    otherTxCount:"Transactions count",
    otherTxCountSub:"Without vehicle (service fees)",
    otherFine:"Fines",
    otherFineSub:"Traffic fines",
    otherParking:"Parking",
    otherParkingSub:"Paid parking lots",
    otherRepair:"Repairs",
    otherRepairSub:"Maintenance and repairs",
    otherOther:"Other",
    otherOtherSub:"Stationery, telecom, misc",
    otherSvcFee:"Service fees",
    otherSvcFeeSub:"e100 fees and subscriptions",
    otherByCategory:"Breakdown by category",
    otherAutoAllocTitle:"Auto allocation",
    otherAutoAllocBanner:(eur, n, perEur, periodLbl)=>`Unassigned expenses (${eur}) were evenly distributed across ${n} active vehicles for ${periodLbl} (${perEur} / vehicle) and added to the "Vehicle finances" widget on the dashboard.`,
    otherVehiclesTitle:"Analytics by vehicle",
    otherAllTransactions:"All other-expense transactions",
    // Vehicle cards: one-off / recurring switcher (same view as insurance/trailers)
    otherCardsTitle:"Expenses by vehicle",
    otherCardsSubtitle:"One-off operations and active recurring payments, separately; the period total is at the bottom",
    otherNoVehicleCards:"No vehicle expenses in the selected period",
    importIncomeCsv:"📥 Import income CSV",
    addIncomeBtn:"＋ Add income",
    bindVehicle:"Link vehicle",
    bindVehicleHint:"Pick a vehicle active this period",
    unbindVehicle:"Unlink",
    actionDeleteShort:"✕",
    deleteConfirm:"Delete this transaction?",
    deleteConfirmYes:"✓",
    deleteConfirmNo:"⊘",
    bulkDeleteTitle:"Delete transactions",
    bulkDeleteConfirm:(n)=>`Do you want to delete ${n} selected transactions?`,
    bulkDeleteYes:"Yes",
    bulkDeleteNo:"No",
    bulkDeleteBtn:"✕ Delete selected",
    bulkSelectedCount:(n)=>`Selected: ${n}`,
  }
};


// ── UI ────────────────────────────────────────────────
// Состояние, которое переживает перезагрузку и переход между вкладками.
// Фильтры терялись при каждом переключении раздела — приходилось выставлять
// «только Q8» / машину / страну заново.


// ── Dashboard ─────────────────────────────────────────


// ── New dedicated Fuel Page ──────────────────────────


// ── Fuel/AdBlue page with country stats ──────────────


// ── Tolls page (Платные дороги) — full redesign ──────


// ── Salary page (Зарплата) — full redesign ────────────


// ── General expenses page (Office / Accounting / Parking / Other) ──────
// Layout (top → bottom):
//   1. Header: period selector + two buttons — «Добавить договор» (recurring)
//      and «Добавить разовый расход» (one-off Other).
//   2. 4 KPI cards: Итого за период (with delta badge) / Аренда офиса /
//      Бухгалтерия / Стоянка возле офиса. (Кол-во транзакций moved to the
//      table header — same pattern as FuelPage.)
//   3. Auto-allocation banner (⚙️ blue) — same as IncomePage.
//   4. Contracts panel — list of recurring contracts with status, period,
//      monthly share and Cancel / Delete actions. Plus "add contract" form.
//   5. 4 category cards: Office / Accounting / Parking / Other.
//   6. Paginated transaction table with two-step delete confirmation
//      (same UX as SalaryPage). Each row shows an «Авто»/«Разовый» badge
//      so the user can tell whether the row was auto-generated by a contract
//      or entered manually as a one-off expense.
//
// Auto-charge mechanism:
//   • When the page loads (or the period changes), the frontend calls
//     POST /api/recurring-expenses/sync — the backend
//     creates any missing monthly transactions for active contracts whose
//     day_of_month falls in the requested period (clamped to today).
//   • Idempotent: re-runs are free (external_id dedup).
//   • Tombstones: if the user deletes a single auto-generated row, a


// ── Leasing page (per-vehicle recurring + one-off payments) ──────
// Layout (top → bottom):
//   1. Header: period selector + «Добавить договор» + «Добавить разовый платёж»
//   2. 4 KPI cards: Оплата за период / Авто в лизинге / Остаток обязательств /
//      Затраты лизинга / км.
//   3. Auto-allocation banner (⚙️ blue) — for leasing payments whose vehicle
//      had no mileage in the period → redistributed across active vehicles.
//   4. Vehicle cards — one per active leasing contract, with progress bar
//      showing % paid and months remaining (as of TODAY, not period end).
//   5. Paginated transaction table with two-step delete confirmation.
//
// Sync: only POST /api/recurring-expenses/sync (single source for new contracts)


// ── Trailers page ──────


// ── Insurance page (refactor: polish / casco / belarus) ──────


// ── Other expenses page (refactor: no trailer) ──────


// ── Manual expense page (Other / Salary) ──────────────


// ── Mileage (nav.by XLSX import) ───────────────────────


// ── Vehicles ──────────────────────────────────────────


// ── Settings ──────────────────────────────────────────


// ── User management page (owner-only) ──────────────────


// ── Audit log page (all roles can read) ──────────────────
// ── Человекочитаемый журнал ──────────────────────────────────────────


// ── Administration page (container with tabs for Settings/FxRates/Audit/Users) ──


// ── Import Center (all imports in one place) ──────────────────────────


// ── FX Rates management page (owner sees everything, others can view) ──


// ── SVG Icons for Sidebar ──────────────────────────────


// ── Sidebar ───────────────────────────────────────────
// Which roles may see which page. The server enforces these rules already
// (viewers get 403 on imports/mutations); mirroring them here removes the
// "page loads, every request fails silently, screen shows zeros" experience.
// "Импорт данных" now lives as a tab inside Администрирование, so the sidebar


// ── Income (new redesigned page) ─────────────────────
// Полная переработка вкладки «Доходы» по макету Unit Economics 2.html:
//   • 5 KPI-карточек с бейджами сравнения к пред. периоду (как на Дашборде)
//   • Авто-распределение нераспределённого дохода между работавшими авто
//   • Блок «Доходы по заказчикам» (топ-3 + «Прочие»)
//   • Блок «Выручка по авто (Прямая + Сплит)» с оранжевой строкой «Без авто»
//   • Таблица «Все транзакции доходов» с фильтрами и сортировкой
//
// Работавшие авто определяются так же, как в DashboardPage:
//   union(stats.by_vehicle ∪ incomeByVehicleRaw ∪ mileageStats.by_vehicle)
// за вычетом EXCLUDED_PLATES = {TRUCK, Unknown}.
// ── ShrunkSelect: a dropdown whose closed width fits only the selected label,


// ── App Root ──────────────────────────────────────────
export default function App(){
  const [authed,setAuthed]=useState(null);  // null = checking, false = logged out, true = logged in
  // Текущий пользователь (/auth/me): нужен подвалу бокового меню, чтобы было
  // видно, под какой учётной записью идёт работа. Отдельное состояние, а не
  // запись в window: меню должно перерисоваться, когда ответ придёт, иначе
  // блок «кто вошёл» не появится до следующей перезагрузки страницы.
  const [me,setMe]=useState(null);
  const [page,setPage]=useState("dashboard");
  const [lang,setLang]=useState("RU");

  // ── Оформление ────────────────────────────────────────────────────────────
  // Режим хранится отдельно от «применённой» темы: system — это выбор
  // пользователя «как в системе», а применяется при этом светлая или тёмная.
  // Тема применяется здесь, а не в компоненте переключателя: смена переменных на
  // корне документа влияет на всё приложение, включая дочерние окна и порталы.
  const [themeMode,setThemeMode]=useState(()=>readStoredTheme());
  // Страховка на случай, если встроенный скрипт в index.html не выполнился
  // (его может запретить политика безопасности содержимого): тогда тема
  // применится при монтировании, а не останется светлой.
  useEffect(()=>{ initTheme(); },[]);
  useEffect(()=>{
    storeTheme(themeMode);
    const mq=typeof window!=="undefined"&&window.matchMedia
      ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    applyTheme(resolveTheme(themeMode, systemPrefersDark(window.matchMedia?window.matchMedia.bind(window):null)));
    // Пока выбран режим «как в системе», следим за сменой системной темы —
    // иначе интерфейс остался бы светлым при переключении системы на тёмную.
    if(themeMode!=="system"||!mq) return;
    const onChange=()=>applyTheme(resolveTheme("system", mq.matches));
    try{ mq.addEventListener("change",onChange); return()=>mq.removeEventListener("change",onChange); }
    catch(e){ mq.addListener(onChange); return()=>mq.removeListener(onChange); }
  },[themeMode]);
  const [period,setPeriod]=useState(()=>localStorage.getItem("fc_period")||"this_month");
  const [custom,setCustom]=useState(()=>{
    try{const raw=localStorage.getItem("fc_custom");if(raw)return JSON.parse(raw);}catch(e){}
    return {from:new Date().toISOString().slice(0,10),to:new Date().toISOString().slice(0,10)};
  });
  // Persist period/custom so navigation across tabs preserves the date filter
  useEffect(()=>{localStorage.setItem("fc_period",period);},[period]);
  useEffect(()=>{localStorage.setItem("fc_custom",JSON.stringify(custom));},[custom]);
  const [refreshKey,setRefreshKey]=useState(0);
  const [backendDown,setBackendDown]=useState(false);
  const [mutError,setMutError]=useState(null);
  const mutErrTimerRef=useRef(null);
  const [mobileMenuOpen,setMobileMenuOpen]=useState(false);
  const t=T[lang];
  useFonts();
  useGlobalStyles();
  const logout=async()=>{
    // Issue #5: clear the auth cookie via the backend logout endpoint,
    // then drop the in-memory CSRF token. Don't touch localStorage — the
    // JWT is no longer stored there.
    try { await apiFetch("/auth/logout",{method:"POST"}); } catch(e) {}
    window.__FLEETCOST_CSRF__ = null;
    setAuthed(false);
  };
  const changePage=(p)=>{setPage(p);setRefreshKey(k=>k+1);setMobileMenuOpen(false);};
  // Переход из вложенных компонентов (плашка «операции без курса» → «Курсы валют»).
  useEffect(()=>{
    const go=(e)=>{ if(e&&typeof e.detail==="string") changePage(e.detail); };
    window.addEventListener("fc:navigate",go);
    return ()=>window.removeEventListener("fc:navigate",go);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  // Фокус-ловушка для модальных окон: Tab не должен уводить фокус на
  // затемнённый фон, который визуально перекрыт. Один обработчик на все
  // порталы — их 7, и раньше клавиатурная навигация работала только в панели
  // деталей журнала.
  useEffect(()=>{
    const onKey=(e)=>{
      if(e.key!=="Tab") return;
      const modal=document.querySelector(".fc-modal-pop");
      if(!modal) return;
      const items=Array.from(modal.querySelectorAll("button,[href],input,select,textarea,[tabindex]:not([tabindex=\"-1\"])"))
        .filter(el=>!el.disabled && el.offsetParent!==null);
      if(!items.length) return;
      const first=items[0], last=items[items.length-1];
      if(!modal.contains(document.activeElement)){ e.preventDefault(); first.focus(); return; }
      if(e.shiftKey && document.activeElement===first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown",onKey);
    return ()=>document.removeEventListener("keydown",onKey);
  },[]);

  // Язык для fmtMoney/fmtQty/fmtInt — обновляем при каждом переключении RU/EN.
  useEffect(()=>{ setAppLang(lang); },[lang]);

  // Let apiFetch report connectivity changes and expired sessions directly.
  useEffect(()=>{
    setBackendStateHandler((down)=>setBackendDown(!!down));
    setUnauthorizedHandler(()=>{ setAuthed(false); });
    setMutationErrorHandler((info)=>{
      setMutError(info);
      // Auto-hide after 12s so it cannot pile up, but long enough to read.
      try{ clearTimeout(mutErrTimerRef.current); }catch(e){}
      mutErrTimerRef.current=setTimeout(()=>setMutError(null),12000);
    });
    return ()=>{
      setBackendStateHandler(null);
      setUnauthorizedHandler(null);
      setMutationErrorHandler(null);
      try{ clearTimeout(mutErrTimerRef.current); }catch(e){}
    };
  },[]);

  // Poll backend status (fallback for when no request is in flight)
  useEffect(()=>{
    const iv=setInterval(()=>{
      setBackendDown(isBackendDown());
      if(isBackendDown()){
        fetch("/api/health",{signal:AbortSignal.timeout(3000)}).then(r=>{
          if(r.ok){setBackendDown(false);}
        }).catch(()=>{});
      }
    },2000);
    return ()=>clearInterval(iv);
  },[]);

  // Issue #5: on app boot, check whether the auth cookie is still valid
  // by calling /auth/me. If yes, we're authed (user lands on Dashboard).
  // If 401, the cookie is gone/expired — show AuthPage. We DON'T read
  // localStorage anymore because the JWT is no longer stored there.
  //
  // IMPORTANT: use plain `fetch` here (not apiFetch) so this auth check
  // never triggers auto-reload or any side effects. This was the cause
  // of the Safari "infinite reload on auth page" bug — apiFetch was
  // reloading on 401, which re-triggered this check, which returned 401
  // again, infinitely.
  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      try{
        const res = await fetch(`${API}/auth/me`, { credentials: "include", headers: {"X-Client-ID": CLIENT_ID} });
        if(!res.ok){ if(!cancelled) setAuthed(false); return; }
        const data = await res.json();
        // Stash role on window for any UI that wants to gate actions
        window.__FLEETCOST_ROLE__ = data.role;
        // Имя и почта — для подвала бокового меню (кто сейчас в системе).
        if(!cancelled) setMe({email:data.email,full_name:data.full_name||"",role:data.role});
        // Issue #5: populate CSRF token from cookie (or fetch fresh) so
        // POST/PATCH/DELETE requests work after a page reload.
        if(!window.__FLEETCOST_CSRF__ && typeof document !== "undefined") {
          const m = document.cookie.match(/(?:^|; )fc_csrf=([^;]+)/);
          if(m) {
            try { window.__FLEETCOST_CSRF__ = decodeURIComponent(m[1]); } catch(e) {}
          }
        }
        // If we still don't have a CSRF token (e.g. cookie expired or was
        // never set), ask the backend to issue a fresh one. The endpoint
        // rotates the CSRF cookie + returns its value in JSON.
        if(!window.__FLEETCOST_CSRF__) {
          try {
            const r2 = await fetch(`${API}/auth/csrf-token`, { credentials: "include", headers: {"X-Client-ID": CLIENT_ID} });
            if(r2.ok) {
              const d2 = await r2.json();
              if(d2.csrf_token) window.__FLEETCOST_CSRF__ = d2.csrf_token;
            }
          } catch(e) {}
        }
        if(!cancelled) setAuthed(true);
      }catch(e){
        if(!cancelled) setAuthed(false);
      }
    })();
    return ()=>{cancelled=true;};
  },[]);

  // While the auth check is in-flight, render nothing (or a splash). This
  // prevents a flash of the AuthPage on every reload when the user is
  // actually still logged in via their cookie.
  if(authed===null) return null;
  if(!authed) return <AuthPage onAuth={(u)=>{
    // UX-01 (аудит stage8): раньше здесь был только setAuthed(true), и роль
    // выставлялась лишь boot-проверкой ПРИ ЗАГРУЗКЕ СТРАНИЦЫ — после логина
    // Sidebar рендерился с ролью по умолчанию ("viewer"): администратор не видел
    // своего меню до F5. AuthPage теперь подтягивает /auth/me до входа и
    // передаёт пользователя сюда — роль и имя актуальны с первого рендера.
    if(u) {
      if(u.role) window.__FLEETCOST_ROLE__ = u.role;
      setMe({email:u.email, full_name:u.full_name||"", role:u.role});
    }
    setAuthed(true);
  }}/>;

  const otherCats={fine:t.fine,parking:t.parking,repair:t.repair,trailer:t.trailer,other:t.otherCat};
  const salaryCats={monthly:lang==="RU"?"Ежемесячная":"Monthly",bonus:lang==="RU"?"Премия":"Bonus",advance:lang==="RU"?"Аванс":"Advance",zus:lang==="RU"?"ZUS (налог)":"ZUS (Tax)",pit4:lang==="RU"?"PIT-4 (налог)":"PIT-4 (Tax)"};

  const insuranceCats={vehicle:lang==="RU"?"По авто":"Per Vehicle",annual:lang==="RU"?"Годовая":"Annual",monthly:lang==="RU"?"Ежемесячная":"Monthly"};
  const generalCats={accounting:lang==="RU"?"Бухгалтерия":"Accounting",office:lang==="RU"?"Аренда офиса":"Office Rent",other:lang==="RU"?"Прочее":"Other"};
  const incomeCats={freight:lang==="RU"?"Фрахт":"Freight",bonus:lang==="RU"?"Бонус":"Bonus",other:lang==="RU"?"Прочее":"Other"};

  const activePage=(
    page==="dashboard"?<DashboardPage key="dashboard" t={t} period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} lang={lang} refreshKey={refreshKey} user={me}/>:
    page==="fuel"?<FuelPage key="fuel" t={t} lang={lang} icon="⛽" title={t.fuel} filterFn={tx=>isFuel(tx.fuel_type,tx.source,tx.plate_number)} manualCategory="fuel_manual" period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} refreshKey={refreshKey}/>:
    page==="adblue"?<FuelPage key="adblue" t={t} lang={lang} icon="🧪" title={t.adblue} filterFn={tx=>isAdBlue(tx.fuel_type)} manualCategory="adblue" period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} refreshKey={refreshKey}/>:
    page==="tolls"?<TollsPage key="tolls" t={t} lang={lang} period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} refreshKey={refreshKey}/>:
    page==="other"?<OtherPage key="other" t={t} lang={lang} period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} refreshKey={refreshKey}/>:
    page==="salary"?<SalaryPage key="salary" t={t} lang={lang} period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} refreshKey={refreshKey}/>:
    page==="insurance"?<InsurancePage key="insurance" t={t} lang={lang} period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} refreshKey={refreshKey}/>:
    page==="leasing"?<LeasingPage key="leasing" t={t} lang={lang} period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} refreshKey={refreshKey}/>:
    page==="trailers"?<TrailerPage key="trailers" t={t} lang={lang} period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} refreshKey={refreshKey}/>:
    page==="general"?<GeneralPage key="general" t={t} lang={lang} period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} refreshKey={refreshKey}/>:
    page==="income"?<IncomePage key="income" t={t} lang={lang} period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} refreshKey={refreshKey}/>:
    page==="vehicles"?<VehiclesPage key="vehicles" t={t}/>:
    page==="mileage"?<MileagePage key="mileage" t={t} lang={lang} period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom}/>:
    page==="settings"?<SettingsPage key="settings" t={t} setPage={changePage}/>:
    page==="admin"?<AdminPage key="admin" t={t} lang={lang} setPage={changePage}/>:
    page==="users"?<AdminPage key="admin-users" t={t} lang={lang} initialTab="users" setPage={changePage}/>:
    page==="audit"?<AdminPage key="admin-audit" t={t} lang={lang} initialTab="audit" setPage={changePage}/>:
    page==="fxrates"?((me&&me.role==="owner")
      ?<AdminPage key="admin-fxrates" t={t} lang={lang} initialTab="fxrates" setPage={changePage}/>
      :<FxRatesPage key="fxrates" t={t} lang={lang}/>):
    page==="importcenter"?<ImportCenterPage key="importcenter" t={t} lang={lang}/>:
    null
  );

  return(
    <div style={{display:"flex",height:"100vh",fontFamily:"'Inter Variable','Inter',system-ui,sans-serif",background:"var(--c-app)"}}>
      {backendDown&&<div style={{position:"fixed",top:0,left:0,right:0,zIndex:9999,background:"var(--c-danger-solid)",color:"var(--c-on-brand)",padding:"8px 16px",fontSize:13,fontWeight:600,textAlign:"center"}}>⚠️ Бэкенд недоступен — проверьте docker compose logs backend</div>}
      {/* Failed save/delete used to be silent. Now every rejected mutation is
          reported here, so "ничего не сохранилось" is never a mystery. */}
      {mutError&&(
        <div role="alert" style={{position:"fixed",bottom:18,left:"50%",transform:"translateX(-50%)",zIndex:10000,
                                  background:"var(--c-danger-deep)",color:"var(--c-on-brand)",padding:"10px 14px",borderRadius:10,
                                  fontSize:13,maxWidth:620,boxShadow:"0 10px 30px rgba(0,0,0,0.25)",
                                  display:"flex",alignItems:"flex-start",gap:12}}>
          <span style={{flex:1}}>
            <b>{lang==="RU"?"Изменения не сохранены":"Changes were not saved"}</b>
            <span style={{display:"block",opacity:0.9,marginTop:2}}>{String(mutError.detail).slice(0,300)}</span>
            <span style={{display:"block",opacity:0.6,marginTop:2,fontSize:12,fontFamily:MONO}}>
              {mutError.method||"POST"} {String(mutError.path).split("?")[0]} → HTTP {mutError.status}
            </span>
          </span>
          <button onClick={()=>setMutError(null)} aria-label="Закрыть"
                  style={{background:"transparent",border:"none",color:"var(--c-on-brand)",fontSize:16,cursor:"pointer",lineHeight:1}}>✕</button>
        </div>
      )}
      <div className={"fc-overlay"+(mobileMenuOpen?" fc-open":"")} onClick={()=>setMobileMenuOpen(false)}/>
      <Sidebar page={page} setPage={changePage} t={t} lang={lang} setLang={setLang} onLogout={logout} mobileOpen={mobileMenuOpen} themeMode={themeMode} setThemeMode={setThemeMode} user={me}/>
      <div style={{flex:1,overflow:"auto",display:"flex",flexDirection:"column"}}>
        <div className="fc-mobile-topbar" style={{background:"var(--c-surface)",padding:"10px 14px",borderBottom:"1px solid var(--c-border-3)",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:120}}>
          <button onClick={()=>setMobileMenuOpen(o=>!o)} style={{background:"var(--c-surface)",border:"1px solid var(--c-border)",borderRadius:8,padding:"6px 12px",fontSize:14,fontWeight:600,cursor:"pointer"}}>☰ Меню</button>
          <span style={{fontWeight:800,fontSize:15,color:"var(--c-brand)"}}>FleetCost</span>
        </div>
        <div style={{paddingTop:backendDown?40:0}}>{activePage}</div>
      </div>
    </div>
  );
}


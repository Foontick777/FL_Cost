/** Общие константы UI: цвета источников данных, флаги стран, размер страницы.
 *  Вынесено из App.jsx. */
export const SRC={e100:{bg:"var(--c-info-bg)",fg:"var(--c-info-2)",label:"E100"},q8:{bg:"var(--c-warn-bg)",fg:"var(--c-warn-strong)",label:"Q8"},manual:{bg:"var(--c-violet-bg)",fg:"var(--c-violet-700)",label:"Manual"},csv_income:{bg:"var(--c-success-bg-2)",fg:"var(--c-success-dark)",label:"CSV"}};
export const FLAGS={PL:"🇵🇱",DE:"🇩🇪",BE:"🇧🇪",FR:"🇫🇷",NL:"🇳🇱",CZ:"🇨🇿",AT:"🇦🇹",HU:"🇭🇺",SK:"🇸🇰",LU:"🇱🇺",CH:"🇨🇭",IT:"🇮🇹",ES:"🇪🇸",GB:"🇬🇧",BY:"🇧🇾",LT:"🇱🇹",LV:"🇱🇻",EE:"🇪🇪",UA:"🇺🇦"};
export const PAGE_SIZE=50;

// Default description for a recurring contract — used when the user leaves
// the description field blank. Localised per category.
export function defaultContractDescription(category, lang){
  if(lang==="RU"){
    return category==="office"?"Аренда офиса":category==="accounting"?"Бухгалтерское обслуживание":category==="parking"?"Аренда стоянки возле офиса":"Договор";
  }
  return category==="office"?"Office rent":category==="accounting"?"Accounting services":category==="parking"?"Office parking spot rental":"Contract";
}
// «Было/стало» печаталось сырым JSON: {"amount":"120.00","is_confirmed":false}
// — для бухгалтера это нечитаемо, и невозможно увидеть, ЧТО именно изменилось.
export const ENTITY_RU={Company:"Компания",User:"Пользователь",Vehicle:"Автомобиль",Mileage:"Пробег",
  MileageSegment:"Сегмент пробега",Transaction:"Транзакция",E100Credential:"Доступ e100",
  TelegramSettings:"Telegram",ScraperSettings:"Синхронизация",FxRate:"Курс валют",
  ImportHistory:"Импорт",AuditLog:"Журнал",RecurringContract:"Договор (зарплата)",
  LeasingContract:"Лизинговый договор",TrailerContract:"Договор прицепа",InsuranceContract:"Договор страховки",
  // Динамические категории расходов и универсальные регулярные расходы
  ExpenseCategory:"Категория расхода",RecurringExpense:"Регулярный расход"};
export const FIELD_RU={amount:"Сумма",amount_eur:"Сумма в EUR",currency:"Валюта",fx_rate:"Курс",price:"Цена",
  volume:"Объём",transaction_date:"Дата операции",plate_number:"Номер авто",driver_name:"Водитель",
  fuel_type:"Тип топлива",country:"Страна",station_address:"Адрес АЗС",station_region:"Регион",
  is_confirmed:"Подтверждено",status:"Статус",source:"Источник",category:"Категория",email:"E-mail",
  role:"Роль",is_active:"Активен",km:"Пробег, км",liters:"Литры",monthly_amount:"Платёж в месяц",
  annual_amount:"Сумма в год",total_amount:"Общая сумма",day_of_month:"День месяца",start_date:"Начало",
  end_date:"Окончание",rate_to_eur:"Курс к EUR",rate_date:"Дата курса",filename:"Файл",total_rows:"Строк",
  new_rows:"Новых",updated_rows:"Обновлено",skipped_rows:"Пропущено",failed_rows:"Ошибок",
  imported:"Импортировано",updated:"Обновлено",skipped:"Пропущено",purged:"Удалено (очистка)",
  purged_period:"Удалённый период",reason:"Причина",chat_id:"Chat ID",username:"Логин e100",
  credential_id:"Доступ",external_id:"Внешний ID",is_verified:"Проверено",note:"Примечание",
  purged_count:"Удалено",file_date_from:"Дата в файле (от)",file_date_to:"Дата в файле (до)",
  hashed_password:"Пароль",encrypted_password:"Пароль",source_account:"Аккаунт источника",
  password:"Пароль e100",password_changed:"Пароль изменён",password_changed_at:"Дата смены пароля",
  last_sync_status:"Результат синхр.",last_sync_at:"Время синхр.",
  // Динамические категории / регулярные расходы
  section:"Раздел",code:"Код",name:"Название",icon:"Иконка",color:"Цвет",object_scope:"Область применения",
  is_system:"Системная",is_active:"Активна",sort_order:"Порядок",usage_count:"Операций",
  expense_type:"Тип расхода",periodicity:"Периодичность",frequency:"Периодичность",comment:"Комментарий",
  document_ref:"Документ",category_id:"Категория",trailer_plate:"Номер прицепа",insurer:"Страховая",
  policy_number:"Номер полиса",next_run_at:"Следующее списание",last_run_at:"Последнее списание",
  period_key:"Период",generated_charges:"Создано списаний"};
export const entityRu=(k)=>ENTITY_RU[k]||k||"—";
export const fieldRu=(k)=>FIELD_RU[k]||k;

export const SEG_PAGE_SIZE=50;

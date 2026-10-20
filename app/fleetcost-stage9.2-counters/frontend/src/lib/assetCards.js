/**
 * Данные карточек авто/прицепов с разделением «Разовые / Регулярные».
 *
 * Чистая функция (без сети и React) — её значения проверяет `npm run check:logic`.
 *
 * Что считается:
 *   • «Разовые» — операции периода, не созданные регулярным платежом
 *     (source !== "recurring"), по категориям;
 *   • «Регулярные» — действующие договоры объекта (идущие и приостановленные:
 *     пауза не завершение) и, отдельно, сумма и ЧИСЛО их списаний ЗА ПЕРИОД;
 *   • итог карточки — ВСЕ расходы объекта за период (разовые + списания по
 *     регулярным). Он не зависит от выбранной вкладки: человек переключает вид,
 *     а не меняет сумму.
 *
 * Каунтеры на вкладках (oneOffCount / regularCount) — это ЧИСЛО ТРАНЗАКЦИЙ
 * периода, а не сумма: сумма на кнопке «поехала» бы при больших числах
 * (по вёрстке пользователя). Точные суммы — в списке и в подвале карточки.
 */

/** Номер объекта договора: прицеп хранится и в trailer_plate, и в plate_number. */
export function contractPlate(p) {
  return (p && (p.trailer_plate || p.plate_number)) || null;
}

const eurOf = (tx) => {
  const n = Number(tx && tx.amount_eur);
  return Number.isFinite(n) ? n : 0;
};

/**
 * @param {object} args
 * @param {Array}  args.txns       операции периода (уже отфильтрованные по разделу)
 * @param {Array}  args.contracts  регулярные платежи раздела (ответ /recurring-expenses)
 * @param {(tx)=>{key:string,name:string,icon?:string,color?:string}} args.bucketOf
 * @param {string[]} [args.extraPlates] номера, для которых карточка нужна всегда
 * @returns {Array<{plate, oneOff:Array, oneOffEur:number, regular:Array,
 *                  regularEur:number, totalEur:number}>}
 */
export function buildAssetCards({ txns = [], contracts = [], bucketOf, extraPlates = [] }) {
  const cards = new Map();
  const card = (plate) => {
    if (!cards.has(plate)) {
      cards.set(plate, { plate, oneOffMap: new Map(), oneOffEur: 0, oneOffCount: 0,
                         regular: [], regularEur: 0, regularCount: 0,
                         totalEur: 0, missingEur: 0 });
    }
    return cards.get(plate);
  };

  for (const tx of txns) {
    const plate = tx.plate_number;
    if (!plate || plate === "—") continue;
    const c = card(plate);
    const eur = eurOf(tx);
    c.totalEur += eur;
    // Строки без курса (amount_eur = null) в EUR-итоги не входят и дают 0:
    // без пометки внутри карточки итог выглядел «0,00 EUR» при реальных
    // расходах — предупреждение было только баннером на странице
    // (дефект аудита stage9.1).
    if (tx.amount_eur == null && Number(tx.amount || 0) !== 0) c.missingEur += 1;
    if (tx.source === "recurring") {
      c.regularEur += eur;
      c.regularCount += 1;
      if (tx.recurring_expense_id != null) {
        c.chargesByContract = c.chargesByContract || new Map();
        c.chargesByContract.set(tx.recurring_expense_id,
          (c.chargesByContract.get(tx.recurring_expense_id) || 0) + eur);
      }
    } else {
      const b = bucketOf(tx);
      const row = c.oneOffMap.get(b.key) || { key: b.key, name: b.name, icon: b.icon, color: b.color, eur: 0, count: 0 };
      row.eur += eur;
      row.count += 1;
      c.oneOffMap.set(b.key, row);
      c.oneOffEur += eur;
      c.oneOffCount += 1;
    }
  }

  for (const p of contracts) {
    // Только идущие и приостановленные: завершённые и будущие в «текущих
    // обязательствах» объекта не нужны (они видны в общем блоке договоров).
    if (p.display_status !== "active" && p.display_status !== "paused") continue;
    const plate = contractPlate(p);
    if (!plate) continue;
    card(plate).regular.push(p);
  }
  for (const plate of extraPlates) if (plate) card(plate);

  return Array.from(cards.values())
    .map((c) => ({
      plate: c.plate,
      oneOff: Array.from(c.oneOffMap.values()).sort((a, b) => b.eur - a.eur),
      oneOffEur: c.oneOffEur,
      oneOffCount: c.oneOffCount,
      missingEur: c.missingEur,
      regular: c.regular.map((p) => ({
        ...p,
        periodEur: c.chargesByContract ? (c.chargesByContract.get(p.id) || 0) : 0,
      })).sort((a, b) => String(a.end_date || "9999").localeCompare(String(b.end_date || "9999"))),
      regularEur: c.regularEur,
      regularCount: c.regularCount,
      totalEur: c.totalEur,
    }))
    .sort((a, b) => a.plate.localeCompare(b.plate));
}

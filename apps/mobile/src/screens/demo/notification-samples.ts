/**
 * Sample bank and wallet push texts for the demo panel's notification simulator (spec §15).
 * Data only: the UI shows `labelKey` through i18n and sends `text` as `rawText` (source NOTIF_SIM).
 */
export interface NotificationSample {
  id: string;
  /** Fully qualified i18n key for the picker label, e.g. "demo:sample.kzBankRu". */
  labelKey: string;
  text: string;
}

export const NOTIFICATION_SAMPLES: readonly NotificationSample[] = [
  {
    id: "kz-bank-ru",
    labelKey: "demo:sample.kzBankRu",
    text: "Покупка 4 590,00 KZT. MAGNUM CASH&CARRY ALMATY. Карта *1234. Доступно: 312 410,55 KZT",
  },
  {
    id: "kz-bank-kk",
    labelKey: "demo:sample.kzBankKk",
    text: "Сатып алу 4 590,00 KZT. MAGNUM CASH&CARRY ALMATY. Карта *1234. Қолжетімді: 312 410,55 KZT",
  },
  {
    id: "alipay-cn",
    labelKey: "demo:sample.alipayCn",
    text: "支付宝：您在 星巴克(南京西路店) 消费 CNY 38.50，余额 CNY 1204.20。",
  },
  {
    id: "wechat-cn",
    labelKey: "demo:sample.wechatCn",
    text: "微信支付：您已向 滴滴出行 付款 ¥26.00，零钱余额 ¥512.30。",
  },
  {
    id: "revolut-en",
    labelKey: "demo:sample.revolutEn",
    text: "You spent HUF 3,450.00 at SPAR Budapest. Balance: HUF 128,400.00.",
  },
];

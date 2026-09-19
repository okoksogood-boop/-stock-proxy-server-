// ============================================================
// 台股即時分析 - 代理伺服器(Proxy Server)
// 作用:幫手機App向 Yahoo Finance / 證交所拿資料,
//      解決瀏覽器CORS安全限制無法直接抓取的問題
// ============================================================

const express = require('express');
const cors = require('cors');
const iconv = require('iconv-lite');

const app = express();
app.use(cors()); // 允許任何來源呼叫這台代理伺服器(給手機App用)
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 判斷現在是否為台股交易時段(週一~週五 09:00-13:30,以台北時區為準,跟前端index.html的
// isTradingWindow()同一套邏輯,伺服器端另外實作一份是因為Node.js跟瀏覽器JS環境分開,
// 不能直接共用同一份函式定義)。原本isLiveSession只靠「現價時間戳記跟K線陣列最後一筆
// 時間差是否超過12小時」這個間接推論判斷,但半夜、假日這類收盤已久的時段,Yahoo回傳的
// 兩筆歷史資料時間差本來就常常超過12小時(可能剛好跨了假日或資料更新有delay),不代表
// 現在真的在盤中,導致半夜查詢也被誤判成「盤中即時報價」。加上這層真正的時間檢查當作
// 額外的AND條件,兩個條件都成立才真的算盤中
function isTaiwanTradingHours() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday').value;
  const hh = +parts.find((p) => p.type === 'hour').value;
  const mm = +parts.find((p) => p.type === 'minute').value;
  const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday);
  const minutes = hh * 60 + mm;
  const isTradingTime = minutes >= 9 * 60 && minutes <= 13 * 60 + 30;
  return isWeekday && isTradingTime;
}

// 把unix時間戳記轉成台北時區的日期字串(YYYY-MM-DD),用來直接比對「這筆資料到底是哪一天的」,
// 比「兩筆資料時間差是否超過12小時」這種間接推論更可靠(詳見架構理念文件技術教訓第66條)
function toTaipeiDateStr(unixSeconds) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(unixSeconds * 1000));
}

// 判斷「今天台北時間是否已經過了開盤時間(09:00)」,用來分辨:K線陣列最後一筆不是今天,
// 到底是「今天根本還沒開盤」這種正常情況(不用提醒),還是「已經開盤甚至收盤了,但Yahoo
// 陣列還沒補上今天資料」的異常情況(這正是2426那次收盤後查詢卻拿到前一日數值的根本原因,
// 需要額外提醒使用者)
function hasTaiwanMarketOpenedToday() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday').value;
  const hh = +parts.find((p) => p.type === 'hour').value;
  const mm = +parts.find((p) => p.type === 'minute').value;
  const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday);
  return isWeekday && (hh * 60 + mm) >= 9 * 60;
}

// STOCK_DAY_ALL 10分鐘記憶體快取(給個股查詢的官方收盤價交叉比對用,避免每查一檔股票就
// 重新抓一次全市場快照;這份資料不管什麼時間點查都應該要有,不像即時報價系統那樣收盤已久
// 常常撲空,詳見架構理念文件技術教訓第67、74條)
let stockDayAllCache = { data: null, fetchedAt: 0 };
const STOCK_DAY_ALL_CACHE_MS = 10 * 60 * 1000;
async function getStockDayAllCached() {
  const now = Date.now();
  if (stockDayAllCache.data && (now - stockDayAllCache.fetchedAt) < STOCK_DAY_ALL_CACHE_MS) {
    return stockDayAllCache.data;
  }
  const response = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');
  const json = await response.json();
  stockDayAllCache = { data: json, fetchedAt: now };
  return json;
}

// ---------- 搜尋記錄(存在記憶體中,伺服器重啟/休眠喚醒會清空,免費方案無永久硬碟) ----------
const searchLogs = [];
const MAX_LOGS = 500;
const ADMIN_USER = '1111';
const ADMIN_PASS = '5168';

// ---------- 健康檢查(確認伺服器有正常運作) ----------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: '台股代理伺服器運作中' });
});

// ---------- 直接提供網頁本身(打開這個伺服器的網址就能看到App,不用再下載檔案) ----------
app.use(express.static('public'));

// ---------- 記錄一筆搜尋(前端每次查詢股票時呼叫) ----------
app.post('/api/log-search', (req, res) => {
  const { code, isGuest } = req.body || {};
  if (!code) return res.status(400).json({ error: '缺少code' });
  searchLogs.unshift({
    time: new Date().toISOString(),
    code: String(code).slice(0, 20),
    type: isGuest ? '訪客' : '會員',
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '未知',
  });
  if (searchLogs.length > MAX_LOGS) searchLogs.length = MAX_LOGS;
  res.json({ ok: true });
});

// ---------- 查看搜尋記錄(僅限登入者使用,需帶帳號密碼驗證) ----------
app.get('/api/admin/logs', (req, res) => {
  const { user, pass } = req.query;
  if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }
  res.json({ logs: searchLogs, note: '記錄存於伺服器記憶體,重啟或休眠喚醒後會清空' });
});

// ---------- 個股即時股價資料(轉發 Yahoo Finance) ----------
// 用法: GET /api/stock/2330  (自動嘗試上市.TW / 上櫃.TWO)
app.get('/api/stock/:code', async (req, res) => {
  const code = req.params.code.trim();
  // 大盤加權指數為特殊代碼,直接用^TWII查詢,不加.TW/.TWO後綴(這兩個後綴只適用一般個股);
  // 新增相對強弱RS指標時需要抓大盤同期收盤價當基準,所以這裡要能正確處理TWII
  const suffixes = code.toUpperCase() === 'TWII' ? [''] : ['.TW', '.TWO'];
  const symbolBase = code.toUpperCase() === 'TWII' ? '^TWII' : code;
  let bestPartial = null;

  for (const suf of suffixes) {
    try {
      const cacheBuster = Date.now();
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbolBase}${suf}?range=6mo&interval=1d&_=${cacheBuster}`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' },
      });
      if (!response.ok) continue;
      const json = await response.json();
      const result = json?.chart?.result?.[0];
      if (!result) continue;

      const quote = result.indicators.quote[0];
      const adjCloseArr = result.indicators.adjclose?.[0]?.adjclose || null; // 還原股價(反映除權息調整),Yahoo預設會提供
      const validIdx = quote.close
        .map((v, i) => (v != null ? i : -1))
        .filter((i) => i >= 0);
      if (validIdx.length === 0) continue;

      // 判斷這筆資料是不是「已經跟上今天」:直接比對K線陣列最後一筆的日期(台北時區)是否
      // 等於今天,比「兩筆資料時間差是否超過12小時」這種間接推論更可靠(技術教訓第66條)。
      const timestamps = validIdx.map((i) => result.timestamp[i]);
      const closesArr = validIdx.map((i) => quote.close[i]);
      const meta = result.meta;
      const lastArrayTime = timestamps[timestamps.length - 1];
      const todayStr = toTaipeiDateStr(Date.now() / 1000);
      const lastBarDateStr = toTaipeiDateStr(lastArrayTime);
      const isArrayUpToDate = lastBarDateStr === todayStr;
      const marketOpenedToday = hasTaiwanMarketOpenedToday();

      let isLiveSession = false; // 現在還在09:00-13:30盤中,顯示的是還在跳動的即時價
      let isPendingTodayUpdate = false; // 今天已經開盤甚至收盤,但Yahoo K線陣列還沒補上今天資料
      if (!isArrayUpToDate && marketOpenedToday && meta?.regularMarketPrice != null && meta?.regularMarketTime) {
        const metaDateStr = toTaipeiDateStr(meta.regularMarketTime);
        if (metaDateStr === todayStr) {
          // meta(即時報價)已經是今天的資料,陣列還沒跟上——不能直接把陣列最後一筆
          // (其實是前一交易日收盤價)當成今天的價格顯示,這正是2426那次「收盤後查詢卻拿到
          // 前一日數值」的根本原因。改用meta的即時價當作目前最準確的「今天」價格,並依現在
          // 是否還在09:00-13:30內,分別標示成「盤中即時報價」或「今日已收盤但資料來源更新中」
          if (isTaiwanTradingHours()) {
            isLiveSession = true;
          } else {
            isPendingTodayUpdate = true;
          }
        }
      }
      const usingMetaPrice = isLiveSession || isPendingTodayUpdate;
      // 第三種情況:今天已開盤,陣列沒跟上,但連meta的即時報價來源都還沒有今天的資料
      // (例如剛開盤瞬間、或Yahoo這檔股票的即時報價來源本身也delay),此時完全沒有今天的
      // 任何資料可用,不能假裝有——明確標示「尚無今日資料」,而不是靜默顯示前一日數值
      const noTodayDataYet = marketOpenedToday && !isArrayUpToDate && !usingMetaPrice;

      const payload = {
        code,
        market: suf === '.TW' ? '上市' : '上櫃',
        name: result.meta?.longName || result.meta?.shortName || code,
        opens: validIdx.map((i) => quote.open[i]),
        closes: closesArr,
        highs: validIdx.map((i) => quote.high[i]),
        lows: validIdx.map((i) => quote.low[i]),
        volumes: validIdx.map((i) => quote.volume[i]),
        adjCloses: adjCloseArr ? validIdx.map((i) => adjCloseArr[i]) : null, // 供前端計算技術指標用,避免除權息造成假訊號
        timestamps,
        insufficientData: validIdx.length < 20,
        dataPoints: validIdx.length,
        liveQuote: usingMetaPrice ? meta.regularMarketPrice : null, // 盤中即時或今日資料剛更新時,額外提供這個欄位,前端可選擇用來顯示「現價」
        isLiveSession,
        isPendingTodayUpdate, // 🆕今天已開盤/收盤但Yahoo陣列還沒更新,前端要提醒使用者這筆是剛更新、尚未定案的資料
        noTodayDataYet, // 🆕今天已開盤但連即時報價來源都還沒有今天資料,前端要明確提醒這是前一交易日資料
        dataAsOfDate: usingMetaPrice ? todayStr : lastBarDateStr, // 🆕目前顯示的價格實際對應哪一個交易日,供前端誠實標示
      };

      // ---- 跟證交所官方每日收盤總表(STOCK_DAY_ALL)交叉比對,偵測Yahoo資料異常 ----
      // 原本用mis.twse.com.tw即時報價系統比對,但那套系統是設計給盤中查詢用的,收盤已久的
      // 時段常常查不到有效資料,導致這層防護悄悄地什麼都沒抓到就跳過、完全沒發揮作用
      // (架構理念文件技術教訓第67、74條已經記錄過同一個問題,主報表PowerShell版也已經改用
      // 這個資料源)。改用STOCK_DAY_ALL並加上10分鐘快取,落差門檻同步成跟主報表一致的1%
      // (主報表用Get-TWSEMarketSnapshot比對時是>1%就提醒,原本網頁版這裡誤用5%,已統一)。
      // STOCK_DAY_ALL目前只涵蓋上市股票,上櫃(.TWO)暫時沒有這層防護,跟主報表的既有限制一致。
      try {
        if (suf === '.TW') {
          const dayAll = await getStockDayAllCached();
          const dayAllItem = Array.isArray(dayAll) ? dayAll.find((it) => it.Code === code) : null;
          const officialClose = dayAllItem?.ClosingPrice != null ? parseFloat(dayAllItem.ClosingPrice) : null;
          const yahooPrice = payload.liveQuote != null ? payload.liveQuote : closesArr[closesArr.length - 1];
          if (officialClose != null && !isNaN(officialClose) && officialClose > 0 && yahooPrice != null) {
            const gapPct = Math.abs(yahooPrice - officialClose) / officialClose * 100;
            if (gapPct > 1) {
              payload.priceDiscrepancy = {
                yahooPrice,
                twsePrice: officialClose,
                gapPct: Math.round(gapPct * 100) / 100,
              };
            }
          }
        }
      } catch (e) {
        // 交叉比對失敗不影響主要查詢結果,靜默略過即可,不用讓整個查詢因此失敗
      }

      if (validIdx.length >= 20) return res.json(payload); // 資料足夠,直接回傳
      if (!bestPartial) bestPartial = payload; // 資料不足20筆,先記住,繼續嘗試另一個後綴看是否有更完整的
    } catch (e) {
      continue;
    }
  }
  // 兩種後綴都試過:若有查到但資料不足(通常是新上市股票),仍回傳讓前端顯示說明,而非直接判定查無資料
  if (bestPartial) return res.json(bestPartial);
  return res.status(404).json({ error: `查無「${code}」的資料,請確認代號是否正確` });
});

// ---------- 全市場快照(轉發證交所 STOCK_DAY_ALL,含中文股票名稱、可用於熱門股篩選等進階功能) ----------
app.get('/api/twse/snapshot', async (req, res) => {
  try {
    const url = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
    const response = await fetch(url);
    const json = await response.json();
    return res.json(json);
  } catch (e) {
    return res.status(500).json({ error: '取得全市場快照失敗' });
  }
});

// ---------- 上櫃股票名稱備援查詢(上市快照查不到時使用,自動偵測UTF8/Big5編碼) ----------
// 用法: GET /api/otc-name/6213
app.get('/api/otc-name/:code', async (req, res) => {
  const code = req.params.code.trim();
  try {
    const url = `http://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=otc_${code}.tw`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const buffer = Buffer.from(await response.arrayBuffer());
    let text;
    try {
      text = buffer.toString('utf8');
      if (text.includes('\uFFFD')) throw new Error('not utf8');
    } catch (e) {
      text = iconv.decode(buffer, 'big5');
    }
    const json = JSON.parse(text);
    const item = json?.msgArray?.[0];
    const name = item?.nf || item?.n || null;
    return res.json({ code, name });
  } catch (e) {
    return res.json({ code, name: null });
  }
});

// ---------- 個股重大訊息公告(官方公開資訊觀測站合法公開揭露,非內線消息) ----------
// Groq金鑰只從Render後台的Environment變數讀取,程式碼裡完全不寫死金鑰。
// 原因:這個repo是Public,金鑰若寫在程式碼裡等於公開曝光,會被GitGuardian等掃描工具偵測到並被Groq自動撤銷。
// 之後要換金鑰,只需要去Render後台Environment分頁改GROQ_API_KEY這個變數、儲存即可自動重新部署。
const GROQ_API_KEY = process.env.GROQ_API_KEY || null;
if (!GROQ_API_KEY) {
  console.warn('⚠️ 尚未設定 GROQ_API_KEY 環境變數,AI相關功能(問AI、AI分析)將無法使用,請至Render後台Environment分頁設定。');
}

// 判斷Groq API回應是否為「金鑰失效/無效」這類錯誤,以便顯示對使用者友善的提醒,而不是原始除錯JSON
function isInvalidKeyResponse(json) {
  return json?.error?.code === 'invalid_api_key' || (typeof json?.error?.message === 'string' && /invalid api key/i.test(json.error.message));
}

// ---------- 互動問答:根據已查詢到的股票資料回答使用者問題 ----------
app.post('/api/ask', async (req, res) => {
  const { question, context } = req.body || {};
  if (!question || !context) return res.status(400).json({ error: '缺少必要參數' });
  if (!GROQ_API_KEY) {
    return res.json({ answer: '⚠️ AI功能尚未設定金鑰,請至 Render 後台的 Environment 設定 GROQ_API_KEY(申請新金鑰:https://console.groq.com/keys)' });
  }
  try {
    const prompt = `你是一位台股分析助手。以下是某檔股票目前的數據資料:\n\n${context}\n\n使用者問題:${question}\n\n請根據以上資料回答,語氣像專業分析師一樣客觀中立,回答控制在150字以內。如果資料不足以回答,請誠實說明資料不足。請勿給出「保證上漲」「一定要買」「現在就賣」這類武斷確定性的投資建議,可以提供技術面/基本面/籌碼面的客觀解讀,並在回答最後提醒最終決策需自行判斷、非投資建議。`;
    const url = 'https://api.groq.com/openai/v1/chat/completions';
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const json = await r.json();
    const answer = json?.choices?.[0]?.message?.content;
    if (!answer) {
      // 拿不到預期格式的回答時,把實際回傳的內容原封不動附上,方便排查問題(除錯用,之後穩定運作後可移除)
      console.error('Groq /api/ask 回應異常:', JSON.stringify(json));
      if (isInvalidKeyResponse(json)) {
        return res.json({ answer: '⚠️ AI金鑰已失效,請前往 Render 後台的 Environment 設定更新 GROQ_API_KEY(申請新金鑰:https://console.groq.com/keys)' });
      }
      return res.json({ answer: `無法取得回答(除錯資訊,HTTP狀態:${r.status}):${JSON.stringify(json).slice(0, 500)}` });
    }
    return res.json({ answer });
  } catch (e) {
    console.error('Groq /api/ask 例外錯誤:', e);
    return res.status(500).json({ error: `AI回答失敗:${e.message}` });
  }
});

// ---------- AI情緒分析(呼叫Groq API,判斷重大訊息利多/利空/中性;API金鑰只在伺服器端使用,不會暴露給瀏覽器) ----------
async function getAnnouncementSentiment(items) {
  if (!items || items.length === 0) return {};
  try {
    const itemsForPrompt = items.map((it, i) => {
      // 優先使用完整「說明」內容(較長、資訊較完整),沒有的話退回只用「主旨」;限制300字避免內容過長
      let text = it.detail && it.detail.trim().length > 0 ? `${it.subject}。詳細內容:${it.detail}` : it.subject;
      if (text.length > 300) text = text.slice(0, 300);
      return { id: i, subject: text };
    });
    const prompt = `你是台股分析助手。以下是股票重大訊息公告內容清單,請針對每一則判斷對股價可能是「利多」「利空」或「中性」,並給一句話簡短理由(15字以內)。請務必只回傳JSON物件,格式如下,不要有其他文字說明:\n{"items":[{"id":0,"sentiment":"利多/利空/中性","reason":"簡短理由"}]}\n\n公告清單:\n${JSON.stringify(itemsForPrompt)}`;

    const url = 'https://api.groq.com/openai/v1/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      }),
    });
    const json = await res.json();
    let text = json?.choices?.[0]?.message?.content;
    if (!text) return {};
    text = text.replace(/^```json\s*/, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(text);
    const arr = parsed.items || parsed;
    const map = {};
    for (const item of arr) map[item.id] = { sentiment: item.sentiment, reason: item.reason };
    return map;
  } catch (e) {
    return {};
  }
}

app.get('/api/announcements/:code', async (req, res) => {
  const code = req.params.code.trim();
  try {
    const url = 'https://openapi.twse.com.tw/v1/opendata/t187ap04_L';
    const response = await fetch(url);
    const json = await response.json();

    // 官方欄位名稱有時會帶有前後空格(例如"主旨 "而非"主旨"),用寬鬆比對取值避免抓空
    const getField = (obj, pattern) => {
      const key = Object.keys(obj).find((k) => k.trim() === pattern || k.replace(/\s+/g, '') === pattern);
      return key ? obj[key] : null;
    };

    const items = json
      .filter((r) => getField(r, '公司代號') === code)
      .sort((a, b) => (getField(b, '發言日期') || '').localeCompare(getField(a, '發言日期') || ''))
      .slice(0, 5)
      .map((r) => ({
        date: getField(r, '發言日期'),
        time: getField(r, '發言時間'),
        subject: getField(r, '主旨'),
        detail: getField(r, '說明'),
        eventDate: getField(r, '事實發生日'),
      }));

    const sentimentMap = await getAnnouncementSentiment(items);
    items.forEach((it, i) => {
      if (sentimentMap[i]) {
        it.sentiment = sentimentMap[i].sentiment;
        it.reason = sentimentMap[i].reason;
      }
    });

    return res.json({ code, announcements: items });
  } catch (e) {
    return res.json({ code, announcements: [] });
  }
});

// ---------- 月營收年增率/月增率/產業別(基本面資料) ----------
app.get('/api/revenue/:code', async (req, res) => {
  const code = req.params.code.trim();
  try {
    const url = 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L';
    const response = await fetch(url);
    const json = await response.json();

    const getField = (obj, pattern) => {
      const key = Object.keys(obj).find((k) => k.replace(/\s+/g, '').includes(pattern));
      return key ? obj[key] : null;
    };

    const row = json.find((r) => getField(r, '公司代號') === code);
    if (!row) return res.json({ code, revenue: null });

    const yoyRaw = getField(row, '去年同月增減');
    const momRaw = getField(row, '上月比較增減');
    const industry = getField(row, '產業別');
    const yoy = yoyRaw && /^-?[\d.]+$/.test(yoyRaw) ? +parseFloat(yoyRaw).toFixed(2) : null;
    const mom = momRaw && /^-?[\d.]+$/.test(momRaw) ? +parseFloat(momRaw).toFixed(2) : null;

    return res.json({ code, revenue: { yoy, mom, industry } });
  } catch (e) {
    return res.json({ code, revenue: null });
  }
});

// ---------- 獲利品質(毛利率/營益率)+每股盈餘(EPS),與每日報表用同一份官方資料(上市公司綜合損益表-一般業) ----------
app.get('/api/profitability/:code', async (req, res) => {
  const code = req.params.code.trim();
  try {

    const url = 'https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci';
    const response = await fetch(url);
    const json = await response.json();

    const getField = (obj, pattern) => {
      const key = Object.keys(obj).find((k) => k.replace(/\s+/g, '').includes(pattern));
      return key ? obj[key] : null;
    };

    const row = json.find((r) => getField(r, '公司代號') === code);
    if (!row) return res.json({ code, profitability: null });

    const revenueRaw = getField(row, '營業收入');
    const grossProfitRaw = getField(row, '營業毛利');
    const opIncomeRaw = getField(row, '營業利益');
    const epsRaw = getField(row, '基本每股盈餘');

    if (!revenueRaw || !/^-?[\d.]+$/.test(revenueRaw)) return res.json({ code, profitability: null });
    const revenue = parseFloat(revenueRaw);
    if (revenue === 0) return res.json({ code, profitability: null });

    const grossMargin = grossProfitRaw && /^-?[\d.]+$/.test(grossProfitRaw) ? +((parseFloat(grossProfitRaw) / revenue) * 100).toFixed(1) : null;
    const operatingMargin = opIncomeRaw && /^-?[\d.]+$/.test(opIncomeRaw) ? +((parseFloat(opIncomeRaw) / revenue) * 100).toFixed(1) : null;
    // 此為官方季度累計綜合損益表資料,EPS為「本年累計」數字,不是單季數字,前端顯示時需明確標註避免誤解
    const eps = epsRaw && /^-?[\d.]+$/.test(epsRaw) ? +parseFloat(epsRaw).toFixed(2) : null;

    return res.json({ code, profitability: { grossMargin, operatingMargin, eps } });
  } catch (e) {
    return res.json({ code, profitability: null });
  }
});

// ---------- 自動生成AI綜合分析(比照每日報表邏輯,包含文字分析+情緒標籤,供一致性比對) ----------
app.post('/api/insight', async (req, res) => {
  const { context } = req.body || {};
  if (!context) return res.status(400).json({ error: '缺少必要參數' });
  if (!GROQ_API_KEY) {
    return res.json({ insight: null, debug: '⚠️ AI功能尚未設定金鑰,請至 Render 後台的 Environment 設定 GROQ_API_KEY' });
  }
  try {
    const prompt = `你是台股分析助手,資料:\n${context}\n\n用繁體中文寫一段話(120字內)綜合分析價量、技術指標、法人動向、估值,結尾一句市場關注重點。客觀中立不做投資建議,不編造資料外的數字。另外請依據上述資料(尤其是近期相關新聞標題與消息面)判斷市場輿情氛圍,給出「謹慎」「中立」「樂觀」三者的百分比評估,三者皆為整數且相加必須等於100,如果新聞資料不足以判斷,謹慎給較保守的比例分配(中立為主)。\n只回傳單行JSON,不要換行:{"analysis":"...","sentiment":"偏多/偏空/中性","cautious":整數,"neutral":整數,"optimistic":整數}`;
    const url = 'https://api.groq.com/openai/v1/chat/completions';
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        // openai/gpt-oss-20b是推理模型,回答前會先產生內部思考過程(不會顯示出來)才輸出最終JSON,
        // 原本1024上限容易在思考到一半時被截斷導致JSON沒寫完,主報表(PowerShell版)已經因為
        // 同樣的原因把上限提高到2048,這裡比照辦理同步調高,尤其這次還多加了3個百分比欄位,
        // 輸出內容變多後更需要足夠的token空間
        max_completion_tokens: 2048,
      }),
    });
    const json = await r.json();
    let text = json?.choices?.[0]?.message?.content;
    if (!text) {
      console.error('Groq /api/insight 回應異常:', JSON.stringify(json));
      if (isInvalidKeyResponse(json)) {
        return res.json({ insight: null, debug: '⚠️ AI金鑰已失效,請前往 Render 後台的 Environment 設定更新 GROQ_API_KEY(申請新金鑰:https://console.groq.com/keys)' });
      }
      return res.json({ insight: null, debug: `HTTP狀態:${r.status}, 回應:${JSON.stringify(json).slice(0, 500)}` });
    }
    text = text.replace(/^```json\s*/, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(text);
    // 情緒百分比為新增評估項目,若模型偶爾沒有依格式輸出(缺欄位),不應該讓整個AI分析失敗,
    // 缺欄位時對應值為undefined,前端已經有判斷「三個欄位都存在才顯示進度條」,不會強行湊數字
    const insight = { analysis: parsed.analysis, sentiment: parsed.sentiment };
    if (parsed.cautious != null && parsed.neutral != null && parsed.optimistic != null) {
      insight.cautious = parsed.cautious;
      insight.neutral = parsed.neutral;
      insight.optimistic = parsed.optimistic;
    }
    return res.json({ insight });
  } catch (e) {
    console.error('Groq /api/insight 例外錯誤:', e);
    return res.json({ insight: null, debug: `例外錯誤:${e.message}` });
  }
});

// ---------- 個股相關新聞(Google新聞RSS,免金鑰,依股票名稱+代號搜尋)----------
app.get('/api/news/:code', async (req, res) => {
  const code = req.params.code.trim();
  const name = (req.query.name || '').toString();
  try {
    const query = encodeURIComponent(`${name} ${code}`.trim());
    const url = `https://news.google.com/rss/search?q=${query}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
    const r = await fetch(url);
    const xmlText = await r.text();
    // 簡易XML解析:用正規表示式擷取每個<item>區塊的title/link/pubDate,避免額外安裝XML解析套件
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xmlText)) !== null && items.length < 5) {
      const block = match[1];
      const titleMatch = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
      const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
      const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      if (!titleMatch) continue;
      const rawTitle = titleMatch[1].trim();
      let newsTitle = rawTitle;
      let source = null;
      const sourceSplit = rawTitle.match(/^(.+?)\s*-\s*([^-]+)$/);
      if (sourceSplit) {
        newsTitle = sourceSplit[1].trim();
        source = sourceSplit[2].trim();
      }
      let dateText = '';
      if (pubDateMatch) {
        try {
          const d = new Date(pubDateMatch[1].trim());
          dateText = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        } catch (e) { }
      }
      items.push({ title: newsTitle, source, date: dateText, link: linkMatch ? linkMatch[1].trim() : null });
    }
    return res.json({ news: items });
  } catch (e) {
    console.error('新聞抓取失敗:', e);
    return res.json({ news: [], error: e.message });
  }
});

// ---------- 股利分派情形(官方僅提供董事會決議股利分派日,非最終除息交易日) ----------
app.get('/api/dividend/:code', async (req, res) => {
  const code = req.params.code.trim();
  try {
    const url = 'https://openapi.twse.com.tw/v1/opendata/t187ap45_L';
    const response = await fetch(url);
    const json = await response.json();
    const row = json.find((r) => r['公司代號'] === code);
    if (!row) return res.json({ code, dividend: null });
    return res.json({
      code,
      dividend: {
        year: row['股利年度'] || null,
        boardDate: row['董事會擬議股利分派日'] || row['股東常會日期'] || null,
        progress: row['股利決議層級'] || row['決議層級'] || null,
      },
    });
  } catch (e) {
    return res.json({ code, dividend: null });
  }
});

// ---------- 處置股警示(公布處置有價證券,含處置起迄日期) ----------
app.get('/api/disposition/:code', async (req, res) => {
  const code = req.params.code.trim();
  try {
    const url = 'https://www.twse.com.tw/announcement/punish?response=json';
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await response.json();
    if (json.stat !== 'OK' || !json.data) return res.json({ code, disposition: null });

    const fields = json.fields;
    const idxCode = fields.indexOf('證券代號');
    const idxDate = fields.indexOf('公布日期');
    const idxPeriod = fields.indexOf('處置起迄時間');
    const idxMeasure = fields.indexOf('處置措施');
    const idxCount = fields.indexOf('累計');
    if (idxCode < 0) return res.json({ code, disposition: null });

    const row = json.data.find((r) => (r[idxCode] || '').trim() === code);
    if (!row) return res.json({ code, disposition: null });
    return res.json({
      code,
      disposition: {
        announceDate: idxDate >= 0 ? row[idxDate] : null,
        period: idxPeriod >= 0 ? row[idxPeriod] : null,
        measure: idxMeasure >= 0 ? row[idxMeasure] : null,
        count: idxCount >= 0 ? row[idxCount] : null,
      },
    });
  } catch (e) {
    return res.json({ code, disposition: null });
  }
});

// ---------- 三大法人(外資/投信/自營商)當日買賣超 ----------
// 用法: GET /api/institutional/2330
app.get('/api/institutional/:code', async (req, res) => {
  const code = req.params.code.trim();
  try {
    const url = 'https://www.twse.com.tw/fund/T86?response=json&date=&selectType=ALLBUT0999';
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await response.json();
    if (json.stat !== 'OK' || !json.data) return res.json({ code, flow: null });

    const fields = json.fields;
    const idxCode = fields.indexOf('證券代號');
    const idxForeign1 = fields.indexOf('外陸資買賣超股數(不含外資自營商)');
    const idxForeign2 = fields.indexOf('外資自營商買賣超股數');
    const idxTrust = fields.indexOf('投信買賣超股數');
    const idxDealer = fields.indexOf('自營商買賣超股數');
    const idxTotal = fields.indexOf('三大法人買賣超股數');
    if (idxCode < 0 || idxTotal < 0) return res.json({ code, flow: null });

    const row = json.data.find((r) => (r[idxCode] || '').trim() === code);
    if (!row) return res.json({ code, flow: null });

    const num = (v) => parseFloat((v || '0').replace(/,/g, '')) || 0;
    const foreignNet = num(row[idxForeign1]) + (idxForeign2 >= 0 ? num(row[idxForeign2]) : 0);
    const trustNet = idxTrust >= 0 ? num(row[idxTrust]) : 0;
    const dealerNet = num(row[idxDealer]);
    const totalNet = num(row[idxTotal]);

    return res.json({ code, flow: { foreignNet, trustNet, dealerNet, totalNet } });
  } catch (e) {
    return res.json({ code, flow: null });
  }
});

// ---------- 融資融券餘額增減(融資=散戶動向替代指標,融券=放空力道,券資比=融券/融資;
// 官方CSV為Big5編碼,此處代為解碼轉發;與每日報表用同一份官方資料MI_MARGN,欄位索引相同) ----------
// 用法: GET /api/margin/2330
app.get('/api/margin/:code', async (req, res) => {
  const code = req.params.code.trim();
  try {
    const url = 'https://www.twse.com.tw/exchangeReport/MI_MARGN?response=csv&date=&selectType=ALL';
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const csvText = iconv.decode(Buffer.from(buffer), 'big5');

    const lines = csvText.split(/\r?\n/);
    let inTable = false;
    for (const line of lines) {
      if (line.includes('"代號","名稱"')) { inTable = true; continue; }
      if (!inTable) continue;
      if (line.trim() === '') break;
      const fields = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      if (fields.length < 7) continue;
      const rowCode = (fields[0] || '').trim();
      if (rowCode !== code) continue;
      const prevBal = parseFloat((fields[5] || '0').replace(/,/g, ''));
      const todayBal = parseFloat((fields[6] || '0').replace(/,/g, ''));
      if (isNaN(prevBal) || isNaN(todayBal)) break;
      const marginChange = todayBal - prevBal;
      const marginBalance = todayBal;

      // 融券欄位(第12、13欄,索引11、12):完整一列依序為代號,名稱,融資買進,融資賣出,融資現金償還,
      // 融資前日餘額,融資今日餘額,融資限額,融券買進,融券賣出,融券現券償還,融券前日餘額,融券今日餘額,融券限額,資券互抵
      let shortChange = null, shortBalance = null, shortMarginRatio = null;
      if (fields.length >= 13) {
        const shortPrev = parseFloat((fields[11] || '').replace(/,/g, ''));
        const shortToday = parseFloat((fields[12] || '').replace(/,/g, ''));
        if (!isNaN(shortPrev) && !isNaN(shortToday)) {
          shortChange = shortToday - shortPrev;
          shortBalance = shortToday;
          if (marginBalance > 0) shortMarginRatio = +((shortBalance / marginBalance) * 100).toFixed(2);
        }
      }

      return res.json({ code, marginChange, marginBalance, shortChange, shortBalance, shortMarginRatio });
    }
    return res.json({ code, marginChange: null });
  } catch (e) {
    return res.status(500).json({ error: '取得融資資料失敗' });
  }
});

// ---------- 借券賣出餘額(跟融券是不同機制,同樣代表市場放空/避險力道,官方每日公布;與每日報表同一份資料TWT93U)----------
// 用法: GET /api/lending/2330
app.get('/api/lending/:code', async (req, res) => {
  const code = req.params.code.trim();
  try {
    const url = 'https://www.twse.com.tw/exchangeReport/TWT93U?response=csv&date=&selectType=ALL';
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const csvText = iconv.decode(Buffer.from(buffer), 'big5');

    const lines = csvText.split(/\r?\n/);
    let inTable = false;
    for (const line of lines) {
      if (line.includes('"代號","名稱"') || line.includes('"股票代號"')) { inTable = true; continue; }
      if (!inTable) continue;
      if (line.trim() === '') break;
      const fields = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      if (fields.length < 13) continue;
      const rowCode = (fields[0] || '').trim();
      if (rowCode !== code) continue;
      // 完整一列依序:代號,名稱,前日融券餘額,本日融券賣出,本日融券買進,本日現券償還,本日融券餘額,本日融券限額,
      // 前日借券賣出餘額,本日市場借券賣出,本日還券,本日調整,本日借券賣出餘額(索引12)
      const priorBal = parseFloat((fields[8] || '').replace(/,/g, ''));
      const todayBal = parseFloat((fields[12] || '').replace(/,/g, ''));
      if (isNaN(priorBal) || isNaN(todayBal)) break;
      return res.json({ code, balance: todayBal, change: todayBal - priorBal });
    }
    return res.json({ code, balance: null, change: null });
  } catch (e) {
    return res.json({ code, balance: null, change: null });
  }
});

// ---------- 千張大戶(集保戶股權分散表,台灣集中保管結算所TDCC開放資料,每週更新一次,免費;
// 持股分級第15級=持股1,000張(1,000,000股)以上;與每日報表同一份資料來源) ----------
// 用法: GET /api/bigholder/2330
app.get('/api/bigholder/:code', async (req, res) => {
  const code = req.params.code.trim();
  try {
    const url = 'https://opendata.tdcc.com.tw/getOD.ashx?id=1-5';
    const response = await fetch(url);
    const csvText = await response.text();
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim() !== '');
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      if (cols.length < 6) continue;
      if ((cols[2] || '').trim() !== '15') continue; // 第15級=千張大戶
      if ((cols[1] || '').trim() !== code) continue;
      return res.json({
        code,
        date: (cols[0] || '').trim(),
        holders: parseInt((cols[3] || '0').trim(), 10),
        pct: parseFloat((cols[5] || '0').trim()),
      });
    }
    return res.json({ code, date: null, holders: null, pct: null });
  } catch (e) {
    return res.json({ code, date: null, holders: null, pct: null });
  }
});

// ---------- 財務體質:ROE/ROA/負債比率/流動比率(資產負債表t187ap07_L_ci,結合綜合損益表t187ap06_L_ci
// 的淨利計算;ROE/ROA為當季數字未年化,僅供同業比較參考,與每日報表算法相同) ----------
// 用法: GET /api/balancesheet/2330
app.get('/api/balancesheet/:code', async (req, res) => {
  const code = req.params.code.trim();
  try {
    const getField = (obj, pattern) => {
      const key = Object.keys(obj).find((k) => k.replace(/\s+/g, '').includes(pattern));
      return key ? obj[key] : null;
    };

    const [bsRes, isRes] = await Promise.all([
      fetch('https://openapi.twse.com.tw/v1/opendata/t187ap07_L_ci'),
      fetch('https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci'),
    ]);
    const [bsJson, isJson] = await Promise.all([bsRes.json(), isRes.json()]);

    const bsRow = bsJson.find((r) => getField(r, '公司代號') === code);
    if (!bsRow) return res.json({ code, balanceSheet: null });

    const numOrNull = (v) => (v && /^-?[\d.]+$/.test(v) ? parseFloat(v) : null);
    const totalAssets = numOrNull(getField(bsRow, '資產總額') || getField(bsRow, '資產總計'));
    const totalLiab = numOrNull(getField(bsRow, '負債總額') || getField(bsRow, '負債總計'));
    const currentAssets = numOrNull(getField(bsRow, '流動資產'));
    const currentLiab = numOrNull(getField(bsRow, '流動負債'));
    const totalEquity = numOrNull(getField(bsRow, '權益總額') || getField(bsRow, '權益總計'));

    const debtRatio = totalAssets && totalAssets > 0 && totalLiab != null ? +((totalLiab / totalAssets) * 100).toFixed(1) : null;
    const currentRatio = currentLiab && currentLiab > 0 && currentAssets != null ? +((currentAssets / currentLiab) * 100).toFixed(1) : null;

    let roe = null, roa = null;
    const isRow = isJson.find((r) => getField(r, '公司代號') === code);
    if (isRow) {
      const netIncome = numOrNull(getField(isRow, '本期淨利') || getField(isRow, '淨利（淨損）'));
      if (netIncome != null) {
        if (totalEquity && totalEquity > 0) roe = +((netIncome / totalEquity) * 100).toFixed(2);
        if (totalAssets && totalAssets > 0) roa = +((netIncome / totalAssets) * 100).toFixed(2);
      }
    }

    return res.json({ code, balanceSheet: { totalAssets, totalEquity, debtRatio, currentRatio, roe, roa } });
  } catch (e) {
    return res.json({ code, balanceSheet: null });
  }
});

// ---------- 歷年股利分派(上市公司股利分派情形t187ap45_L,近5年現金/股票股利,與每日報表同一份資料) ----------
// 用法: GET /api/dividendhistory/2330
app.get('/api/dividendhistory/:code', async (req, res) => {
  const code = req.params.code.trim();
  try {
    const url = 'https://openapi.twse.com.tw/v1/opendata/t187ap45_L';
    const response = await fetch(url);
    const json = await response.json();

    const getField = (obj, pattern) => {
      const key = Object.keys(obj).find((k) => k.replace(/\s+/g, '').includes(pattern));
      return key ? obj[key] : null;
    };
    const numOrZero = (v) => (v && /^-?[\d.]+$/.test(v) ? parseFloat(v) : 0);

    const rows = json.filter((r) => getField(r, '公司代號') === code);
    if (rows.length === 0) return res.json({ code, history: [] });

    const history = rows
      .map((r) => ({
        year: getField(r, '股利所屬年度') || getField(r, '年度'),
        cash: numOrZero(getField(r, '現金股利')),
        stock: numOrZero(getField(r, '股票股利')),
      }))
      .filter((h) => h.year)
      .sort((a, b) => String(b.year).localeCompare(String(a.year)))
      .slice(0, 5);

    return res.json({ code, history });
  } catch (e) {
    return res.json({ code, history: [] });
  }
});

// ---------- 總經風險客觀指標:VIX恐慌指數+美國10年期公債殖利率(Yahoo Finance,與每日報表同一套資料,
// 全域資料不分股票代號,前端可快取,不需每次查股票都重新呼叫) ----------
// 用法: GET /api/macro
app.get('/api/macro', async (req, res) => {
  const fetchYahoo = async (symbol) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!response.ok) return null;
      const json = await response.json();
      const result = json?.chart?.result?.[0];
      const closes = result?.indicators?.quote?.[0]?.close?.filter((v) => v != null);
      if (!closes || closes.length < 2) return null;
      const last = closes[closes.length - 1];
      const prev = closes[closes.length - 2];
      return { last: +last.toFixed(2), chg: +(last - prev).toFixed(2), chgPct: +(((last - prev) / prev) * 100).toFixed(2) };
    } catch (e) {
      return null;
    }
  };

  const [vix, tnx] = await Promise.all([fetchYahoo('^VIX'), fetchYahoo('^TNX')]);
  return res.json({ vix, tnx });
});

// ---------- 盤中分鐘級走勢資料(供繪製今日09:00-13:30走勢圖) ----------
// 用法: GET /api/intraday/2330
app.get('/api/intraday/:code', async (req, res) => {
  const code = req.params.code.trim();
  const suffixes = ['.TW', '.TWO'];

  for (const suf of suffixes) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}${suf}?range=1d&interval=1m`;
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!response.ok) continue;
      const json = await response.json();
      const result = json?.chart?.result?.[0];
      if (!result || !result.timestamp) continue;

      const closes = result.indicators.quote[0].close;
      const points = result.timestamp
        .map((t, i) => ({ time: t, price: closes[i] }))
        .filter((p) => p.price != null);
      if (points.length === 0) continue;

      return res.json({ code, points });
    } catch (e) {
      continue;
    }
  }
  return res.status(404).json({ error: `查無「${code}」的盤中資料` });
});

app.listen(PORT, () => {
  console.log(`代理伺服器已啟動,監聽埠號 ${PORT}`);
});

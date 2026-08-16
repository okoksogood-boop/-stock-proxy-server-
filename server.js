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
  const suffixes = ['.TW', '.TWO'];
  let bestPartial = null;

  for (const suf of suffixes) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}${suf}?range=3mo&interval=1d`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!response.ok) continue;
      const json = await response.json();
      const result = json?.chart?.result?.[0];
      if (!result) continue;

      const quote = result.indicators.quote[0];
      const validIdx = quote.close
        .map((v, i) => (v != null ? i : -1))
        .filter((i) => i >= 0);
      if (validIdx.length === 0) continue;

      const payload = {
        code,
        market: suf === '.TW' ? '上市' : '上櫃',
        name: result.meta?.longName || result.meta?.shortName || code,
        opens: validIdx.map((i) => quote.open[i]),
        closes: validIdx.map((i) => quote.close[i]),
        highs: validIdx.map((i) => quote.high[i]),
        lows: validIdx.map((i) => quote.low[i]),
        volumes: validIdx.map((i) => quote.volume[i]),
        timestamps: validIdx.map((i) => result.timestamp[i]),
        insufficientData: validIdx.length < 20,
        dataPoints: validIdx.length,
      };

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
const GROQ_API_KEY = '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';

// ---------- 互動問答:根據已查詢到的股票資料回答使用者問題 ----------
app.post('/api/ask', async (req, res) => {
  const { question, context } = req.body || {};
  if (!question || !context) return res.status(400).json({ error: '缺少必要參數' });
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
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const json = await r.json();
    const answer = json?.choices?.[0]?.message?.content;
    if (!answer) {
      // 拿不到預期格式的回答時,把實際回傳的內容原封不動附上,方便排查問題(除錯用,之後穩定運作後可移除)
      console.error('Groq /api/ask 回應異常:', JSON.stringify(json));
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
        model: 'llama-3.3-70b-versatile',
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

// ---------- 融資餘額增減(散戶動向替代指標,官方CSV為Big5編碼,此處代為解碼轉發) ----------
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
      return res.json({ code, marginChange: todayBal - prevBal });
    }
    return res.json({ code, marginChange: null });
  } catch (e) {
    return res.status(500).json({ error: '取得融資資料失敗' });
  }
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

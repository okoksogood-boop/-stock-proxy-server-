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

const PORT = process.env.PORT || 3000;

// ---------- 直接提供網頁本身(打開這個伺服器的網址就能看到App,不用再下載檔案) ----------
app.use(express.static('public'));

// ---------- 健康檢查(確認伺服器有正常運作) ----------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: '台股代理伺服器運作中' });
});

// ---------- 個股即時股價資料(轉發 Yahoo Finance) ----------
// 用法: GET /api/stock/2330  (自動嘗試上市.TW / 上櫃.TWO)
app.get('/api/stock/:code', async (req, res) => {
  const code = req.params.code.trim();
  const suffixes = ['.TW', '.TWO'];

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
      if (validIdx.length < 20) continue;

      return res.json({
        code,
        market: suf === '.TW' ? '上市' : '上櫃',
        name: result.meta?.longName || result.meta?.shortName || code,
        opens: validIdx.map((i) => quote.open[i]),
        closes: validIdx.map((i) => quote.close[i]),
        highs: validIdx.map((i) => quote.high[i]),
        lows: validIdx.map((i) => quote.low[i]),
        volumes: validIdx.map((i) => quote.volume[i]),
        timestamps: validIdx.map((i) => result.timestamp[i]),
      });
    } catch (e) {
      continue;
    }
  }
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

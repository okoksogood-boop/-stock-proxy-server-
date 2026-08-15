// ============================================================
// 台股即時分析 - 代理伺服器(Proxy Server)
// 作用:幫手機App向 Yahoo Finance / 證交所拿資料,
//      解決瀏覽器CORS安全限制無法直接抓取的問題
// ============================================================

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors()); // 允許任何來源呼叫這台代理伺服器(給手機App用)

const PORT = process.env.PORT || 3000;

// ---------- 健康檢查(確認伺服器有正常運作) ----------
app.get('/', (req, res) => {
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
        closes: validIdx.map((i) => quote.close[i]),
        highs: validIdx.map((i) => quote.high[i]),
        lows: validIdx.map((i) => quote.low[i]),
        volumes: validIdx.map((i) => quote.volume[i]),
      });
    } catch (e) {
      continue;
    }
  }
  return res.status(404).json({ error: `查無「${code}」的資料,請確認代號是否正確` });
});

// ---------- 全市場快照(轉發證交所 STOCK_DAY_ALL,可用於熱門股篩選等進階功能) ----------
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

app.listen(PORT, () => {
  console.log(`代理伺服器已啟動,監聽埠號 ${PORT}`);
});

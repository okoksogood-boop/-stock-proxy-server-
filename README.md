# 台股即時分析 - 代理伺服器

## 這是什麼
這是一個很小的中間伺服器,作用是幫手機 App 向 Yahoo Finance 和證交所拿股票資料,
再轉發給 App。因為伺服器程式不受瀏覽器的 CORS 安全限制,所以能正常抓到資料。

## 給 Claude Code 的部署指示

請幫我把這個資料夾部署到 Render.com(免費方案),步驟大致如下:
1. 幫我在這個資料夾初始化 git,建立 GitHub repository 並推送上去
   (如果我還沒有 GitHub 帳號,請引導我申請一個,完全免費)
2. 前往 Render.com,協助我用剛剛的 GitHub repository 建立一個新的 Web Service
   - Build Command: `npm install`
   - Start Command: `npm start`
   - 方案選擇 Free
3. 部署完成後,幫我測試這個網址是否正常運作:
   - `https://你的服務名稱.onrender.com/` 應該回傳 `{"status":"ok",...}`
   - `https://你的服務名稱.onrender.com/api/stock/2330` 應該回傳台積電的股價資料
4. 把最終網址整理給我,我要拿去更新手機 App 裡的資料來源網址

## 本地測試方式(如果想先在自己電腦測試)
```
npm install
npm start
```
然後瀏覽器開啟 http://localhost:3000/api/stock/2330 應該要能看到 JSON 資料。

## 注意事項
- Render.com 免費方案有「閒置後會休眠」的特性,15分鐘沒人使用會自動休眠,
  下次呼叫時第一次會比較慢(約20-30秒喚醒),之後就正常。這對個人使用是可以接受的。
- 如果之後想串接更多資料(例如三大法人籌碼、月營收等),可以請 Claude Code
  在 server.js 裡比照 /api/twse/snapshot 的寫法,新增更多轉發路由。

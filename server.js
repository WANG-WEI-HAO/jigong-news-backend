// jigongbao-pwa/backend/server.js
require('dotenv').config(); // 确保这是第一行

console.log('--- Environment Variables Loaded ---');
console.log('VAPID_MAILTO:', process.env.VAPID_MAILTO);
console.log('VAPID_PUBLIC_KEY:', process.env.VAPID_PUBLIC_KEY);
console.log('VAPID_PRIVATE_KEY:', process.env.VAPID_PRIVATE_KEY ? '******' : 'NOT SET'); // 保护私钥不完全打印
console.log('------------------------------------');

const express = require('express');
const webpush = require('web-push');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs'); // 虽然不再直接读取本地posts.json，但可能用于其他文件操作
const cors = require('cors');
const axios = require('axios');

const app = express();

app.use(cors()); // 开发方便，允许所有来源。生产环境请限制 origin。
app.use(bodyParser.json());

const vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
};

if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  console.error('錯誤：VAPID_PUBLIC_KEY 或 VAPID_PRIVATE_KEY 環境變數未設定！推播功能將無法工作。');
  // 可以选择在此处退出进程或抛出错误，以避免在配置不完整时运行。
}

webpush.setVapidDetails(
  process.env.VAPID_MAILTO || 'fycd.tc.jigong.news@gmail.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);



// !! 重要：此数组仅用于本地开发和演示。Render 每次部署都会重置。
// !! 生产环境请务必使用外部数据库（如 PostgreSQL, MongoDB Atlas）来持久化订阅信息。
let subscriptions = [];

// ===============================================
// API 端點
// ===============================================

// [POST] /api/subscribe - 處理前端的推播訂閱請求
app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscriptions.find(s => s.endpoint === subscription.endpoint)) {
      subscriptions.push(subscription);
      console.log('新增訂閱:', subscription.endpoint);
      // 生产环境：在此处将订阅保存到数据库
  } else {
      console.log('訂閱已存在:', subscription.endpoint);
  }
  res.status(201).json({ message: 'Subscription added/updated.' });
});

// [POST] /api/unsubscribe - 處理前端的取消訂閱請求
app.post('/api/unsubscribe', (req, res) => {
    const { endpoint } = req.body;
    const initialLength = subscriptions.length;
    subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);

    if (subscriptions.length < initialLength) {
        console.log('移除訂閱:', endpoint);
        // 生产环境：在此处从数据库中移除订阅
        res.status(200).json({ message: 'Subscription removed successfully.' });
    } else {
        console.warn('嘗試移除的訂閱不存在:', endpoint);
        res.status(404).json({ message: 'Subscription not found.' });
    }
});

// [GET] /api/vapid-public-key - 提供 VAPID 公鑰給前端
app.get('/api/vapid-public-key', (req, res) => {
    if (!vapidKeys.publicKey) {
        return res.status(500).send('VAPID Public Key is not configured on the server.');
    }
    res.status(200).send(vapidKeys.publicKey);
});

// [POST] /api/send-daily-notification - 每日自動觸發的推播端點
// 此端點將被 Render Cron Job 調用，需要有身份驗證和授權保護 (生产环境)
app.post('/api/send-daily-notification', async (req, res) => {
  console.log('收到每日通知觸發請求。');

  const postsJsonUrl = process.env.POSTS_JSON_URL;
  if (!postsJsonUrl) {
    console.error('錯誤：POSTS_JSON_URL 環境變數未設定！無法獲取 posts.json。');
    return res.status(500).json({ error: 'POSTS_JSON_URL 未設定。' });
  }

  let postsData;
  try {
    console.log(`正在從 ${postsJsonUrl} 獲取 posts.json...`);
    const response = await axios.get(postsJsonUrl);
    postsData = response.data;
  } catch (error) {
    console.error(`獲取 posts.json 失敗 (${postsJsonUrl}):`, error.message);
    return res.status(500).json({ error: '無法獲取最新文章數據。' });
  }

  if (!postsData || postsData.length === 0) {
      console.warn('遠端 posts.json 中沒有文章可供推播。');
      return res.status(404).json({ message: '沒有最新文章可供推播。' });
  }

  const latestPost = postsData[0];

  const title = req.body.title || latestPost.title || '濟公報新訊';
  const bodyContent = req.body.body || latestPost.content || latestPost.text || '點擊查看最新內容';

  const payload = JSON.stringify({
    title: `濟公報：${title}`,
    body: bodyContent.substring(0, 150) + (bodyContent.length > 150 ? '...' : ''),
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    image: latestPost.image || '',
    url: req.body.url || './index.html?source=daily_push'
  });

  console.log(`準備發送通知給 ${subscriptions.length} 位訂閱者...`);

  const pushPromises = subscriptions.map(sub =>
    webpush.sendNotification(sub, payload)
      .catch(err => {
        console.error('發送通知時發生錯誤:', err.statusCode, err.endpoint, err.message);
        if (err.statusCode === 404 || err.statusCode === 410 || err.statusCode === 400) {
          console.warn(`訂閱已過期或失效，將從列表中移除 (但由於無持久化，重啟服務會丟失): ${sub.endpoint}`);
          return { endpoint: sub.endpoint, status: 'invalid' };
        } else {
          return { endpoint: sub.endpoint, status: 'error', error: err };
        }
      })
  );

  const results = await Promise.all(pushPromises);

  const initialCount = subscriptions.length;
  subscriptions = subscriptions.filter(sub =>
    !results.some(result => result && result.status === 'invalid' && result.endpoint === sub.endpoint)
  );

  if (subscriptions.length < initialCount) {
    console.log(`已從內存中移除 ${initialCount - subscriptions.length} 筆失效訂閱。`);
    // 生产环境：在此处保存更新后的订阅列表到数据库
  }

  const successfulSends = results.filter(r => r === undefined).length;
  const failedSends = results.filter(r => r && (r.status === 'error' || r.status === 'invalid')).length;

  res.status(200).json({
    message: '每日通知發送嘗試完成',
    sent: successfulSends,
    failed: failedSends,
    remainingSubscriptions: subscriptions.length
  });
});

app.use(express.static(path.join(__dirname, '..', 'frontend', 'public')));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`伺服器正在 http://localhost:${port} 上運行`);
  console.log(`VAPID Public Key: ${vapidKeys.publicKey}`);
  console.log('----------------------------------------------------');
  console.log('重要：此範例的訂閱數據將在服務重啟時丟失。');
  console.log('生產環境請務必使用外部資料庫持久化訂閱！');
  console.log('----------------------------------------------------');
});
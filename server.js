// jigongbao-pwa/backend/server.js (数据库集成版)

require('dotenv').config();

const express = require('express');
const webpush = require('web-push');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg'); // <-- 引入 PostgreSQL 客户端

const app = express();

app.use(cors());
app.use(bodyParser.json());

const vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
};

if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  console.error('錯誤：VAPID_PUBLIC_KEY 或 VAPID_PRIVATE_KEY 環境變數未設定！推播功能將無法工作。');
}

webpush.setVapidDetails(
  process.env.VAPID_MAILTO || 'fycd.tc.jigong.news@gmail.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// 从环境变量中读取 PWA_BASE_URL
const PWA_BASE_URL = process.env.PWA_BASE_URL || 'https://jigong-news-backend.onrender.com';

// --- PostgreSQL 数据库配置 ---
// 从环境变量 DATABASE_URL 中获取连接字符串
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render 的 PostgreSQL 需要 SSL 连接
  ssl: {
    rejectUnauthorized: false // 对于 Render Free Tier，通常需要设置为 false
  }
});

// 连接数据库并确保订阅表存在
async function connectDbAndCreateTable() {
    try {
        await pool.query('SELECT 1'); // 尝试执行一个简单的查询来测试连接
        console.log('成功连接到 PostgreSQL 数据库！');
        // 创建 subscriptions 表，如果它不存在
        await pool.query(`
            CREATE TABLE IF NOT EXISTS subscriptions (
                endpoint TEXT PRIMARY KEY,
                subscription_json JSONB NOT NULL
            );
        `);
        console.log('subscriptions 表已就绪。');
    } catch (err) {
        console.error('连接数据库或创建表失败:', err.message);
        // 这里可以添加更健壮的错误处理，例如重试连接
        process.exit(1); // 退出进程，因为无法连接数据库是致命错误
    }
}

// 在应用程序启动时调用
connectDbAndCreateTable();


// --- API 端点 ---

// [POST] /api/subscribe - 處理前端的推播訂閱請求
app.post('/api/subscribe', async (req, res) => {
  const subscription = req.body;
  try {
      // 使用 INSERT ... ON CONFLICT DO UPDATE 实现 upsert (插入或更新)
      await pool.query(
          'INSERT INTO subscriptions(endpoint, subscription_json) VALUES($1, $2) ON CONFLICT (endpoint) DO UPDATE SET subscription_json = $2',
          [subscription.endpoint, JSON.stringify(subscription)]
      );
      console.log('新增/更新订阅到数据库:', subscription.endpoint);
      res.status(201).json({ message: 'Subscription added/updated successfully.' });
  } catch (error) {
      console.error('保存订阅到数据库失败:', error);
      res.status(500).json({ error: 'Failed to save subscription.' });
  }
});

// [POST] /api/unsubscribe - 處理前端的取消訂閱請求
app.post('/api/unsubscribe', async (req, res) => {
    const { endpoint } = req.body;
    try {
        const result = await pool.query('DELETE FROM subscriptions WHERE endpoint = $1', [endpoint]);
        if (result.rowCount > 0) {
            console.log('从数据库移除订阅:', endpoint);
            res.status(200).json({ message: 'Subscription removed successfully.' });
        } else {
            console.warn('尝试移除的订阅在数据库中不存在:', endpoint);
            res.status(404).json({ message: 'Subscription not found.' });
        }
    } catch (error) {
        console.error('从数据库移除订阅失败:', error);
        res.status(500).json({ error: 'Failed to remove subscription.' });
    }
});

// [GET] /api/vapid-public-key - 提供 VAPID 公鑰給前端
app.get('/api/vapid-public-key', (req, res) => {
    if (!vapidKeys.publicKey) {
        console.error('VAPID Public Key is not available for /api/vapid-public-key endpoint.');
        return res.status(500).send('VAPID Public Key is not configured on the server.');
    }
    res.status(200).send(vapidKeys.publicKey);
});

// [POST] /api/send-daily-notification - 每日自動觸發的推播端點
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
    icon: `${PWA_BASE_URL}icons/icon-192.png`,
    badge: `${PWA_BASE_URL}icons/icon-192.png`,
    image: latestPost.image ? `${PWA_BASE_URL}${latestPost.image.startsWith('/') ? latestPost.image.substring(1) : latestPost.image}` : '',
    url: req.body.url || `${PWA_BASE_URL}index.html?source=daily_push`
  });

  // 从数据库加载所有订阅
  let subscriptionsFromDb = [];
  try {
      const resDb = await pool.query('SELECT subscription_json FROM subscriptions');
      subscriptionsFromDb = resDb.rows.map(row => row.subscription_json); // JSONB 类型直接返回对象，不需要 JSON.parse
      console.log(`从数据库获取 ${subscriptionsFromDb.length} 笔订阅用于推播。`);
  } catch (error) {
      console.error('从数据库获取订阅列表失败:', error);
      res.status(500).json({ error: 'Failed to retrieve subscriptions for push.' });
      return;
  }

  console.log(`準備發送通知給 ${subscriptionsFromDb.length} 位訂閱者...`);

  const pushPromises = subscriptionsFromDb.map(sub =>
    webpush.sendNotification(sub, payload)
      .catch(async err => { // 这里添加 async
        console.error('發送通知時發生錯誤:', err.statusCode, err.endpoint, err.message);
        // 404/410/400 错误表示订阅失效，从数据库中删除
        if (err.statusCode === 404 || err.statusCode === 410 || err.statusCode === 400) {
          console.warn(`訂閱已過期或失效，正在從資料庫移除: ${sub.endpoint}`);
          try {
              await pool.query('DELETE FROM subscriptions WHERE endpoint = $1', [sub.endpoint]);
              console.log(`已從資料庫移除失效訂閱: ${sub.endpoint}`);
          } catch (dbErr) {
              console.error('從資料庫移除失效訂閱失敗:', dbErr);
          }
          return { endpoint: sub.endpoint, status: 'invalid' };
        } else {
          return { endpoint: sub.endpoint, status: 'error', error: err };
        }
      })
  );

  const results = await Promise.all(pushPromises);

  const successfulSends = results.filter(r => r === undefined).length; // webpush.sendNotification 成功时 resolve 为 undefined
  const failedSends = results.filter(r => r && (r.status === 'error' || r.status === 'invalid')).length;

  res.status(200).json({
    message: '每日通知發送嘗試完成',
    sent: successfulSends,
    failed: failedSends,
    totalSubscriptions: subscriptionsFromDb.length,
    notes: '部分失敗可能已從資料庫移除。'
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`伺服器正在 http://localhost:${port} 上運行`);
  console.log(`VAPID Public Key: ${vapidKeys.publicKey}`);
  console.log('----------------------------------------------------');
  console.log('** PostgreSQL 資料庫已啟用 **');
  console.log('----------------------------------------------------');
});

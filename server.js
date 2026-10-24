const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.static(process.cwd()));

app.get('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'shijian.html'));
});

const API_KEY = process.env.ZHIPU_API_KEY;

app.post('/api/chat', async (req, res) => {
  try {
    const userMessage = req.body.messages[0];
    
    // 强制统一使用 glm-4v，它完全兼容纯文本和图片，并且名字最稳定
    const requestData = {
      model: "glm-4v", 
      messages: [
        {
          role: "system",
          content: "你是『拾间』App的底层AI。不评判、不打扰、只陪伴。请用克制、温暖、不带任何数字评判的语气，写一段不超过100字的今日时光切片。像老朋友一样回复。"
        },
        userMessage 
      ]
    };

    const response = await axios.post('https://open.bigmodel.cn/api/paas/v4/chat/completions', requestData, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000 
    });
    
    res.json(response.data);
  } catch (error) {
    console.error('❌ 智谱 API 报错:', error.response?.data || error.message);
    // 【关键修改】：把后端的报错内容，直接发给前端，不再静默！
    res.status(500).json({ 
        error: "后端报错", 
        message: error.response?.data?.message || error.message 
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ 拾间已启动，运行在端口 ${PORT}`);
});

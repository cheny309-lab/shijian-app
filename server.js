const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

// 模块 1：基础配置
app.use(express.json({ limit: '50mb' }));
app.use(express.static(process.cwd()));

app.get('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'shijian.html'));
});

const API_KEY = process.env.ZHIPU_API_KEY;

// 模块 2：AI 请求处理（20秒超时保命）
app.post('/api/chat', async (req, res) => {
  try {
    const userMessage = req.body.messages[0];
    const requestData = {
      model: "glm-4v", 
      messages: [
        { role: "system", content: "你是『拾间』App的底层AI。不评判、不打扰、只陪伴。用温暖语气写一段不超过100字的今日时光切片。" },
        userMessage 
      ]
    };

    const response = await axios.post('https://open.bigmodel.cn/api/paas/v4/chat/completions', requestData, {
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 20000 
    });
    res.json(response.data);
  } catch (error) {
    console.error('❌ 智谱 API 报错:', error.message);
    res.status(500).json({ message: error.response?.data?.message || error.message });
  }
});

// 模块 3：启动服务
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => { console.log(`✅ 拾间已启动，端口 ${PORT}`); });
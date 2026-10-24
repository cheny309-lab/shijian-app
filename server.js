const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

// 允许接收大图片
app.use(express.json({ limit: '50mb' }));

// 1. 明确告诉服务器，把当前文件夹作为静态资源目录
app.use(express.static(process.cwd()));

// 2. 明确指定根路径 / 返回 shijian.html
app.get('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'shijian.html'));
});

// ⚠️ 这里的 Key 从云端的环境变量中读取
const API_KEY = process.env.ZHIPU_API_KEY;

// 处理 AI 对话请求
app.post('/api/chat', async (req, res) => {
  try {
    const requestData = {
      model: "glm-4v",
      messages: [
        {
          role: "system",
                    content: "你是『拾间』App的底层AI。你的理念是：人生本无意义，不存在无意义支出；没有被记录的时间就是留白；不评判、不打扰、只陪伴。用户发来了一段生活碎碎念、消费账单截图，或者一张风景/生活照片。请你仔细观察，如果是账单，指出这笔消费背后的情绪；如果是照片，描述照片中治愈的细节。用克制、温暖、不带任何数字评判的语气，写一段不超过100字的《今日时光切片》。不出现任何‘超支、浪费、应该’等词汇。像老朋友一样回复。"
        },
        req.body.messages[0] 
      ]
    };

    const response = await axios.post('https://open.bigmodel.cn/api/paas/v4/chat/completions', requestData, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    res.json(response.data);
  } catch (error) {
    console.error('请求出错:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: '大脑连接失败' });
  }
});

// 3. 端口使用 Render 提供的环境变量，如果没有则默认 10000
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ 拾间已启动，运行在端口 ${PORT}`);
});

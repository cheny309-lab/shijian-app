const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

// ========================================================
// 模块 1：基础配置与静态文件托管
// ========================================================
app.use(express.json({ limit: '50mb' }));
app.use(express.static(process.cwd()));

app.get('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'shijian.html'));
});

const API_KEY = process.env.ZHIPU_API_KEY;

// ========================================================
// 模块 2：处理 AI 聊天请求（带 20 秒严格超时，防死机）
// ========================================================
app.post('/api/chat', async (req, res) => {
  try {
    const userMessage = req.body.messages[0];
    const requestData = {
      model: "glm-4v", 
      messages: [
        { 
          role: "system", 
          content: "你是『拾间』App的底层AI。不评判、不打扰、只陪伴。用温暖语气写一段不超过100字的今日时光切片。" 
        },
        userMessage 
      ]
    };

    // 呼叫智谱 API，加入 20 秒超时限制
    const response = await axios.post('https://open.bigmodel.cn/api/paas/v4/chat/completions', requestData, {
      headers: { 
        'Authorization': `Bearer ${API_KEY}`, 
        'Content-Type': 'application/json' 
      },
      timeout: 20000 
    });
    
    res.json(response.data);
  } catch (error) {
    console.error('❌ 智谱 API 报错:', error.message);
    res.status(500).json({ message: error.response?.data?.message || error.message });
  }
});

// ========================================================
// 模块 3：启动服务
// ========================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => { 
  console.log(`✅ 拾间已启动，端口 ${PORT}`); 
});

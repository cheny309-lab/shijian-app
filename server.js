const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

// ========================================================
// 模块 1：基础配置与中间件
// ========================================================
app.use(express.json({ limit: '50mb' })); // 放宽请求体积限制
app.use(express.static(process.cwd()));   // 托管静态文件

app.get('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'shijian.html'));
});

const API_KEY = process.env.ZHIPU_API_KEY; // 从环境变量读取秘钥

// ========================================================
// 模块 2：处理 AI 聊天请求的 API 路由
// ========================================================
app.post('/api/chat', async (req, res) => {
  try {
    const userMessage = req.body.messages[0];
    let modelName = "glm-4-flash"; // 默认使用纯文本快速模型
    
    // 【核心修复】：精准判断是否包含图片。如果有图，必须强制切换到视觉模型 glm-4v
    if (Array.isArray(userMessage.content)) {
        const hasImage = userMessage.content.some(item => item.type === 'image_url');
        if (hasImage) {
            modelName = "glm-4v"; 
        }
    }

    const requestData = {
      model: modelName,
      messages: [
        {
          role: "system",
          content: "你是『拾间』App的底层AI。你的理念是：人生本无意义，不存在无意义支出；没有被记录的时间就是留白；不评判、不打扰、只陪伴。用户发来了一段生活记录或消费截图，请你用克制、温暖、不带任何数字评判的语气，写一段不超过100字的《今日时光切片》。要求：指出这笔消费背后的情绪，或者赞美他/她今天的辛苦，不出现任何‘超支、浪费、应该’等词汇。像老朋友一样回复，不要有长篇大论的废话。"
        },
        userMessage // 把前端发来的消息直接透传
      ]
    };

    // 呼叫智谱 API
    const response = await axios.post('https://open.bigmodel.cn/api/paas/v4/chat/completions', requestData, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30秒超时限制
    });
    
    // 成功返回
    res.json(response.data);

  } catch (error) {
    // ========================================================
    // 模块 3：错误拦截与日志打印
    // ========================================================
    console.error('❌ 智谱 API 报错:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ 
        error: 'AI处理失败', 
        details: error.response?.data || error.message 
    });
  }
});

// ========================================================
// 模块 4：启动服务
// ========================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ 拾间已启动，运行在端口 ${PORT}`);
});

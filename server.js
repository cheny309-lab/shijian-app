'use strict';

const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { generateJournal } = require('./modules/journal-ai');
const { createFeedback } = require('./modules/feedback');
const { extractBills, makeReflections, providerDiagnosis } = require('./modules/billing-ai');

// 模块 1：运行配置。密钥只从 Render 环境变量读取，不写进网页。
const VERSION = '2026.10.29-trajectory-v0.4.0';
function readConfig(env = process.env) {
  const seconds = Number(env.AI_TIMEOUT_SECONDS || 25);
  return {
    feedbackDir:(env.FEEDBACK_DATA_DIR||'').trim(), feedbackAdminToken:(env.FEEDBACK_ADMIN_TOKEN||'').trim(), feedbackContact:(env.SHIJIAN_CONTACT||'').trim(), feedbackOperator:(env.SHIJIAN_OPERATOR||'').trim(), feedbackRegion:(env.SHIJIAN_SERVER_REGION||'').trim(), feedbackRetentionDays:Number(env.FEEDBACK_RETENTION_DAYS||90),
    apiKey: (env.ZHIPU_API_KEY || '').trim(),
    // 保留原模型默认值，避免在修复时擅自切换账户计费模型。
    model: (env.ZHIPU_MODEL || 'glm-4v').trim(),
    imageModel: (env.ZHIPU_IMAGE_MODEL || env.ZHIPU_MODEL || 'glm-4v').trim(),
    billModel: (env.ZHIPU_BILL_MODEL || '').trim(),
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    timeout: Math.min(55, Math.max(1, Number.isFinite(seconds) ? seconds : 25)) * 1000
  };
}
const SYSTEM_PROMPT = '你是拾间的生活记录助手。语气自然、克制、有温度，不写公文和流水账播报，不逐项罗列商户、日期和金额；围绕用户明确留下的一个细节写，不把温柔等同于赞美。不评判、不催促，只依据用户明确提供的文字和图片，写一段不超过100字的时光切片。不得从商户或金额推断疲惫、孤独、治愈、同行人和消费动机。用户已说明加班或辛苦时可以温和回应。没有依据就少写，不伪造经历。不输出HTML，不重复要求用户记录。';

// 模块 2：请求校验。兼容原网页 messages 格式，只转发本次用户内容。
function normalizeMessage(body) {
  const message = body && Array.isArray(body.messages) && body.messages[0];
  if (!message || message.role !== 'user') throw new Error('请提供本次记录的文字或图片。');
  const source = typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }] : message.content;
  if (!Array.isArray(source) || source.length > 4) throw new Error('记录格式不正确。');
  const content = [];
  let textLength = 0;
  let imageCount = 0;
  for (const part of source) {
    if (part && part.type === 'text' && typeof part.text === 'string') {
      const text = part.text.trim();
      textLength += text.length;
      if (text) content.push({ type: 'text', text });
    } else if (part && part.type === 'image_url') {
      const url = part.image_url && part.image_url.url;
      if (typeof url !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) {
        throw new Error('图片格式不正确，请重新选择图片。');
      }
      if (url.length > 3 * 1024 * 1024) throw new Error('图片较大，请压缩后重试。');
      imageCount += 1;
      content.push({ type: 'image_url', image_url: { url } });
    } else {
      throw new Error('记录中包含不支持的内容。');
    }
  }
  if (textLength > 8000 || imageCount > 1) throw new Error('每次最多8000字和一张图片。');
  if (!content.length) throw new Error('请先写下文字或选择图片。');
  if (!textLength) content.unshift({ type: 'text', text: '请根据图片中能够确认的内容，整理一个简短生活片段。' });
  return { role: 'user', content };
}

// 模块 3：上游结果与错误归一化。日志不记录密钥、原图或用户正文。
function extractContent(data) {
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(item => item && item.type === 'text').map(item => item.text || '').join('\n') : '';
  return text.trim();
}
function providerError(error) {
  const status = error.response && error.response.status;
  const details = error.response && error.response.data;
  const code = String((details && details.error && details.error.code) || (details && details.code) || '');
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
    return { status: 504, code: 'AI_TIMEOUT', message: 'AI整理超时，原始记录不受影响，可以稍后重试。', retryable: true };
  }
  if (status === 401 || status === 403) {
    return { status: 502, code: 'AI_AUTH', message: 'AI服务鉴权失败，请检查 Render 中的密钥及模型权限。', retryable: false };
  }
  if (status === 429) {
    return { status: 503, code: 'AI_LIMIT', message: 'AI服务额度或频率暂受限，原始记录已保留。', retryable: true };
  }
  if (status === 400 || code === '1211' || code === '1214') {
    return { status: 502, code: 'AI_CONFIGURATION', message: 'AI模型或输入配置不匹配，请核对模型设置。', retryable: false };
  }
  return { status: 502, code: 'AI_UNAVAILABLE', message: '暂时无法连接AI服务，原始记录已保留，可稍后重试。', retryable: true };
}

// 模块 4：应用与路由。依赖可注入，测试不需要真实密钥或收费请求。
function createApp({ config = readConfig(), httpClient = axios, rootDir = __dirname, logger = console } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set('X-Shijian-Version', VERSION);
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '8mb' }));
  const feedback=createFeedback({dataDir:config.feedbackDir||'',adminToken:config.feedbackAdminToken||'',contact:config.feedbackContact||'',operator:config.feedbackOperator||'',region:config.feedbackRegion||'',retentionDays:config.feedbackRetentionDays,logger});
  app.use('/api/feedback',feedback.router);
  app.get('/admin-feedback',(req,res)=>{res.set('Cache-Control','no-store');res.sendFile(path.join(rootDir,'admin/feedback.html'));});

  const sendPage = (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(rootDir, 'shijian.html'));
  };
  app.get('/', sendPage);
  app.get('/shijian.html', sendPage);
  const health = (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, version: VERSION, aiConfigured: Boolean(config.apiKey), model: config.model, imageModel: config.imageModel, billModel: config.billModel || config.imageModel,feedbackConfigured:feedback.config.enabled });
  };
  app.get('/health', health);
  app.get('/api/health', health);

  // 仅开放常用图标及 assets，不将服务器源码和整个仓库作为静态目录公开。
  app.use('/assets', express.static(path.join(rootDir, 'assets'), { dotfiles: 'deny', setHeaders: res => res.set('Cache-Control', 'no-store') }));
  for (const name of ['favicon.ico', 'icon.png', 'favicon.png', 'apple-touch-icon.png', 'manifest.json', 'manifest.webmanifest']) {
    app.get('/' + name, (req, res) => {
      const file = path.join(rootDir, name);
      if (!fs.existsSync(file)) return res.sendStatus(404);
      res.set('Cache-Control', 'no-store');
      res.sendFile(file);
    });
  }

  app.post('/api/chat', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const fail = (status, code, message, retryable = false) => res.status(status).json({
      message, error: { code, message, retryable, requestId: req.requestId }
    });
    let message;
    try { message = normalizeMessage(req.body); }
    catch (error) { return fail(400, 'INVALID_INPUT', error.message); }
    if (!config.apiKey) return fail(503, 'AI_KEY_MISSING', 'AI密钥尚未配置，请在 Render 设置 ZHIPU_API_KEY。');

    const hasImage = message.content.some(part => part.type === 'image_url');
    const model = hasImage ? config.imageModel : config.model;
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    try {
      const response = await httpClient.post(config.endpoint, {
        model,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, message],
        max_tokens: 512
      }, {
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        timeout: config.timeout,
        signal: controller.signal
      });
      if (res.destroyed) return;
      const content = extractContent(response.data);
      if (!content) return fail(502, 'AI_EMPTY_RESULT', 'AI没有返回可用文字，原始记录已保留，可重试。', true);
      res.json({ choices: [{ message: { role: 'assistant', content } }], requestId: req.requestId });
    } catch (error) {
      if (res.destroyed || controller.signal.aborted) return;
      const info = providerError(error);
      logger.error('[shijian:ai]', { requestId: req.requestId, code: info.code, upstreamStatus: error.response && error.response.status, model });
      fail(info.status, info.code, info.message, info.retryable);
    } finally {
      res.removeListener('close', onClose);
    }
  });

  // 账单与生活回看独立路由；任一失败不改变浏览器中已经保存的原始记录。
  const structuredRoute = operation => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const fail = (status, code, message, details = {}) => res.status(status).json({ error: { code, message, requestId: req.requestId, ...details } });
    if (!config.apiKey) return fail(503, 'AI_KEY_MISSING', 'AI密钥尚未配置，请在 Render 设置 ZHIPU_API_KEY。');
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    try {
      const result = await operation(req.body, controller.signal);
      if (!res.destroyed) res.json({ ...result, requestId: req.requestId });
    } catch (error) {
      if (res.destroyed || controller.signal.aborted) return;
      const details = providerDiagnosis(error);
      const info = error.code === 'INVALID_INPUT' ? { status: 400, code: error.code, message: error.message }
        : ['AI_INVALID_JSON', 'AI_OUTPUT_LIMIT'].includes(error.code) ? { status: 502, code: error.code, message: error.message } : providerError(error);
      if (info.code === 'AI_CONFIGURATION') {
        if (details.upstreamCode === '1211') info.message = '账单模型不可用，请核对模型名称及账户权限；日记与账单可配置不同模型。';
        else if (details.parameter === 'max_tokens') info.message = '当前账单模型拒绝了输出长度参数。请分段截图，或配置支持较长输出的独立账单模型。';
        else if (details.parameter === 'image_url') info.message = '当前账单模型不接受这类图片输入，请配置支持Base64图片的账单模型。';
        else if (details.parameter) info.message = '账单请求的 ' + details.parameter + ' 参数不被当前模型接受，原始资料仍保留。';
      }
      logger.error('[shijian:structured]', { requestId: req.requestId, code: info.code, upstreamStatus: error.response && error.response.status, ...details });
      fail(info.status, info.code, info.message, details);
    } finally { res.removeListener('close', onClose); }
  };
  app.post('/api/journal', structuredRoute(async (body,signal)=>{let message;try{message=normalizeMessage(body);}catch(e){e.code='INVALID_INPUT';throw e;}return generateJournal({client:httpClient,config,message,signal,extractContent});}));
  app.post('/api/bills/extract', structuredRoute(async (body, signal) => {
    let message;
    try { message = normalizeMessage(body); }
    catch (error) { error.code = 'INVALID_INPUT'; throw error; }
    return extractBills({ client: httpClient, config, message, extractContent, signal });
  }));
  app.post('/api/reflections', structuredRoute(async (body, signal) => {
    const periods = body && body.periods;
    if (!Array.isArray(periods) || !periods.length || periods.length > 6 || JSON.stringify(periods).length > 24000 || periods.some(p =>
      !p || !/^\d{4}-\d{2}(?:-\d{2})?$/.test(p.id) || !Number.isInteger(p.count) || p.count < 0 || !Array.isArray(p.totals) || !Array.isArray(p.merchants) || !Array.isArray(p.notes)
    ) || new Set(periods.map(p => p.id)).size !== periods.length) {
      const error = new Error('回看资料格式不正确。'); error.code = 'INVALID_INPUT'; throw error;
    }
    const items = await makeReflections({ client: httpClient, config, periods, extractContent, signal });
    return { items };
  }));

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const tooLarge = error.type === 'entity.too.large';
    const invalidJson = error.type === 'entity.parse.failed';
    const status = tooLarge ? 413 : invalidJson ? 400 : 500;
    const message = tooLarge ? '提交内容较大，请减少文字或重新选择图片。' : invalidJson ? '提交格式不正确，请刷新后重试。' : '服务暂时不可用，请稍后重试。';
    res.status(status).json({ message, error: { code: tooLarge ? 'PAYLOAD_TOO_LARGE' : invalidJson ? 'INVALID_JSON' : 'SERVER_ERROR', message, requestId: req.requestId } });
  });
  return app;
}

// 模块 5：Render 启动入口。使用文件所在目录，与启动工作目录无关。
if (require.main === module) {
  const required = ['shijian.html', 'assets/ledger-core.js', 'assets/storage.js', 'assets/journal-core.js', 'assets/journal-ui.js', 'assets/app.js', 'assets/app.css','assets/backup-core.js','assets/backup-worker.js','assets/backup-ui.js','assets/drafts-service.js','assets/feedback-ui.js','assets/mine-ui.js','assets/admin-feedback.js','admin/feedback.html','manifest.webmanifest','assets/desktop-ui.js','assets/quick-bill.js','assets/trajectory-core.js','assets/trajectory-ui.js','modules/journal-ai.js','assets/icons/icon-192.png','assets/icons/icon-512.png','assets/icons/icon-maskable-512.png','assets/icons/apple-touch-icon.png','assets/icons/favicon-32.png'];
  for (const file of required) {
    if (!fs.existsSync(path.join(__dirname, file))) {
      console.error('部署缺少文件：' + file + '。请将账单开发包按原文件夹结构完整上传。');
      process.exit(1);
    }
  }
  const config = readConfig();
  const app = createApp({ config });
  const port = Number(process.env.PORT) || 10000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`拾间 ${VERSION} 已启动，端口 ${port}`);
    if (!config.apiKey) console.warn('未设置 ZHIPU_API_KEY；本地记录可用，AI整理暂不可用。');
  });
}
module.exports = { createApp, readConfig, normalizeMessage, providerError, extractContent, VERSION };

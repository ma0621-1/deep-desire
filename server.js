require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');

const payRouter = require('./routes/pay');

const app = express();
const PORT = process.env.PORT || 3000;

// 解析 JSON 与表单（支付宝异步通知为 form-urlencoded）
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// 静态前端页面
app.use(express.static(path.join(__dirname, 'public')));

// 支付相关接口
app.use('/api/pay', payRouter);

app.listen(PORT, () => {
  console.log(`性格测试服务已启动：http://localhost:${PORT}`);
  const configured =
    process.env.ALIPAY_APP_ID &&
    process.env.ALIPAY_PRIVATE_KEY &&
    process.env.ALIPAY_PUBLIC_KEY;
  console.log(
    `支付宝支付配置：${
      configured ? '已配置' : '未配置（请复制 .env.example 为 .env 并填入密钥）'
    }`
  );
});

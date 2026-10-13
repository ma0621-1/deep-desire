const express = require('express');
const crypto = require('crypto');
// alipay-sdk 4.14+ 为命名导出，pageExec 为同步方法（旧版 v3 使用 .default + formData，勿混用）
const { AlipaySdk } = require('alipay-sdk');

const router = express.Router();

/* ============ 配置（全部来自 .env） ============ */
const SUBJECT    = process.env.ALIPAY_SUBJECT || '性格强度自评完整报告';
const AMOUNT     = process.env.PRODUCT_PRICE || '5.90';
const PORT       = process.env.PORT || 3000;
const RETURN_URL = process.env.ALIPAY_RETURN_URL || `http://localhost:${PORT}/api/pay/return`;
const NOTIFY_URL = process.env.ALIPAY_NOTIFY_URL || '';

/* ============ 订单存储（内存 Map，重启即清空；生产建议换数据库） ============ */
const orders = new Map();

/* 本地调试专用：PRELOAD_ORDERS 为 JSON 时在启动时预置订单（如恢复人工确认已付款的订单）。
   仅当显式设置该环境变量才生效；正式部署时不要设置。 */
try {
  if (process.env.PRELOAD_ORDERS) {
    const seed = JSON.parse(process.env.PRELOAD_ORDERS);
    for (const [id, o] of Object.entries(seed)) {
      if (id && o) {
        orders.set(id, {
          orderId: id,
          version: o.version || '1.0',
          amount: o.amount || AMOUNT,
          subject: SUBJECT,
          status: o.status || 'PAID',
          createTime: o.createTime || new Date().toISOString(),
          tradeNo: o.tradeNo || '',
          paidTime: o.paidTime || new Date().toISOString()
        });
        console.log(`[preload] 订单 ${id} -> ${orders.get(id).status}`);
      }
    }
  }
} catch (err) {
  console.log('[preload] 预置订单解析失败：' + err.message);
}

let sdk = null;
let sdkAttempted = false;

/* 密钥归一化：兼容多行 PEM / 单行带头 / 无头 base64 等各种粘贴形式，
   alipay-sdk 4.x 的 formatKey 会把 PKCS1 公钥体错包成 SPKI 头导致验签 wrong tag，
   故统一先用 Node crypto 转成标准格式再交给 SDK。 */
function normalizePrivateKey(raw) {
  const s = String(raw).replace(/\\n/g, '\n').trim();
  try {
    return crypto.createPrivateKey(s).export({ type: 'pkcs8', format: 'pem' }).toString().trim();
  } catch (e) {
    for (const h of ['-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----']) {
      try {
        return crypto
          .createPrivateKey(h + '\n' + s + '\n' + h.replace('BEGIN', 'END'))
          .export({ type: 'pkcs8', format: 'pem' })
          .toString()
          .trim();
      } catch (_) {}
    }
    throw e;
  }
}
function normalizePublicKey(raw) {
  const s = String(raw).replace(/\\n/g, '\n').trim();
  try {
    return crypto.createPublicKey(s).export({ type: 'spki', format: 'pem' }).toString().trim();
  } catch (e) {
    for (const h of ['-----BEGIN PUBLIC KEY-----', '-----BEGIN RSA PUBLIC KEY-----']) {
      try {
        return crypto
          .createPublicKey(h + '\n' + s + '\n' + h.replace('BEGIN', 'END'))
          .export({ type: 'spki', format: 'pem' })
          .toString()
          .trim();
      } catch (_) {}
    }
    throw e;
  }
}

function getSdk() {
  if (sdk || sdkAttempted) return sdk;
  sdkAttempted = true;
  const appId = process.env.ALIPAY_APP_ID;
  const privateKey = process.env.ALIPAY_PRIVATE_KEY;
  const alipayPublicKey = process.env.ALIPAY_PUBLIC_KEY;
  if (!appId || !privateKey || !alipayPublicKey) return null;
  sdk = new AlipaySdk({
    appId,
    privateKey: normalizePrivateKey(privateKey),
    alipayPublicKey: normalizePublicKey(alipayPublicKey),
    gateway: process.env.ALIPAY_GATEWAY || 'https://openapi.alipay.com',
    signType: 'RSA2',
    keyType: 'PKCS8' // 私钥已归一化为 PKCS8，与 SDK 的 formatKey 对齐
  });
  return sdk;
}

function genOrderId() {
  return (
    'DS' +
    Date.now().toString(36).toUpperCase() +
    crypto.randomBytes(6).toString('hex').toUpperCase()
  );
}

/**
 * POST /api/pay/create
 * 接收 version 参数，生成订单号，调用支付宝 alipay.trade.page.pay，
 * 返回支付表单 HTML（前端注入后自动提交，跳转收银台）。
 */
router.post('/create', async (req, res) => {
  const sdkInstance = getSdk();
  if (!sdkInstance) {
    return res.status(503).json({
      success: false,
      message:
        '支付尚未配置：请先复制 .env.example 为 .env，并填写 ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY / ALIPAY_PUBLIC_KEY'
    });
  }

  const version = String((req.body && req.body.version) || '1.0').slice(0, 32);
  /* 回跳地址优先级：前端传入（按用户当前访问地址动态生成，兼容手机/电脑）→ .env → 默认 localhost */
  const returnUrl =
    String((req.body && req.body.returnUrl) || '').slice(0, 500) ||
    RETURN_URL;
  const orderId = genOrderId();
  const order = {
    orderId,
    version,
    amount: AMOUNT,
    subject: SUBJECT,
    status: 'CREATED',
    createTime: new Date().toISOString()
  };
  orders.set(orderId, order);

  const params = {
    returnUrl,
    bizContent: {
      outTradeNo: orderId,
      productCode: 'FAST_INSTANT_TRADE_PAY',
      totalAmount: AMOUNT,
      subject: SUBJECT
    }
  };
  // 本地无公网 HTTPS notify_url 时不传，靠回跳 + 状态查询验收；
  // 生产环境配置公网 HTTPS 地址后自动带上异步通知
  if (NOTIFY_URL) params.notifyUrl = NOTIFY_URL;

  try {
    // alipay-sdk 4.14：pageExec 同步返回支付表单 HTML（POST 表单 + 自动提交脚本）
    const payForm = sdkInstance.pageExec('alipay.trade.page.pay', 'POST', params);
    order.status = 'PAYING';
    res.json({ success: true, orderId, amount: AMOUNT, payForm });
  } catch (err) {
    order.status = 'CREATE_FAILED';
    res.status(502).json({ success: false, message: '创建支付失败：' + err.message });
  }
});

/**
 * POST /api/pay/notify
 * 支付宝异步通知：支付宝公钥验签 → 校验金额 → 更新订单为已支付 → 返回 "success"
 * 幂等：重复通知同样返回 success，不重复入账。
 */
router.post('/notify', (req, res) => {
  const sdkInstance = getSdk();
  if (!sdkInstance) {
    // 未配置密钥时不该收到通知；返回 success 避免支付宝持续重发
    return res.send('success');
  }
  try {
    const params = req.body || {};
    if (!sdkInstance.checkNotifySign(params)) {
      return res.send('failure');
    }
    const orderId = String(params.out_trade_no || '');
    const order = orders.get(orderId);
    if (!order) return res.send('failure');

    const tradeStatus = String(params.trade_status || '');
    if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
      const paid = Number(params.total_amount || 0);
      // 金额校验：与实际应付金额不一致则拒绝入账
      if (Math.abs(paid - Number(order.amount)) > 0.001) {
        return res.send('failure');
      }
      order.status = 'PAID';
      order.tradeNo = String(params.trade_no || '');
      order.paidTime = new Date().toISOString();
    }
    res.send('success');
  } catch (err) {
    res.send('failure');
  }
});

/**
 * GET /api/pay/status?orderId=xxx
 * 查询订单状态：CREATED / PAYING / PAID / CREATE_FAILED
 */
router.get('/status', (req, res) => {
  const orderId = String((req.query && req.query.orderId) || '');
  const order = orders.get(orderId);
  if (!order) {
    return res.status(404).json({ success: false, message: '订单不存在' });
  }
  res.json({
    success: true,
    orderId,
    status: order.status,
    amount: order.amount,
    version: order.version
  });
});

/**
 * GET /api/pay/return
 * 支付完成回跳：验签回跳参数，确认支付成功则本地直接标记订单为已支付（本地无
 * 公网 notify_url 时的兜底路径），随后带回前端首页并携带 orderId，由前端轮询解锁。
 */
router.get('/return', (req, res) => {
  const orderId = String(req.query.out_trade_no || req.query.orderId || '');
  const order = orders.get(orderId);
  const sdkInstance = getSdk();

  let verified = false;
  if (sdkInstance && req.query && req.query.sign) {
    try {
      verified = sdkInstance.checkNotifySign(req.query);
    } catch (err) {
      verified = false;
    }
  }
  console.log(
    `[pay/return] order=${orderId} verified=${verified} trade_status=${req.query.trade_status || ''} ` +
      `total_amount=${req.query.total_amount || ''} orderExists=${!!order} sign=${!!(req.query && req.query.sign)}`
  );

  if (order) {
    if (verified) {
      const paid = Number(req.query.total_amount || 0);
      /* 同步回跳（return）不强制依赖 trade_status：能通过支付宝验签走到这里，
         说明收银台支付流程已完成，验签通过 + 金额一致即可标记已支付；
         异步通知（notify）仍严格校验 trade_status，见下方 /notify。 */
      if (Math.abs(paid - Number(order.amount)) <= 0.001 && order.status !== 'PAID') {
        order.status = 'PAID';
        order.tradeNo = String(req.query.trade_no || '');
        order.paidTime = new Date().toISOString();
      }
    }
    // 记录回跳是否验签通过，便于前端/日志排查
    order.returnVerified = verified;
  }

  res.redirect('/?orderId=' + encodeURIComponent(orderId));
});

module.exports = router;

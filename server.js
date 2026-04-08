const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION = '2026-04',
  SHOPIFY_WEBHOOK_SECRET,
  REDEEM_ADMIN_KEY,
} = process.env;

app.use('/webhooks/orders-paid', express.raw({ type: '*/*' }));
app.use('/webhooks/refunds-create', express.raw({ type: '*/*' }));
app.use(express.json());

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

const REWARD_TIERS = {
  '100': { points: 100, credit: '5.00', label: '$5 off' },
  '250': { points: 250, credit: '15.00', label: '$15 off' },
  '500': { points: 500, credit: '30.00', label: '$30 off' },
  '1000': { points: 1000, credit: '75.00', label: '$75 off' },
};

function floorToInt(value) {
  return Math.floor(Number(value) || 0);
}

function clampMinZero(value) {
  return Math.max(0, floorToInt(value));
}

function getTierName(pointsBalance) {
  if (pointsBalance >= 1500) return 'Kandi King / Queen';
  if (pointsBalance >= 750) return 'PLUR Creator';
  if (pointsBalance >= 250) return 'Bead Collector';
  return 'Rookie Raver';
}

function getEarnRate(pointsBalance) {
  if (pointsBalance >= 1500) return 2.0;
  if (pointsBalance >= 750) return 1.5;
  if (pointsBalance >= 250) return 1.25;
  return 1.0;
}

function verifyShopifyWebhook(req) {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  if (!hmacHeader || !SHOPIFY_WEBHOOK_SECRET) return false;

  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest('base64');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest),
      Buffer.from(hmacHeader)
    );
  } catch {
    return false;
  }
}

async function getAdminAccessToken() {
  const now = Date.now();

  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60000) {
    return tokenCache.accessToken;
  }

  const response = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Token request failed: ${response.status} ${JSON.stringify(data)}`);
  }

  tokenCache.accessToken = data.access_token;
  tokenCache.expiresAt = now + ((data.expires_in || 86400) * 1000);

  return tokenCache.accessToken;
}

async function adminGraphQL(query, variables = {}) {
  const token = await getAdminAccessToken();

  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`GraphQL HTTP error ${response.status}: ${JSON.stringify(data)}`);
  }

  if (data.errors) {
    throw new Error(`GraphQL top-level errors: ${JSON.stringify(data.errors)}`);
  }

  return data;
}

async function getCustomerPoints(customerGid) {
  const query = `
    query GetCustomerPoints($id: ID!) {
      customer(id: $id) {
        id
        displayName
        plurPointsBalance: metafield(namespace: "custom", key: "plur_points_balance") {
          value
        }
        plurPointsEarned: metafield(namespace: "custom", key: "plur_points_earned") {
          value
        }
        plurPointsRedeemed: metafield(namespace: "custom", key: "plur_points_redeemed") {
          value
        }
        plurTier: metafield(namespace: "custom", key: "plur_tier") {
          value
        }
      }
    }
  `;

  const result = await adminGraphQL(query, { id: customerGid });
  const customer = result.data.customer;

  if (!customer) {
    throw new Error(`Customer not found: ${customerGid}`);
  }

  return {
    id: customer.id,
    name: customer.displayName,
    balance: floorToInt(customer.plurPointsBalance?.value),
    earned: floorToInt(customer.plurPointsEarned?.value),
    redeemed: floorToInt(customer.plurPointsRedeemed?.value),
    tier: customer.plurTier?.value || 'Rookie Raver',
  };
}

async function setCustomerPoints(customerGid, balance, earned, redeemed, tier) {
  const mutation = `
    mutation SetCustomerMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          namespace
          key
          value
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId: customerGid,
        namespace: 'custom',
        key: 'plur_points_balance',
        type: 'number_integer',
        value: String(balance),
      },
      {
        ownerId: customerGid,
        namespace: 'custom',
        key: 'plur_points_earned',
        type: 'number_integer',
        value: String(earned),
      },
      {
        ownerId: customerGid,
        namespace: 'custom',
        key: 'plur_points_redeemed',
        type: 'number_integer',
        value: String(redeemed),
      },
      {
        ownerId: customerGid,
        namespace: 'custom',
        key: 'plur_tier',
        type: 'single_line_text_field',
        value: tier,
      },
    ],
  };

  const result = await adminGraphQL(mutation, variables);
  const userErrors = result.data.metafieldsSet.userErrors || [];

  if (userErrors.length) {
    throw new Error(`metafieldsSet userErrors: ${JSON.stringify(userErrors)}`);
  }

  return result.data.metafieldsSet.metafields;
}

async function creditStoreCreditToCustomer(customerGid, amount, currencyCode = 'USD') {
  const mutation = `
    mutation CreditStoreCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
      storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
        storeCreditAccountTransaction {
          amount {
            amount
            currencyCode
          }
          account {
            id
            balance {
              amount
              currencyCode
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    id: customerGid,
    creditInput: {
      creditAmount: {
        amount: String(amount),
        currencyCode,
      },
    },
  };

  const result = await adminGraphQL(mutation, variables);
  const userErrors = result.data.storeCreditAccountCredit.userErrors || [];

  if (userErrors.length) {
    throw new Error(`storeCreditAccountCredit userErrors: ${JSON.stringify(userErrors)}`);
  }

  return result.data.storeCreditAccountCredit.storeCreditAccountTransaction;
}

function getRefundAmount(refund) {
  if (refund.totalRefundedSet?.shopMoney?.amount != null) {
    return Number(refund.totalRefundedSet.shopMoney.amount || 0);
  }

  let total = 0;

  if (Array.isArray(refund.transactions)) {
    for (const tx of refund.transactions) {
      const amount = Number(tx.amount || 0);
      if (amount > 0) total += amount;
    }
  }

  if (total > 0) return total;

  if (Array.isArray(refund.refund_line_items)) {
    for (const item of refund.refund_line_items) {
      const subtotal = Number(item.subtotal || 0);
      const tax = Number(item.total_tax || 0);
      total += subtotal + tax;
    }
  }

  return total;
}

app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

app.get('/', (req, res) => {
  res.status(200).send('KandiByKelton PLUR app is live');
});

app.get('/token-test', async (req, res) => {
  try {
    const result = await adminGraphQL(`
      query {
        shop {
          name
        }
      }
    `);

    res.json(result);
  } catch (error) {
    console.error('token-test error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/redeem-test', async (req, res) => {
  try {
    const { key, customerId, reward } = req.query;

    if (!REDEEM_ADMIN_KEY || key !== REDEEM_ADMIN_KEY) {
      return res.status(401).json({ error: 'Invalid redeem key' });
    }

    if (!customerId) {
      return res.status(400).json({ error: 'Missing customerId' });
    }

    const tier = REWARD_TIERS[String(reward)];
    if (!tier) {
      return res.status(400).json({
        error: 'Invalid reward',
        validRewards: Object.keys(REWARD_TIERS),
      });
    }

    const current = await getCustomerPoints(customerId);

    if (current.balance < tier.points) {
      return res.status(400).json({
        error: 'Not enough PLUR Points',
        currentBalance: current.balance,
        requiredPoints: tier.points,
      });
    }

    const newBalance = current.balance - tier.points;
    const newEarned = current.earned;
    const newRedeemed = current.redeemed + tier.points;
    const newTier = getTierName(newBalance);

    const creditTx = await creditStoreCreditToCustomer(customerId, tier.credit, 'USD');
    await setCustomerPoints(customerId, newBalance, newEarned, newRedeemed, newTier);

    return res.status(200).json({
      ok: true,
      customerId,
      customerName: current.name,
      reward: tier,
      oldBalance: current.balance,
      newBalance,
      oldRedeemed: current.redeemed,
      newRedeemed,
      newTier,
      storeCreditTransaction: creditTx,
    });
  } catch (error) {
    console.error('redeem-test error:', error);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/webhooks/orders-paid', async (req, res) => {
  console.log('--- WEBHOOK HIT: /webhooks/orders-paid ---');
  console.log('Topic:', req.get('X-Shopify-Topic'));
  console.log('Shop:', req.get('X-Shopify-Shop-Domain'));

  try {
    const valid = verifyShopifyWebhook(req);
    console.log('HMAC valid:', valid);

    if (!valid) {
      console.log('Invalid webhook signature');
      return res.status(401).send('Invalid webhook signature');
    }

    const topic = req.get('X-Shopify-Topic');
    if (topic !== 'orders/paid') {
      console.log('Unexpected topic:', topic);
      return res.status(400).send(`Unexpected topic: ${topic}`);
    }

    const order = JSON.parse(req.body.toString('utf8'));
    console.log('Order ID:', order.id);
    console.log('Financial status:', order.financial_status);
    console.log('Customer exists:', !!order.customer);

    if (!order.customer || !order.customer.admin_graphql_api_id) {
      console.log('No customer attached to order');
      return res.status(200).send('No customer attached to order');
    }

    const customerGid = order.customer.admin_graphql_api_id;
    const current = await getCustomerPoints(customerGid);

    const orderTotal = Number(order.current_total_price || order.total_price || 0);
    const earnRate = getEarnRate(current.balance);
    const earnedThisOrder = floorToInt(orderTotal * earnRate);

    const newBalance = current.balance + earnedThisOrder;
    const newEarned = current.earned + earnedThisOrder;
    const newRedeemed = current.redeemed;
    const newTier = getTierName(newBalance);

    await setCustomerPoints(customerGid, newBalance, newEarned, newRedeemed, newTier);

    console.log('Points updated successfully');
    console.log({
      customerId: customerGid,
      orderTotal,
      earnRate,
      earnedThisOrder,
      oldBalance: current.balance,
      newBalance,
      newTier,
    });

    return res.status(200).json({
      ok: true,
      customerId: customerGid,
      orderId: order.admin_graphql_api_id || order.id,
      orderTotal,
      earnRate,
      earnedThisOrder,
      oldBalance: current.balance,
      newBalance,
      newTier,
    });
  } catch (error) {
    console.error('orders/paid webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/webhooks/refunds-create', async (req, res) => {
  console.log('--- WEBHOOK HIT: /webhooks/refunds-create ---');
  console.log('Topic:', req.get('X-Shopify-Topic'));
  console.log('Shop:', req.get('X-Shopify-Shop-Domain'));

  try {
    const valid = verifyShopifyWebhook(req);
    console.log('HMAC valid:', valid);

    if (!valid) {
      console.log('Invalid webhook signature');
      return res.status(401).send('Invalid webhook signature');
    }

    const topic = req.get('X-Shopify-Topic');
    if (topic !== 'refunds/create') {
      console.log('Unexpected topic:', topic);
      return res.status(400).send(`Unexpected topic: ${topic}`);
    }

    const refund = JSON.parse(req.body.toString('utf8'));
    console.log('Refund ID:', refund.id);
    console.log('Order ID:', refund.order_id);

    let customerGid = refund.order?.customer?.admin_graphql_api_id || null;

    if (!customerGid && refund.order_id) {
      const orderLookup = await adminGraphQL(
        `
        query GetOrderCustomer($id: ID!) {
          order(id: $id) {
            id
            customer {
              id
            }
          }
        }
        `,
        { id: `gid://shopify/Order/${refund.order_id}` }
      );

      customerGid = orderLookup.data.order?.customer?.id || null;
    }

    if (!customerGid) {
      console.log('No customer attached to refunded order');
      return res.status(200).send('No customer attached to refunded order');
    }

    const current = await getCustomerPoints(customerGid);

    const refundAmount = Number(getRefundAmount(refund) || 0);
    const deductRate = getEarnRate(current.balance);
    const pointsToDeduct = floorToInt(refundAmount * deductRate);

    const newBalance = clampMinZero(current.balance - pointsToDeduct);
    const newEarned = current.earned;
    const newRedeemed = current.redeemed;
    const newTier = getTierName(newBalance);

    await setCustomerPoints(customerGid, newBalance, newEarned, newRedeemed, newTier);

    console.log('Refund points deducted successfully');
    console.log({
      customerId: customerGid,
      refundAmount,
      deductRate,
      pointsToDeduct,
      oldBalance: current.balance,
      newBalance,
      newTier,
    });

    return res.status(200).json({
      ok: true,
      customerId: customerGid,
      refundId: refund.admin_graphql_api_id || refund.id,
      refundAmount,
      deductRate,
      pointsToDeduct,
      oldBalance: current.balance,
      newBalance,
      newTier,
    });
  } catch (error) {
    console.error('refunds/create webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
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
} = process.env;

/*
  Shopify webhook route needs raw body for HMAC verification.
  All other routes can use JSON parsing normally.
*/
app.use('/webhooks/orders-paid', express.raw({ type: '*/*' }));
app.use(express.json());

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

function floorToInt(value) {
  return Math.floor(Number(value) || 0);
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

  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60_000) {
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
        metafields(identifiers: [
          { namespace: "custom", key: "plur_points_balance" },
          { namespace: "custom", key: "plur_points_earned" },
          { namespace: "custom", key: "plur_points_redeemed" },
          { namespace: "custom", key: "plur_tier" }
        ]) {
          namespace
          key
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

  const metafieldMap = {};
  for (const mf of customer.metafields || []) {
    if (!mf) continue;
    metafieldMap[`${mf.namespace}.${mf.key}`] = mf.value;
  }

  return {
    balance: floorToInt(metafieldMap['custom.plur_points_balance']),
    earned: floorToInt(metafieldMap['custom.plur_points_earned']),
    redeemed: floorToInt(metafieldMap['custom.plur_points_redeemed']),
    tier: metafieldMap['custom.plur_tier'] || 'Rookie Raver',
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
    res.status(500).json({ error: error.message });
  }
});

app.post('/webhooks/orders-paid', async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      return res.status(401).send('Invalid webhook signature');
    }

    const topic = req.get('X-Shopify-Topic');
    if (topic !== 'orders/paid') {
      return res.status(400).send(`Unexpected topic: ${topic}`);
    }

    const order = JSON.parse(req.body.toString('utf8'));

    if (!order.customer || !order.customer.admin_graphql_api_id) {
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

    await setCustomerPoints(
      customerGid,
      newBalance,
      newEarned,
      newRedeemed,
      newTier
    );

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
const express = require('express');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION = '2026-04',
} = process.env;

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

async function getAdminAccessToken() {
  const now = Date.now();

  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  const response = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
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

app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

app.get('/', (req, res) => {
  res.status(200).send('KandiByKelton PLUR app is live');
});

app.get('/token-test', async (req, res) => {
  try {
    const token = await getAdminAccessToken();

    const response = await fetch(
      `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({
          query: `{
            shop {
              name
            }
          }`,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

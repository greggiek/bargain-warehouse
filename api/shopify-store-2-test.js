module.exports = async function (req, res) {
  const shop = (process.env.SHOPIFY_STORE_2_DOMAIN || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');

  const clientId = process.env.SHOPIFY_STORE_2_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_STORE_2_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    return res.status(500).json({
      ok: false,
      error:
        'Missing SHOPIFY_STORE_2_DOMAIN, SHOPIFY_STORE_2_CLIENT_ID, or SHOPIFY_STORE_2_CLIENT_SECRET'
    });
  }

  try {
    const tokenResponse = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret
        })
      }
    );

    const tokenText = await tokenResponse.text();

    let tokenData;
    try {
      tokenData = JSON.parse(tokenText);
    } catch {
      tokenData = null;
    }

    if (!tokenResponse.ok || !tokenData?.access_token) {
      return res.status(tokenResponse.status || 502).json({
        ok: false,
        step: 'token',
        status: tokenResponse.status,
        error:
          tokenData?.error_description ||
          tokenData?.error ||
          'Shopify token request failed'
      });
    }

    const query = `
      query BMShopifyConnectionTest {
        shop {
          name
          myshopifyDomain
        }
        locations(first: 50) {
          nodes {
            id
            name
            isActive
          }
        }
      }
    `;

    const apiResponse = await fetch(
      `https://${shop}/admin/api/2026-07/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Shopify-Access-Token': tokenData.access_token
        },
        body: JSON.stringify({ query })
      }
    );

    const apiText = await apiResponse.text();

    let apiData;
    try {
      apiData = JSON.parse(apiText);
    } catch {
      apiData = null;
    }

    if (!apiResponse.ok || !apiData) {
      return res.status(apiResponse.status || 502).json({
        ok: false,
        step: 'graphql',
        status: apiResponse.status,
        error: 'Shopify GraphQL request failed'
      });
    }

    if (apiData.errors?.length) {
      return res.status(502).json({
        ok: false,
        step: 'graphql',
        errors: apiData.errors
      });
    }

    return res.status(200).json({
      ok: true,
      shop: apiData.data?.shop || null,
      locations: apiData.data?.locations?.nodes || []
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};

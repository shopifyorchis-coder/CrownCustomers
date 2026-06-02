require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { prisma } = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;
const DEFAULT_SHOP = process.env.SHOPIFY_SHOP_DOMAIN || 'demo-shop.myshopify.com';
const SHOPIFY_ADMIN_API_VERSION = '2024-10';
const REQUIRED_SHOPIFY_SCOPES = 'read_orders,read_customers';
const frontendDist = path.resolve(__dirname, '../../frontend/dist');

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());

function getCurrentShop(req) {
  return (
    req.get('x-shopify-shop-domain') ||
    req.query.shop ||
    req.body?.shop ||
    process.env.SHOPIFY_SHOP_DOMAIN ||
    DEFAULT_SHOP
  );
}

function getShopifyAccessToken() {
  return process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || '';
}

function buildCustomerName(customer, email) {
  const fullName = [customer?.firstName, customer?.lastName].filter(Boolean).join(' ').trim();
  if (fullName) return fullName;
  if (customer?.displayName) return customer.displayName;
  if (email) return email.split('@')[0];
  return 'Guest Customer';
}

function toCurrencyNumber(amount) {
  const parsed = Number(amount || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function daysSince(dateValue) {
  const now = Date.now();
  const then = new Date(dateValue).getTime();
  const diff = Math.max(0, now - then);
  return diff / (1000 * 60 * 60 * 24);
}

function scoreDescending(values, currentValue) {
  if (values.length <= 1) return 5;
  const sorted = [...values].sort((a, b) => b - a);
  const index = sorted.findIndex((value) => value === currentValue);
  const bucket = Math.floor((index / sorted.length) * 5);
  return Math.max(1, 5 - bucket);
}

function scoreAscending(values, currentValue) {
  if (values.length <= 1) return 5;
  const sorted = [...values].sort((a, b) => a - b);
  const index = sorted.findIndex((value) => value === currentValue);
  const bucket = Math.floor((index / sorted.length) * 5);
  return Math.max(1, 5 - bucket);
}

function buildSegment({ isTop, rfmScore, recencyScore, frequencyScore, monetaryScore }) {
  if (isTop) return 'Crown Customer';
  if (rfmScore >= 10 || (frequencyScore >= 4 && monetaryScore >= 4)) return 'Gold Customer';
  if (recencyScore <= 2 && (frequencyScore <= 2 || monetaryScore <= 2)) return 'At Risk';
  return 'Regular Customer';
}

function getMissingScopeMessage() {
  return 'Missing Shopify order/customer permissions. Please reinstall the app with updated scopes.';
}

async function getOrCreateSettings(shop) {
  return prisma.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop }
  });
}

async function fetchShopifyOrders(shop, accessToken) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 90);
  const createdSince = startDate.toISOString().slice(0, 10);
  const endpoint = `https://${shop}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`;
  const query = `
    query FetchOrders($after: String, $search: String!) {
      orders(first: 100, after: $after, sortKey: CREATED_AT, reverse: true, query: $search) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          cursor
          node {
            id
            createdAt
            email
            currentTotalPriceSet {
              shopMoney {
                amount
              }
            }
            customer {
              id
              displayName
              firstName
              lastName
              email
            }
          }
        }
      }
    }
  `;

  const orders = [];
  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken
      },
      body: JSON.stringify({
        query,
        variables: {
          after,
          search: `created_at:>=${createdSince}`
        }
      })
    });

    const payload = await response.json();

    if (!response.ok || payload.errors || payload.data?.orders == null) {
      const graphQlErrors = payload.errors || [];
      const errorMessage = graphQlErrors.map((entry) => entry.message).join('; ') || `Shopify API request failed: ${response.status}`;
      const missingScopes = errorMessage.toLowerCase().includes('access denied') || errorMessage.toLowerCase().includes('scope');
      const err = new Error(missingScopes ? getMissingScopeMessage() : errorMessage);
      err.statusCode = missingScopes ? 403 : 502;
      throw err;
    }

    const connection = payload.data.orders;
    for (const edge of connection.edges) {
      orders.push(edge.node);
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    after = connection.pageInfo.endCursor;
  }

  return orders;
}

function buildRankingsFromOrders(shop, orders) {
  const grouped = new Map();

  for (const order of orders) {
    const email = order.customer?.email || order.email;
    if (!email) continue;

    const customerId = order.customer?.id || email.toLowerCase();
    const key = customerId;
    const existing = grouped.get(key) || {
      shop,
      customerId,
      name: buildCustomerName(order.customer, email),
      email,
      totalSpent: 0,
      ordersCount: 0,
      lastOrderDate: order.createdAt
    };

    existing.totalSpent += toCurrencyNumber(order.currentTotalPriceSet?.shopMoney?.amount);
    existing.ordersCount += 1;
    if (new Date(order.createdAt) > new Date(existing.lastOrderDate)) {
      existing.lastOrderDate = order.createdAt;
    }
    if (!existing.name || existing.name === 'Guest Customer') {
      existing.name = buildCustomerName(order.customer, email);
    }

    grouped.set(key, existing);
  }

  const customers = Array.from(grouped.values());
  const recencyValues = customers.map((customer) => daysSince(customer.lastOrderDate));
  const frequencyValues = customers.map((customer) => customer.ordersCount);
  const monetaryValues = customers.map((customer) => customer.totalSpent);

  const enriched = customers.map((customer) => {
    const recencyDays = daysSince(customer.lastOrderDate);
    const recencyScore = scoreAscending(recencyValues, recencyDays);
    const frequencyScore = scoreDescending(frequencyValues, customer.ordersCount);
    const monetaryScore = scoreDescending(monetaryValues, customer.totalSpent);
    const rfmScore = recencyScore + frequencyScore + monetaryScore;

    return {
      ...customer,
      totalSpent: Number(customer.totalSpent.toFixed(2)),
      recencyDays,
      recencyScore,
      frequencyScore,
      monetaryScore,
      rfmScore
    };
  });

  const ranked = enriched.sort((a, b) => {
    if (b.rfmScore !== a.rfmScore) return b.rfmScore - a.rfmScore;
    if (b.totalSpent !== a.totalSpent) return b.totalSpent - a.totalSpent;
    return new Date(b.lastOrderDate) - new Date(a.lastOrderDate);
  });

  const topCount = ranked.length ? Math.max(1, Math.ceil(ranked.length * 0.2)) : 0;

  return ranked.map((customer, index) => {
    const isTop = index < topCount;
    return {
      shop: customer.shop,
      customerId: customer.customerId,
      name: customer.name,
      email: customer.email,
      totalSpent: customer.totalSpent,
      ordersCount: customer.ordersCount,
      lastOrderDate: new Date(customer.lastOrderDate),
      rfmScore: customer.rfmScore,
      segment: buildSegment({
        isTop,
        rfmScore: customer.rfmScore,
        recencyScore: customer.recencyScore,
        frequencyScore: customer.frequencyScore,
        monetaryScore: customer.monetaryScore
      }),
      isTop
    };
  });
}

async function persistRankings(shop, rankedCustomers, ordersImported) {
  const customerIds = rankedCustomers.map((customer) => customer.customerId);

  await prisma.$transaction(async (tx) => {
    await tx.customerScore.deleteMany({
      where: {
        shop,
        ...(customerIds.length ? { customerId: { notIn: customerIds } } : {})
      }
    });

    for (const customer of rankedCustomers) {
      await tx.customerScore.upsert({
        where: {
          shop_customerId: {
            shop,
            customerId: customer.customerId
          }
        },
        update: {
          name: customer.name,
          email: customer.email,
          totalSpent: customer.totalSpent,
          ordersCount: customer.ordersCount,
          lastOrderDate: customer.lastOrderDate,
          rfmScore: customer.rfmScore,
          segment: customer.segment,
          isTop: customer.isTop
        },
        create: customer
      });
    }

    await tx.syncState.upsert({
      where: { shop },
      update: {
        lastSyncAt: new Date(),
        customersImported: rankedCustomers.length,
        ordersImported
      },
      create: {
        shop,
        lastSyncAt: new Date(),
        customersImported: rankedCustomers.length,
        ordersImported
      }
    });

    await tx.activityLog.create({
      data: {
        status: 'shopify_sync',
        customer: shop,
        message: `Imported ${ordersImported} orders across ${rankedCustomers.length} customers.`
      }
    });
  });
}

async function getDashboardSummary(shop) {
  const [totalCustomers, crownCustomers, recentActivityCount, syncState] = await Promise.all([
    prisma.customerScore.count({ where: { shop } }),
    prisma.customerScore.count({ where: { shop, isTop: true } }),
    prisma.activityLog.count({
      where: {
        customer: shop
      }
    }),
    prisma.syncState.findUnique({ where: { shop } })
  ]);

  return {
    totalCustomers,
    crownCustomers,
    recentActivityCount,
    lastSyncAt: syncState?.lastSyncAt || null,
    customersImported: syncState?.customersImported || 0,
    ordersImported: syncState?.ordersImported || 0
  };
}

async function getRankedCustomers(shop) {
  return prisma.customerScore.findMany({
    where: { shop },
    orderBy: [
      { rfmScore: 'desc' },
      { totalSpent: 'desc' },
      { lastOrderDate: 'desc' }
    ]
  });
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'CrownCustomers' });
});

app.get('/api/dashboard/summary', async (req, res) => {
  const shop = getCurrentShop(req);
  res.json(await getDashboardSummary(shop));
});

app.get('/api/customers/ranking', async (req, res) => {
  const shop = getCurrentShop(req);
  res.json(await getRankedCustomers(shop));
});

app.get('/api/dashboard', async (req, res) => {
  const shop = getCurrentShop(req);
  const [settings, summary, customers, activities] = await Promise.all([
    getOrCreateSettings(shop),
    getDashboardSummary(shop),
    getRankedCustomers(shop),
    prisma.activityLog.findMany({
      where: { customer: shop },
      orderBy: { createdAt: 'desc' },
      take: 5
    })
  ]);

  res.json({
    settings,
    stats: {
      totalCustomers: summary.totalCustomers,
      topCustomers: summary.crownCustomers,
      emailsSent: summary.recentActivityCount,
      lastSyncAt: summary.lastSyncAt,
      customersImported: summary.customersImported,
      ordersImported: summary.ordersImported
    },
    customers,
    activities
  });
});

app.post('/api/sync/shopify-orders', async (req, res) => {
  const shop = getCurrentShop(req);
  const accessToken = getShopifyAccessToken();

  if (!accessToken) {
    return res.status(400).json({
      ok: false,
      error: 'Missing Shopify admin access token. Set SHOPIFY_ADMIN_ACCESS_TOKEN in backend environment variables.',
      requiredScopes: REQUIRED_SHOPIFY_SCOPES
    });
  }

  try {
    const orders = await fetchShopifyOrders(shop, accessToken);
    const rankedCustomers = buildRankingsFromOrders(shop, orders);

    await persistRankings(shop, rankedCustomers, orders.length);

    res.json({
      ok: true,
      shop,
      customersImported: rankedCustomers.length,
      ordersImported: orders.length
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      ok: false,
      error: error.message || 'Shopify sync failed.',
      requiredScopes: REQUIRED_SHOPIFY_SCOPES
    });
  }
});

app.get('/api/settings', async (req, res) => {
  const shop = getCurrentShop(req);
  res.json(await getOrCreateSettings(shop));
});

app.post('/api/settings', async (req, res) => {
  const shop = getCurrentShop(req);
  const body = req.body || {};
  const updated = await prisma.shopSettings.upsert({
    where: { shop },
    update: {
      enabled: Boolean(body.enabled),
      discountValue: Number(body.discountValue || 15),
      discountType: body.discountType || 'percentage',
      couponDays: Number(body.couponDays || 30),
      emailSubject: body.emailSubject || 'You are one of our Crown Customers!',
      introText: body.introText || 'As a thank you for your loyalty, here is a personal reward.',
      cooldownDays: Number(body.cooldownDays || 30)
    },
    create: {
      shop,
      enabled: Boolean(body.enabled),
      discountValue: Number(body.discountValue || 15),
      discountType: body.discountType || 'percentage',
      couponDays: Number(body.couponDays || 30),
      emailSubject: body.emailSubject || 'You are one of our Crown Customers!',
      introText: body.introText || 'As a thank you for your loyalty, here is a personal reward.',
      cooldownDays: Number(body.cooldownDays || 30)
    }
  });
  await prisma.activityLog.create({
    data: {
      status: 'settings_saved',
      customer: shop,
      message: 'Settings saved.'
    }
  });
  res.json(updated);
});

app.get('/api/activity', async (req, res) => {
  const shop = getCurrentShop(req);
  const logs = await prisma.activityLog.findMany({
    where: { customer: shop },
    orderBy: { createdAt: 'desc' },
    take: 50
  });
  res.json(logs);
});

app.use(express.static(frontendDist));

app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`CrownCustomers backend running on http://localhost:${PORT}`);
});

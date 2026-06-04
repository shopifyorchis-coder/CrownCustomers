require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { prisma } = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;
const DEFAULT_SHOP = process.env.SHOPIFY_SHOP_DOMAIN || 'demo-shop.myshopify.com';
const SHOPIFY_ADMIN_API_VERSION = '2024-10';
const REQUIRED_SYNC_SCOPES = 'read_orders,read_customers';
const REQUIRED_DISCOUNT_SCOPES = 'write_discounts';
const REQUIRED_SHOPIFY_SCOPES = `${REQUIRED_SYNC_SCOPES},${REQUIRED_DISCOUNT_SCOPES}`;
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

function buildSimpleSegment({ isTop, score }) {
  if (isTop) return 'Crown Customer';
  if (score >= 10) return 'Gold Customer';
  if (score <= 5) return 'At Risk';
  return 'Regular Customer';
}

function getMissingScopeMessage() {
  return 'Missing Shopify order/customer permissions. Please reinstall the app with updated scopes.';
}

function getMissingDiscountScopeMessage() {
  return 'Missing write_discounts permission. Please reinstall the app.';
}

function getMissingSessionMessage() {
  return 'Missing Shopify session/token.';
}

function normalizeManualDate(dateValue) {
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }
  return parsed;
}

function toErrorArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [{ message: value }];
  if (typeof value === 'object') return [value];
  return [{ message: String(value) }];
}

function formatShopifyErrors(value) {
  return toErrorArray(value)
    .map((err) => {
      if (!err) return 'Unknown Shopify error';
      if (typeof err === 'string') return err;
      if (err.field && err.message) {
        const fieldPath = Array.isArray(err.field) ? err.field.join('.') : String(err.field);
        return `${fieldPath}: ${err.message}`;
      }
      if (err.message) return err.message;
      try {
        return JSON.stringify(err);
      } catch (error) {
        return String(err);
      }
    })
    .join('; ');
}

function sanitizeCouponName(name) {
  return (name || 'CUSTOMER')
    .split(' ')[0]
    .replace(/[^a-z0-9]/gi, '')
    .toUpperCase()
    .slice(0, 10) || 'CUSTOMER';
}

function buildRewardCouponCode(name) {
  const firstName = sanitizeCouponName(name);
  const randomSuffix = crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
  return `CROWN-${firstName}-${randomSuffix}`;
}

function getCouponEndDate(couponDays) {
  const now = new Date();
  const totalDays = Math.max(1, Number(couponDays || 30));
  return new Date(now.getTime() + totalDays * 24 * 60 * 60 * 1000);
}

function buildShopifyGraphQLError(message, fallbackMessage) {
  const normalized = String(message || '').toLowerCase();
  const error = new Error(message || 'Shopify API request failed.');

  if (
    normalized.includes('access denied') ||
    normalized.includes('scope') ||
    normalized.includes('write_discounts')
  ) {
    error.message = fallbackMessage || getMissingDiscountScopeMessage();
    error.statusCode = 403;
    return error;
  }

  if (
    normalized.includes('unauthorized') ||
    normalized.includes('invalid api key') ||
    normalized.includes('invalid access token') ||
    normalized.includes('oauth')
  ) {
    error.message = getMissingSessionMessage();
    error.statusCode = 401;
    return error;
  }

  error.statusCode = 502;
  return error;
}

function serializeErrorMessage(error, fallbackMessage) {
  return error?.message || fallbackMessage || 'Unknown Shopify coupon generation error.';
}

async function postShopifyGraphQL(shop, accessToken, query, variables, missingScopeMessage) {
  if (!accessToken) {
    const error = new Error(getMissingSessionMessage());
    error.statusCode = 401;
    throw error;
  }

  const endpoint = `https://${shop}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await response.json();
  const responseErrors = toErrorArray(response.errors);
  const jsonErrors = toErrorArray(json?.errors);
  const dataErrors = toErrorArray(json?.data?.errors);
  const combinedErrors = [...responseErrors, ...jsonErrors, ...dataErrors];

  console.log('Coupon Shopify response:', JSON.stringify(json, null, 2));
  console.log('[coupon_generation] Shopify GraphQL response', {
    shop,
    status: response.status,
    responseErrors,
    jsonErrors,
    dataErrors
  });

  if (!response.ok || combinedErrors.length) {
    const message =
      formatShopifyErrors(combinedErrors) ||
      `Shopify API request failed: ${response.status}`;
    throw buildShopifyGraphQLError(message, missingScopeMessage);
  }

  return {
    data: json.data,
    json,
    status: response.status
  };
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
      const graphQlErrors = toErrorArray(payload.errors);
      const errorMessage =
        formatShopifyErrors(graphQlErrors) ||
        `Shopify API request failed: ${response.status}`;
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

async function createShopifyDiscountCode({ shop, token, customer, settings }) {
  const startsAt = new Date();
  const endsAt = getCouponEndDate(settings.couponDays);
  const discountCode = buildRewardCouponCode(customer.name);
  const isPercentage = settings.discountType === 'percentage';
  const mutation = `
    mutation DiscountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const basicCodeDiscount = {
    title: `CrownCustomers reward for ${customer.name}`,
    code: discountCode,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    appliesOncePerCustomer: true,
    customerGets: {
      items: { all: true },
      value: isPercentage
        ? { percentage: Number(settings.discountValue || 0) / 100 }
        : {
            discountAmount: {
              amount: Number(settings.discountValue || 0),
              appliesOnEachItem: false
            }
          }
    }
  };

  console.log('[coupon_generation] Creating Shopify discount', {
    shop,
    hasToken: Boolean(token),
    customerName: customer.name,
    customerEmail: customer.email,
    customerId: customer.customerId,
    discountType: settings.discountType,
    discountValue: Number(settings.discountValue || 0),
    generatedCode: discountCode
  });

  const response = await postShopifyGraphQL(
    shop,
    token,
    mutation,
    { basicCodeDiscount },
    getMissingDiscountScopeMessage()
  );
  const dataErrors = toErrorArray(response.data?.errors);
  const result = response.data?.discountCodeBasicCreate;
  const userErrors = toErrorArray(result?.userErrors);
  const combinedErrors = [...dataErrors, ...userErrors];

  console.log('[coupon_generation] discountCodeBasicCreate result', {
    shop,
    customerName: customer.name,
    customerEmail: customer.email,
    responseStatus: response.status,
    dataErrors,
    userErrors
  });

  if (combinedErrors.length) {
    const message = formatShopifyErrors(combinedErrors) || 'Shopify did not return a discount code result.';
    throw buildShopifyGraphQLError(message, getMissingDiscountScopeMessage());
  }

  if (!result?.codeDiscountNode?.id) {
    const message = 'Shopify did not return a discount code result.';
    throw buildShopifyGraphQLError(message, getMissingDiscountScopeMessage());
  }

  return {
    discountCode,
    discountType: settings.discountType,
    discountValue: Number(settings.discountValue || 0),
    startsAt,
    endsAt,
    shopifyDiscountId: result.codeDiscountNode.id
  };
}

function isCooldownActive(existingCoupon, cooldownDays) {
  if (!existingCoupon || existingCoupon.status !== 'created') {
    return false;
  }

  const now = Date.now();
  const cooldownWindow = Math.max(0, Number(cooldownDays || 0)) * 24 * 60 * 60 * 1000;
  const createdAt = new Date(existingCoupon.createdAt).getTime();
  const endsAt = new Date(existingCoupon.endsAt).getTime();

  return endsAt > now || createdAt + cooldownWindow > now;
}

async function logCouponActivity(status, customer, message) {
  await prisma.activityLog.create({
    data: {
      status,
      customer,
      message
    }
  });
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

function buildSimpleRankings(shop, customers) {
  const normalizedCustomers = customers.map((customer, index) => ({
    shop,
    customerId: customer.customerId || `manual:${customer.email.toLowerCase() || index}`,
    name: customer.name?.trim() || 'Guest Customer',
    email: customer.email?.trim().toLowerCase() || `customer-${index + 1}@example.com`,
    totalSpent: Number(toCurrencyNumber(customer.totalSpent).toFixed(2)),
    ordersCount: Math.max(0, Number(customer.ordersCount || 0)),
    lastOrderDate: normalizeManualDate(customer.lastOrderDate)
  }));

  const recencyValues = normalizedCustomers.map((customer) => daysSince(customer.lastOrderDate));
  const frequencyValues = normalizedCustomers.map((customer) => customer.ordersCount);
  const monetaryValues = normalizedCustomers.map((customer) => customer.totalSpent);

  const enriched = normalizedCustomers.map((customer) => {
    const recencyScore = scoreAscending(recencyValues, daysSince(customer.lastOrderDate));
    const frequencyScore = scoreDescending(frequencyValues, customer.ordersCount);
    const monetaryScore = scoreDescending(monetaryValues, customer.totalSpent);
    const simpleScore = recencyScore + frequencyScore + monetaryScore;

    return {
      ...customer,
      recencyScore,
      frequencyScore,
      monetaryScore,
      rfmScore: simpleScore
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
      shop,
      customerId: customer.customerId,
      name: customer.name,
      email: customer.email,
      totalSpent: customer.totalSpent,
      ordersCount: customer.ordersCount,
      lastOrderDate: customer.lastOrderDate,
      rfmScore: customer.rfmScore,
      segment: buildSimpleSegment({
        isTop,
        score: customer.rfmScore
      }),
      isTop
    };
  });
}

async function upsertRankedCustomers(shop, rankedCustomers) {
  for (const customer of rankedCustomers) {
    await prisma.customerScore.upsert({
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
}

async function recomputeManualScores(shop) {
  const existingCustomers = await prisma.customerScore.findMany({
    where: { shop },
    orderBy: { updatedAt: 'desc' }
  });
  const rankedCustomers = buildSimpleRankings(shop, existingCustomers);
  await upsertRankedCustomers(shop, rankedCustomers);
  return rankedCustomers;
}

async function seedPreviewCustomers(shop) {
  const existingCustomers = await prisma.customerScore.findMany({ where: { shop } });
  if (existingCustomers.length) {
    return recomputeManualScores(shop);
  }

  const previewCustomers = [
    {
      customerId: 'preview:sarah-chen',
      name: 'Sarah Chen',
      email: 'sarah.chen@example.com',
      totalSpent: 1240,
      ordersCount: 8,
      lastOrderDate: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000)
    },
    {
      customerId: 'preview:michael-ross',
      name: 'Michael Ross',
      email: 'michael.ross@example.com',
      totalSpent: 890,
      ordersCount: 6,
      lastOrderDate: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000)
    },
    {
      customerId: 'preview:amelia-jones',
      name: 'Amelia Jones',
      email: 'amelia.jones@example.com',
      totalSpent: 560,
      ordersCount: 4,
      lastOrderDate: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    },
    {
      customerId: 'preview:noah-patel',
      name: 'Noah Patel',
      email: 'noah.patel@example.com',
      totalSpent: 230,
      ordersCount: 2,
      lastOrderDate: new Date(Date.now() - 28 * 24 * 60 * 60 * 1000)
    }
  ];

  const rankedCustomers = buildSimpleRankings(shop, previewCustomers);

  await prisma.$transaction(async (tx) => {
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
        customersImported: rankedCustomers.length
      },
      create: {
        shop,
        lastSyncAt: new Date(),
        customersImported: rankedCustomers.length,
        ordersImported: 0
      }
    });

    await tx.activityLog.create({
      data: {
        status: 'preview_sync',
        customer: shop,
        message: `Loaded ${rankedCustomers.length} preview customers for UI testing.`
      }
    });
  });

  return rankedCustomers;
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
  const customers = await prisma.customerScore.findMany({
    where: { shop },
    orderBy: [
      { rfmScore: 'desc' },
      { totalSpent: 'desc' },
      { lastOrderDate: 'desc' }
    ]
  });

  const createdCoupons = await prisma.rewardCoupon.findMany({
    where: { shop, status: 'created' },
    orderBy: { createdAt: 'desc' }
  });
  const latestCouponByCustomerId = new Map();

  for (const coupon of createdCoupons) {
    if (!latestCouponByCustomerId.has(coupon.customerId)) {
      latestCouponByCustomerId.set(coupon.customerId, coupon);
    }
  }

  return customers.map((customer) => ({
    ...customer,
    latestCoupon: latestCouponByCustomerId.get(customer.customerId)
      ? {
          discountCode: latestCouponByCustomerId.get(customer.customerId).discountCode,
          status: latestCouponByCustomerId.get(customer.customerId).status,
          endsAt: latestCouponByCustomerId.get(customer.customerId).endsAt
        }
      : null
  }));
}

async function getRecentCoupons(shop) {
  return prisma.rewardCoupon.findMany({
    where: { shop },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      customerName: true,
      customerEmail: true,
      discountCode: true,
      discountValue: true,
      discountType: true,
      startsAt: true,
      endsAt: true,
      status: true,
      errorMessage: true
    }
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

app.post('/api/customers/manual', async (req, res) => {
  const shop = getCurrentShop(req);
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const totalSpent = Number(body.totalSpent || 0);
  const ordersCount = Number(body.ordersCount || 0);
  const lastOrderDate = normalizeManualDate(body.lastOrderDate);

  if (!name || !email) {
    return res.status(400).json({
      ok: false,
      error: 'Name and email are required.'
    });
  }

  if (!Number.isFinite(totalSpent) || !Number.isFinite(ordersCount)) {
    return res.status(400).json({
      ok: false,
      error: 'Total spent and orders count must be valid numbers.'
    });
  }

  const customerId = `manual:${email}`;

  await prisma.customerScore.upsert({
    where: {
      shop_customerId: {
        shop,
        customerId
      }
    },
    update: {
      name,
      email,
      totalSpent: Number(totalSpent.toFixed(2)),
      ordersCount: Math.max(0, Math.round(ordersCount)),
      lastOrderDate
    },
    create: {
      shop,
      customerId,
      name,
      email,
      totalSpent: Number(totalSpent.toFixed(2)),
      ordersCount: Math.max(0, Math.round(ordersCount)),
      lastOrderDate
    }
  });

  const rankedCustomers = await recomputeManualScores(shop);

  await prisma.syncState.upsert({
    where: { shop },
    update: {
      lastSyncAt: new Date(),
      customersImported: rankedCustomers.length
    },
    create: {
      shop,
      lastSyncAt: new Date(),
      customersImported: rankedCustomers.length,
      ordersImported: 0
    }
  });

  await prisma.activityLog.create({
    data: {
      status: 'manual_customer_added',
      customer: shop,
      message: `Added manual customer ${name}.`
    }
  });

  res.json({
    ok: true,
    message: 'Manual customer added.',
    customerId
  });
});

app.post('/api/rewards/generate', async (req, res) => {
  const shop = getCurrentShop(req);
  const token = getShopifyAccessToken();

  console.log('[coupon_generation] Starting reward generation', {
    shop,
    hasToken: Boolean(token)
  });

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: getMissingSessionMessage(),
      requiredScopes: REQUIRED_DISCOUNT_SCOPES
    });
  }

  const settings = await getOrCreateSettings(shop);
  const crownCustomers = await prisma.customerScore.findMany({
    where: {
      shop,
      OR: [{ isTop: true }, { segment: 'Crown Customer' }]
    },
    orderBy: [{ rfmScore: 'desc' }, { totalSpent: 'desc' }]
  });

  const activeCoupons = await prisma.rewardCoupon.findMany({
    where: {
      shop,
      status: 'created',
      customerId: { in: crownCustomers.map((customer) => customer.customerId) }
    },
    orderBy: { createdAt: 'desc' }
  });
  const latestActiveCouponByCustomerId = new Map();

  for (const coupon of activeCoupons) {
    if (!latestActiveCouponByCustomerId.has(coupon.customerId)) {
      latestActiveCouponByCustomerId.set(coupon.customerId, coupon);
    }
  }

  let created = 0;
  let skipped = 0;
  let failed = 0;
  const coupons = [];

  for (const customer of crownCustomers) {
    const customerLabel = customer.name || customer.email || customer.customerId;
    const couponStartsAt = new Date();
    const couponEndsAt = getCouponEndDate(settings.couponDays);
    const existingCoupon = latestActiveCouponByCustomerId.get(customer.customerId);

    console.log('[coupon_generation] Processing customer', {
      shop,
      hasToken: Boolean(token),
      customerName: customer.name,
      customerEmail: customer.email,
      customerId: customer.customerId,
      discountType: settings.discountType,
      discountValue: Number(settings.discountValue || 0)
    });

    if (!customer.email?.trim()) {
      skipped += 1;
      const reason = 'Customer email is missing.';
      const rewardCoupon = await prisma.rewardCoupon.create({
        data: {
          shop,
          customerScoreId: customer.id,
          customerId: customer.customerId,
          customerEmail: customer.email || '',
          customerName: customer.name,
          discountCode: null,
          discountType: settings.discountType,
          discountValue: Number(settings.discountValue || 0),
          startsAt: couponStartsAt,
          endsAt: couponEndsAt,
          status: 'skipped',
          errorMessage: reason
        }
      });
      await logCouponActivity(
        'coupon_skipped',
        customerLabel,
        `Skipped coupon generation for ${customerLabel}. Reason: ${reason}`
      );
      coupons.push(rewardCoupon);
      continue;
    }

    if (isCooldownActive(existingCoupon, settings.cooldownDays)) {
      skipped += 1;
      const reason = 'Active coupon already exists and cooldown has not expired.';
      const rewardCoupon = await prisma.rewardCoupon.create({
        data: {
          shop,
          customerScoreId: customer.id,
          customerId: customer.customerId,
          customerEmail: customer.email,
          customerName: customer.name,
          discountCode: existingCoupon.discountCode,
          discountType: settings.discountType,
          discountValue: Number(settings.discountValue || 0),
          startsAt: existingCoupon.startsAt,
          endsAt: existingCoupon.endsAt,
          shopifyDiscountId: existingCoupon.shopifyDiscountId,
          status: 'skipped',
          errorMessage: reason
        }
      });
      await logCouponActivity(
        'coupon_skipped',
        customerLabel,
        `Skipped coupon generation for ${customerLabel}. Reason: ${reason} Existing code: ${existingCoupon.discountCode || 'unknown'}.`
      );
      coupons.push(rewardCoupon);
      continue;
    }

    try {
      const createdCoupon = await createShopifyDiscountCode({
        shop,
        token,
        customer,
        settings
      });
      created += 1;
      const rewardCoupon = await prisma.rewardCoupon.create({
        data: {
          shop,
          customerScoreId: customer.id,
          customerId: customer.customerId,
          customerEmail: customer.email,
          customerName: customer.name,
          discountCode: createdCoupon.discountCode,
          discountType: createdCoupon.discountType,
          discountValue: createdCoupon.discountValue,
          startsAt: createdCoupon.startsAt,
          endsAt: createdCoupon.endsAt,
          shopifyDiscountId: createdCoupon.shopifyDiscountId,
          status: 'created'
        }
      });
      await logCouponActivity(
        'coupon_created',
        customerLabel,
        `Coupon ${createdCoupon.discountCode} created for ${customerLabel}.`
      );
      coupons.push(rewardCoupon);
    } catch (error) {
      failed += 1;
      const reason = serializeErrorMessage(error, 'Shopify coupon creation failed.');
      console.error('[coupon_generation] Coupon creation failed', {
        shop,
        hasToken: Boolean(token),
        customerName: customer.name,
        customerEmail: customer.email,
        customerId: customer.customerId,
        discountType: settings.discountType,
        discountValue: Number(settings.discountValue || 0),
        error: reason
      });
      const rewardCoupon = await prisma.rewardCoupon.create({
        data: {
          shop,
          customerScoreId: customer.id,
          customerId: customer.customerId,
          customerEmail: customer.email,
          customerName: customer.name,
          discountCode: null,
          discountType: settings.discountType,
          discountValue: Number(settings.discountValue || 0),
          startsAt: couponStartsAt,
          endsAt: couponEndsAt,
          status: 'failed',
          errorMessage: reason
        }
      });
      await logCouponActivity(
        'coupon_failed',
        customerLabel,
        `Coupon generation failed for ${customerLabel}. Reason: ${reason}`
      );
      coupons.push(rewardCoupon);

      if (error.statusCode === 401 || error.statusCode === 403) {
        return res.status(error.statusCode).json({
          ok: false,
          error: error.message,
          created,
          skipped,
          failed,
          coupons
        });
      }
    }
  }

  res.json({
    ok: true,
    created,
    skipped,
    failed,
    coupons
  });
});

app.get('/api/rewards/coupons', async (req, res) => {
  const shop = getCurrentShop(req);
  res.json(await getRecentCoupons(shop));
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
    const previewCustomers = await seedPreviewCustomers(shop);
    return res.json({
      ok: true,
      shop,
      mode: 'preview',
      customersImported: previewCustomers.length,
      ordersImported: 0,
      message: 'Preview customers loaded for UI testing.'
    });
  }

  try {
    const orders = await fetchShopifyOrders(shop, accessToken);
    if (!orders.length) {
      return res.json({
        ok: true,
        shop,
        customersImported: 0,
        ordersImported: 0,
        message: 'No customers found yet. Add customers manually or connect Shopify sync later.'
      });
    }
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
